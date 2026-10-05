#!/usr/bin/env python3
"""
validate_skill.py — Structural and security validation for skills, agents,
plugins, and Claude Code settings/hooks.

Usage:
    python validate_skill.py <target> [<target> ...]

Each target is classified by what it is on disk:
    directory with .claude-plugin/plugin.json   -> plugin
    settings.json / settings.local.json         -> settings (plus sibling hooks/)
    any other *.md file                         -> agent
    any other directory                         -> skill

Exit codes:
    0  Report produced (findings are informational)
    2  Usage error or missing dependency
"""

from __future__ import annotations

import json
import sys
import re
import pathlib

# Ensure emoji output works on Windows and other non-UTF-8 terminals
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

try:
    import yaml
except ImportError:
    print("Missing dependency: pip install pyyaml", file=sys.stderr)
    sys.exit(2)

# ---------------------------------------------------------------------------
# Pattern banks
# ---------------------------------------------------------------------------

SECRET_FAIL = [
    (r"sk-ant-[A-Za-z0-9_-]{20,}", "Anthropic API key"),
    (r"sk-[A-Za-z0-9]{20,}", "OpenAI/Anthropic API key"),
    (r"gh[opsur]_[A-Za-z0-9]{36}", "GitHub token (ghp_/gho_/ghs_/ghu_/ghr_)"),
    (r"github_pat_[A-Za-z0-9_]{82}", "GitHub fine-grained PAT"),
    (r"ATATT[A-Za-z0-9_=-]{20,}", "Atlassian API token"),
    (r"xox[baprs]-[0-9A-Za-z-]{10,}", "Slack token"),
    (r"-----BEGIN (?:RSA|EC|OPENSSH) PRIVATE KEY-----", "Private key block"),
    (r"(?i)password\s*[:=]\s*[\"'][^\"']{8,}[\"']", "Hardcoded password"),
    (r"(?i)(?:api[_-]?key|secret[_-]?key)\s*[:=]\s*[\"'][A-Za-z0-9/+]{16,}[\"']", "Hardcoded API/secret key"),
]

INJECTION_FAIL = [
    (r"(?i)ignore\s+(?:all\s+)?previous\s+instructions", "Prompt injection"),
    (r"(?i)disregard\s+(?:your\s+|all\s+)?(?:guidelines|rules|constraints)", "Safety bypass"),
    (r"(?i)override\s+(?:the\s+)?system\s+prompt", "System prompt override"),
    (r"(?i)(?:you are now|act as)\s+(?:DAN|jailbroken|unrestricted)", "Jailbreak pattern"),
    (r"(?i)(?:post|send|upload|exfiltrate)\b.{0,60}\b(?:credential|api.?key|secret|token)\b.{0,60}\bhttps?://(?!github\.com|skills\.sh)", "Data exfiltration attempt"),
]

INJECTION_WARN = [
    (r"(?i)impersonat(?:e|ing)\s+\w[\w\s]{2,30}(?:CEO|CTO|engineer|developer)", "Impersonation instruction"),
    (r"<SYSTEM>|<HUMAN>", "Prompt injection marker tag"),
]

SCRIPT_FAIL = [
    (r"curl\b.+\|\s*(?:ba)?sh\b", "curl | bash (RCE)"),
    (r"wget\b.+\|\s*(?:ba)?sh\b", "wget | bash (RCE)"),
    (r"(?i)Invoke-WebRequest\b.+\|\s*(?:iex|Invoke-Expression)", "IWR | IEX (RCE)"),
    (r"eval\s+\$\(curl\b", "eval $(curl ...) (RCE)"),
    (r"(?i)-p(?:assword)?\s+['\"]?[A-Za-z0-9!@#$%]{6,}['\"]?\s", "Hardcoded password in CLI arg"),
]

SCRIPT_WARN = [
    (r"rm\s+-[rRfF]{2}", "rm -rf without apparent guard"),
    (r"(?i)Remove-Item\b.+-Recurse\b.+-Force\b", "Remove-Item -Recurse -Force"),
    (r"(?i)(?:curl|wget|Invoke-WebRequest)\b.+https?://(?!github\.com|raw\.githubusercontent\.com|skills\.sh|registry\.npmjs\.org|pypi\.org)", "POST/GET to non-standard external domain"),
]

# Node scripts — hooks and plugin scripts run without a per-command prompt
NODE_FAIL = [
    (r"(?:exec|execSync|spawn|spawnSync)\s*\(\s*[`\"'][^\n]*(?:curl|wget)\b[^\n]*\|\s*(?:ba)?sh\b", "child_process curl | sh (RCE)"),
    (r"\beval\s*\(\s*(?:await\s+)?(?:fetch|require\s*\(\s*[\"']https?)", "eval of remote content (RCE)"),
]

NODE_WARN = [
    (r"(?<![\w.])eval\s*\(", "eval() on dynamic input"),
    (r"\bnew\s+Function\s*\(", "new Function() dynamic code"),
    (r"(?:exec|execSync)\s*\(\s*`[^`\n]*\$\{", "Shell command built from interpolated value"),
    (r"(?:fetch|https?\.request|https?\.get)\s*\(\s*[`\"']https?://(?!github\.com|api\.github\.com|raw\.githubusercontent\.com|registry\.npmjs\.org|localhost|127\.0\.0\.1)", "Network call to hardcoded external host"),
]

ABSOLUTE_PATH = r"(?:\b[A-Za-z]:\\Users\\|/Users/[\w.-]+/|/home/[\w.-]+/)"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

SHELL_EXTENSIONS = {".sh", ".bash", ".ps1", ".psm1", ".cmd", ".bat"}
NODE_EXTENSIONS = {".js", ".mjs", ".cjs", ".ts"}

# Documentation directories contain intentional examples of bad patterns
DOC_DIRS = {"references", "rules", "templates", "docs", "assets", "evals"}
SKIP_DIRS = {"node_modules", ".git", "__fixtures__"}

KNOWN_MODELS = {"opus", "sonnet", "haiku", "fable", "inherit"}
WRITE_TOOLS = {"write", "edit", "multiedit", "notebookedit"}
READ_VERBS = {"get", "list", "search", "read", "fetch", "find", "lookup", "describe", "query", "view"}
MUTATING_VERBS = {
    "create", "update", "delete", "remove", "transition", "add", "edit",
    "post", "send", "merge", "push", "write", "assign", "close",
}


def read_text(path: pathlib.Path) -> str:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""


def strip_code_elements(text: str) -> str:
    """Remove fenced code, inline code, and quoted example strings.

    Actual malicious instructions appear as plain directives, not wrapped in
    fences or quotation marks. Stripping these eliminates false positives from
    skills that document bad-pattern examples (like this validator itself).
    """
    text = re.sub(r"```[\s\S]*?```", "", text)      # fenced code blocks
    text = re.sub(r"`[^`\n]{1,200}`", "", text)      # inline code
    text = re.sub(r'"[^"\n]{1,120}"', "", text)      # double-quoted example strings
    return text


def scan(text: str, patterns: list[tuple]) -> list[str]:
    findings = []
    for pattern, label in patterns:
        if re.search(pattern, text, re.MULTILINE):
            findings.append(label)
    return findings


def parse_frontmatter(text: str):
    """Return (dict, error_string). error_string is None on success."""
    if not text.startswith("---"):
        return None, "No YAML frontmatter block found"
    try:
        end = text.index("---", 3)
    except ValueError:
        return None, "Frontmatter block not closed (missing closing ---)"
    try:
        data = yaml.safe_load(text[3:end])
        return data or {}, None
    except yaml.YAMLError as exc:
        return None, f"Invalid YAML: {exc}"


def body_of(text: str) -> str:
    body_start = text.find("---", 3)
    return text[body_start + 3:] if body_start != -1 else text


def status_of(fails: list[str], warns: list[str]):
    if fails:
        return "❌", fails + warns
    if warns:
        return "⚠️", warns
    return "✅", []


def walk_files(root: pathlib.Path):
    for f in root.rglob("*"):
        if f.is_file() and not (set(f.relative_to(root).parts[:-1]) & SKIP_DIRS):
            yield f


def scan_script_files(files, base: pathlib.Path):
    """Apply shell and Node pattern banks. Returns (fails, warns)."""
    fails, warns = [], []
    for f in files:
        ext = f.suffix.lower()
        if ext in SHELL_EXTENSIONS:
            banks = (SCRIPT_FAIL, SCRIPT_WARN)
        elif ext in NODE_EXTENSIONS:
            banks = (NODE_FAIL, NODE_WARN)
        else:
            continue
        rel = f.relative_to(base).as_posix()
        text = read_text(f)
        fails += [f"`{rel}`: {label}" for label in scan(text, banks[0])]
        warns += [f"`{rel}`: {label}" for label in scan(text, banks[1])]
    return fails, warns


def scan_secret_files(files, base: pathlib.Path):
    """Apply the secret pattern bank. Returns (fails, warns)."""
    fails, warns = [], []
    for f in files:
        rel = f.relative_to(base).as_posix()
        parts = set(pathlib.Path(rel).parts[:-1])  # parent directory names

        # Skip files inside documentation subdirectories
        if parts & DOC_DIRS:
            continue

        # Skip example/template files — they document format, not real values
        if re.search(r"(?i)(\.example\.|example\.|template)", rel):
            continue

        # Warn about local credential files
        if re.search(r"(?i)\.local\.(json|yaml|yml|env|cfg|ini)$", rel):
            warns.append(f"`{rel}` — local credential file; ensure it is gitignored")
            continue

        fails += [f"`{rel}`: {label}" for label in scan(read_text(f), SECRET_FAIL)]
    return fails, warns


# ---------------------------------------------------------------------------
# Skill checks
# ---------------------------------------------------------------------------

def check_structure(skill_path: pathlib.Path, skill_name: str):
    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return "❌", ["SKILL.md not found"]

    text = read_text(skill_md)
    fm, err = parse_frontmatter(text)
    if err:
        return "❌", [err]

    findings = []
    if "name" not in fm:
        findings.append("Missing required field: `name`")
    elif str(fm["name"]) != skill_name:
        findings.append(f"`name` is `{fm['name']}` but directory is `{skill_name}`")

    if "description" not in fm or not str(fm.get("description", "")).strip():
        findings.append("Missing or empty `description`")

    return ("❌", findings) if findings else ("✅", [])


def check_content(skill_path: pathlib.Path):
    skill_md = skill_path / "SKILL.md"
    # Strip code/quoted examples so documented bad patterns don't self-trigger
    text = strip_code_elements(read_text(skill_md))
    return status_of([f"**{f}**" for f in scan(text, INJECTION_FAIL)], scan(text, INJECTION_WARN))


def check_scripts(skill_path: pathlib.Path):
    scripts_dir = skill_path / "scripts"
    if not scripts_dir.exists():
        return "✅ N/A", []
    return status_of(*scan_script_files(walk_files(scripts_dir), skill_path))


def check_secrets(skill_path: pathlib.Path):
    return status_of(*scan_secret_files(walk_files(skill_path), skill_path))


def check_permissions(skill_path: pathlib.Path):
    skill_md = skill_path / "SKILL.md"
    text = read_text(skill_md)
    fm, err = parse_frontmatter(text)
    if err or not fm or "tools" not in fm:
        return "✅ N/A", []

    tools = fm["tools"]
    if not isinstance(tools, list):
        return "⚠️", ["`tools` field is not a list"]

    body = body_of(text)

    findings = []
    for tool in tools:
        t = str(tool)
        if t in ("*", "all"):
            findings.append(f"Wildcard `{t}` in tools — consider listing specific tools")
        elif t.lower() not in body.lower():
            findings.append(f"`{t}` listed in `tools` but not referenced in body")

    return ("⚠️", findings) if findings else ("✅", [])


def validate_skill(skill_path: pathlib.Path) -> dict:
    structure_s, structure_f = check_structure(skill_path, skill_path.name)
    content_s,   content_f   = check_content(skill_path)
    scripts_s,   scripts_f   = check_scripts(skill_path)
    secrets_s,   secrets_f   = check_secrets(skill_path)
    perms_s,     perms_f     = check_permissions(skill_path)

    return {
        "structure":   {"status": structure_s, "findings": structure_f},
        "content":     {"status": content_s,   "findings": content_f},
        "scripts":     {"status": scripts_s,   "findings": scripts_f},
        "secrets":     {"status": secrets_s,   "findings": secrets_f},
        "permissions": {"status": perms_s,     "findings": perms_f},
    }


# ---------------------------------------------------------------------------
# Agent checks
# ---------------------------------------------------------------------------

def parse_tools(value):
    """Agent `tools` is a comma-separated string or a YAML list. None = field absent."""
    if value is None:
        return None
    if isinstance(value, str):
        return [t.strip() for t in value.split(",") if t.strip()]
    if isinstance(value, list):
        return [str(t).strip() for t in value]
    return []


def is_mutating_mcp_tool(tool: str) -> bool:
    if not tool.startswith("mcp__"):
        return False
    short = tool.split("__")[-1]
    words = [w.lower() for w in re.findall(r"[A-Za-z][a-z]*", short)]
    if not words or words[0] in READ_VERBS:
        return False
    return bool(set(words) & MUTATING_VERBS)


def agent_structure(path: pathlib.Path, fm: dict):
    fails, warns = [], []
    # Copilot agents (`*.agent.md`) use a display name, not the file name
    expected = None if path.name.endswith(".agent.md") else path.stem

    if "name" not in fm:
        fails.append("Missing required field: `name`")
    elif expected and str(fm["name"]) != expected:
        fails.append(f"`name` is `{fm['name']}` but file is `{path.name}`")

    if not str(fm.get("description", "") or "").strip():
        fails.append("Missing or empty `description`")

    model = fm.get("model")
    if model is not None and str(model) not in KNOWN_MODELS and not str(model).startswith("claude-"):
        warns.append(f"Unrecognised `model` value `{model}`")

    return fails, warns


def agent_permissions(fm: dict, body: str):
    """Least-privilege review of an agent's tool grant. Returns warnings."""
    tools = parse_tools(fm.get("tools"))
    if tools is None:
        return ["No `tools` field — agent inherits every tool, including MCP tools"]

    warns = []
    name = str(fm.get("name", ""))
    description = str(fm.get("description", "") or "")
    lowered = {t.lower() for t in tools}

    for t in tools:
        if t in ("*", "all"):
            warns.append(f"Wildcard `{t}` in tools — consider listing specific tools")

    read_only_role = (
        re.search(r"(?:reviewer|analyst|auditor)$", name, re.IGNORECASE)
        or re.search(r"(?i)read[- ]only", description)
    )
    held = sorted(lowered & WRITE_TOOLS)
    if read_only_role and held:
        warns.append(
            f"Read-only role holds file-writing tool(s): {', '.join(f'`{t}`' for t in held)}"
        )

    for t in tools:
        if is_mutating_mcp_tool(t) and t.split("__")[-1].lower() not in body.lower():
            warns.append(f"`{t}` can modify an external system but is not referenced in the body")

    return warns


def validate_agent(path: pathlib.Path) -> dict:
    text = read_text(path)
    fm, err = parse_frontmatter(text)
    body = body_of(text) if not err else text

    if err:
        structure = ("❌", [err])
        perms = ("✅ N/A", [])
    else:
        structure = status_of(*agent_structure(path, fm))
        perms = status_of([], agent_permissions(fm, body))

    stripped = strip_code_elements(text)
    content = status_of([f"**{f}**" for f in scan(stripped, INJECTION_FAIL)], scan(stripped, INJECTION_WARN))
    secrets = status_of([f"`{path.name}`: {label}" for label in scan(text, SECRET_FAIL)], [])

    return {
        "structure":   {"status": structure[0], "findings": structure[1]},
        "content":     {"status": content[0],   "findings": content[1]},
        "scripts":     {"status": "✅ N/A",      "findings": []},
        "secrets":     {"status": secrets[0],   "findings": secrets[1]},
        "permissions": {"status": perms[0],     "findings": perms[1]},
    }


# ---------------------------------------------------------------------------
# Plugin checks
# ---------------------------------------------------------------------------

def find_marketplace(plugin_path: pathlib.Path):
    for parent in plugin_path.parents:
        candidate = parent / ".claude-plugin" / "marketplace.json"
        if candidate.exists():
            return candidate
    return None


def plugin_marketplace_findings(plugin_path: pathlib.Path, plugin_name: str):
    fails, warns = [], []
    marketplace = find_marketplace(plugin_path)
    if marketplace is None:
        return fails, warns

    try:
        data = json.loads(read_text(marketplace))
    except json.JSONDecodeError as exc:
        return [f"`marketplace.json` is not valid JSON: {exc}"], warns

    entries = [p for p in data.get("plugins", []) if isinstance(p, dict)]
    entry = next((p for p in entries if p.get("name") == plugin_name), None)
    if entry is None:
        warns.append("Plugin is not listed in `.claude-plugin/marketplace.json`")
    elif isinstance(entry.get("source"), str):
        resolved = (marketplace.parent.parent / entry["source"]).resolve()
        if resolved != plugin_path:
            fails.append(f"Marketplace `source` `{entry['source']}` does not resolve to this plugin")
    return fails, warns


def validate_plugin(plugin_path: pathlib.Path) -> dict:
    manifest_path = plugin_path / ".claude-plugin" / "plugin.json"
    s_fails, s_warns = [], []
    manifest = {}
    try:
        manifest = json.loads(read_text(manifest_path))
    except json.JSONDecodeError as exc:
        s_fails.append(f"`plugin.json` is not valid JSON: {exc}")

    if manifest:
        if "name" not in manifest:
            s_fails.append("`plugin.json` is missing required field: `name`")
        elif manifest["name"] != plugin_path.name:
            s_fails.append(f"`plugin.json` name is `{manifest['name']}` but directory is `{plugin_path.name}`")
        if not str(manifest.get("description", "")).strip():
            s_warns.append("`plugin.json` has no `description`")
        if "version" not in manifest:
            s_warns.append("`plugin.json` has no `version`")
        m_fails, m_warns = plugin_marketplace_findings(plugin_path, str(manifest.get("name", "")))
        s_fails += m_fails
        s_warns += m_warns

    c_fails, c_warns, p_warns = [], [], []

    def prefixed(rel: str, items: list[str]) -> list[str]:
        return [f"`{rel}`: {item}" for item in items]

    # Bundled skills and agents get the same checks as standalone ones
    skills_dir = plugin_path / "skills"
    skill_dirs = sorted(d for d in skills_dir.iterdir() if d.is_dir()) if skills_dir.is_dir() else []
    for skill in skill_dirs:
        rel = skill.relative_to(plugin_path).as_posix()
        result = validate_skill(skill)
        if "❌" in result["structure"]["status"]:
            s_fails += prefixed(rel, result["structure"]["findings"])
        bucket = c_fails if "❌" in result["content"]["status"] else c_warns
        bucket += prefixed(rel, result["content"]["findings"])
        p_warns += prefixed(rel, result["permissions"]["findings"])

    agents_dir = plugin_path / "agents"
    agent_files = sorted(agents_dir.glob("*.md")) if agents_dir.is_dir() else []
    for agent in agent_files:
        rel = agent.relative_to(plugin_path).as_posix()
        result = validate_agent(agent)
        bucket = s_fails if "❌" in result["structure"]["status"] else s_warns
        bucket += prefixed(rel, result["structure"]["findings"])
        bucket = c_fails if "❌" in result["content"]["status"] else c_warns
        bucket += prefixed(rel, result["content"]["findings"])
        p_warns += prefixed(rel, result["permissions"]["findings"])

    # Instructions must stay portable — a plugin is installed on other machines
    for md in [s / "SKILL.md" for s in skill_dirs] + agent_files:
        if re.search(ABSOLUTE_PATH, read_text(md)):
            rel = md.relative_to(plugin_path).as_posix()
            s_warns.append(f"`{rel}`: absolute user path — use `${{CLAUDE_PLUGIN_ROOT}}`")

    # Components that run or connect on install, without a per-use prompt
    if (plugin_path / "hooks").is_dir() or "hooks" in manifest:
        p_warns.append("Plugin bundles hooks — they run automatically once the plugin is enabled")
    if (plugin_path / ".mcp.json").exists() or "mcpServers" in manifest:
        p_warns.append("Plugin bundles MCP servers — review each server's command and scope")

    files = list(walk_files(plugin_path))
    script_files = [f for f in files if not ({"skills", "agents"} & set(f.relative_to(plugin_path).parts[:1]))]
    scripts = status_of(*scan_script_files(script_files, plugin_path))
    if not any(f.suffix.lower() in SHELL_EXTENSIONS | NODE_EXTENSIONS for f in script_files):
        scripts = ("✅ N/A", [])
    secrets = status_of(*scan_secret_files(files, plugin_path))
    structure = status_of(s_fails, s_warns)
    content = status_of(c_fails, c_warns)
    perms = status_of([], p_warns)

    return {
        "structure":   {"status": structure[0], "findings": structure[1]},
        "content":     {"status": content[0],   "findings": content[1]},
        "scripts":     {"status": scripts[0],   "findings": scripts[1]},
        "secrets":     {"status": secrets[0],   "findings": secrets[1]},
        "permissions": {"status": perms[0],     "findings": perms[1]},
    }


# ---------------------------------------------------------------------------
# Settings + hooks checks
# ---------------------------------------------------------------------------

def collect_hook_commands(node) -> list[str]:
    commands = []
    if isinstance(node, dict):
        if isinstance(node.get("command"), str):
            commands.append(node["command"])
        for value in node.values():
            commands += collect_hook_commands(value)
    elif isinstance(node, list):
        for item in node:
            commands += collect_hook_commands(item)
    return commands


def validate_settings(settings_path: pathlib.Path) -> dict:
    config_dir = settings_path.parent
    project_root = config_dir.parent if config_dir.name == ".claude" else config_dir
    hooks_dir = config_dir / "hooks"
    na = {"status": "✅ N/A", "findings": []}

    try:
        settings = json.loads(read_text(settings_path))
    except json.JSONDecodeError as exc:
        return {
            "structure": {"status": "❌", "findings": [f"Not valid JSON: {exc}"]},
            "content": na, "scripts": na, "secrets": na, "permissions": na,
        }

    # Structure — every wired hook command must point at a file that exists
    s_fails = []
    commands = collect_hook_commands(settings.get("hooks", {}))
    for command in commands:
        for ref in re.findall(r"[\w$./\\{}-]*[\\/][\w.-]*\w\.(?:mjs|cjs|js|sh|ps1|py)\b", command):
            if ref.startswith("//"):  # tail of a URL, not a local file
                continue
            local = re.sub(r"\$\{?CLAUDE_PROJECT_DIR\}?[\\/]*", "", ref)
            if not (project_root / local).exists():
                s_fails.append(f"Hook command references missing file `{local}`")

    # Scripts — hook files plus the inline commands themselves
    hook_files = list(walk_files(hooks_dir)) if hooks_dir.is_dir() else []
    sc_fails, sc_warns = scan_script_files(hook_files, config_dir)
    for command in commands:
        short = command if len(command) <= 60 else command[:57] + "..."
        sc_fails += [f"Inline hook `{short}`: {label}" for label in scan(command, SCRIPT_FAIL)]
        sc_warns += [f"Inline hook `{short}`: {label}" for label in scan(command, SCRIPT_WARN)]

    # Permissions — what runs without asking
    p_fails, p_warns = [], []
    permissions = settings.get("permissions", {}) or {}
    for entry in permissions.get("allow", []) or []:
        e = str(entry)
        if e in ("*", "Bash") or re.fullmatch(r"Bash\(\s*\*?(?::\*)?\s*\)", e):
            p_fails.append(f"`{e}` in `permissions.allow` — unrestricted shell access")
        elif e.startswith("mcp__") and e.endswith("*"):
            p_warns.append(f"`{e}` in `permissions.allow` — wildcard pre-approves every tool on that MCP server, including writes")
    if permissions.get("defaultMode") == "bypassPermissions":
        p_fails.append("`permissions.defaultMode` is `bypassPermissions` — every tool call runs unprompted")
    if settings.get("enableAllProjectMcpServers") is True:
        p_warns.append("`enableAllProjectMcpServers` is true — any server added to `.mcp.json` starts without approval")

    structure = status_of(s_fails, [])
    scripts = status_of(sc_fails, sc_warns) if (hook_files or commands) else ("✅ N/A", [])
    secrets = status_of(*scan_secret_files([settings_path] + hook_files, config_dir))
    perms = status_of(p_fails, p_warns)

    return {
        "structure":   {"status": structure[0], "findings": structure[1]},
        "content":     na,
        "scripts":     {"status": scripts[0],   "findings": scripts[1]},
        "secrets":     {"status": secrets[0],   "findings": secrets[1]},
        "permissions": {"status": perms[0],     "findings": perms[1]},
    }


# ---------------------------------------------------------------------------
# Risk level
# ---------------------------------------------------------------------------

def risk_level(results: dict) -> str:
    statuses = [v["status"] for v in results.values()]
    if any("❌" in s for s in statuses):
        return "🔴 High"
    warn_count = sum(1 for s in statuses if "⚠️" in s)
    if warn_count >= 3:
        return "🔴 High"
    if warn_count >= 1:
        return "🟡 Medium"
    return "🟢 Low"


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

CHECKS = ("structure", "content", "scripts", "secrets", "permissions")


def classify(path: pathlib.Path) -> str:
    if path.is_dir() and (path / ".claude-plugin" / "plugin.json").exists():
        return "plugin"
    if path.is_file() and path.name in ("settings.json", "settings.local.json"):
        return "settings"
    if path.is_file() and path.suffix.lower() == ".md":
        return "agent"
    return "skill"


def validate(target: str) -> dict:
    path = pathlib.Path(target).resolve()
    kind = classify(path)

    if kind == "plugin":
        results = validate_plugin(path)
    elif kind == "settings":
        results = validate_settings(path)
    elif kind == "agent":
        results = validate_agent(path)
    else:
        results = validate_skill(path)

    results["risk"] = risk_level(results)
    results["type"] = kind
    results["name"] = path.name[:-3] if kind == "agent" else path.name
    return results


def short_status(s: str) -> str:
    if "❌" in s: return "❌"
    if "⚠️" in s: return "⚠️"
    if "N/A" in s: return "N/A"
    return "✅"


def main(targets: list[str]) -> int:
    if not targets:
        print("Usage: validate_skill.py <target> [<target> ...]")
        return 2

    all_results = [validate(t) for t in targets]
    today = __import__("datetime").date.today().isoformat()

    # --- Summary table ---
    print(f"\n## Security Validation Report")
    print(f"Checked: {len(all_results)} item(s)  |  Date: {today}\n")
    print("| Name | Type | Structure | Content | Scripts | Secrets | Permissions | Risk |")
    print("|------|------|:---------:|:-------:|:-------:|:-------:|:-----------:|:----:|")
    for r in all_results:
        cells = " | ".join(short_status(r[c]["status"]) for c in CHECKS)
        print(f"| {r['name']} | {r['type']} | {cells} | {r['risk']} |")

    # --- Findings ---
    findings_printed = False
    for r in all_results:
        for check in CHECKS:
            data = r[check]
            if data["findings"]:
                if not findings_printed:
                    print("\n## Findings\n")
                    findings_printed = True
                icon = data["status"].split()[0]
                print(f"### {r['name']} ({r['type']}) — {check.capitalize()} {icon}")
                for f in data["findings"]:
                    print(f"- {f}")
                print()

    if not findings_printed:
        print("\n✅ All items passed security validation — no issues found.")

    # Machine-readable summary line consumed by CI steps
    high   = sum(1 for r in all_results if "🔴" in r["risk"])
    medium = sum(1 for r in all_results if "🟡" in r["risk"])
    low    = sum(1 for r in all_results if "🟢" in r["risk"])
    print(f"\nSTAT:checked={len(all_results)},high={high},medium={medium},low={low}")

    # Compact findings list for Slack (one entry per failing check)
    slack_items: list[str] = []
    for r in all_results:
        for check in CHECKS:
            data = r[check]
            if not data["findings"]:
                continue
            icon = ":red_circle:" if "❌" in data["status"] else ":large_yellow_circle:"
            slack_items.append(f"{icon} *{r['name']}* ({r['type']}) — {check}")
    if slack_items:
        print(f"FINDINGS:{' | '.join(slack_items)}")

    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
