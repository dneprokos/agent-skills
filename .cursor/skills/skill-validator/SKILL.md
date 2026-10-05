---
name: skill-validator
description: >-
  Security and structural validation for skills, agents, plugins, and Claude Code
  settings and hooks in the workspace. Scans all of them, one surface, or a single named
  item and returns a table showing Structure, Content Safety, Script Safety, Secrets, and
  Permissions results with a per-item risk level.
  Use whenever someone asks to validate, audit, or security-check skills, agents, plugins,
  or hooks, or says things like "check all skills for issues", "is skill X safe?", "audit
  the workspace skills", "run a security scan on skills", "validate skills before
  committing", "check skill health", "audit my agents", "is this plugin safe to
  install?", "check the hooks", or "review agent permissions". Also trigger when a new
  skill, agent, or plugin has just been added and the user hasn't reviewed it yet.
---

# Skill Validator

Read-only security and structural audit for skill folders, agent files, plugins, and
Claude Code settings with their hooks. Returns a results table and a findings section
for every issue found.

## Inputs

| Input | Required | Description |
|-------|----------|-------------|
| Scope | No | `skills` (default), `agents`, `plugins`, `settings`, or `all`. |
| Name | No | Name of a specific skill, agent, or plugin to check. Omit to check everything in scope. |
| Source folder | No | For skills: `.github/skills` (default), `.cursor/skills`, or `.claude/skills`. |

## Workflow

### Step 1 — Resolve scope

Each scope maps to one kind of item:

| Scope | Items | Where |
|-------|-------|-------|
| `skills` | one per subdirectory | `<source-folder>/<skill-name>/` |
| `agents` | one per `.md` file | `.claude/agents/*.md`, `.github/agents/*.agent.md` |
| `plugins` | one per directory holding `.claude-plugin/plugin.json` | `plugins/<plugin-name>/` |
| `settings` | one per settings file, together with its hooks | `.claude/settings.json` + `.claude/hooks/` |

If a name was provided, resolve it inside the scope and stop with a clear message if it
does not exist. If no scope was provided and the request mentions agents, plugins, or
hooks, pick the matching scope; a request to audit "the workspace" or "everything" means
`all`.

### Step 2 — Run five checks on each item

The same five checks apply to every item. Checks 2 and 4 are identical for all kinds;
checks 1, 3 and 5 have per-kind rules, listed under each check.

Read every file that belongs to the item: for a skill, `SKILL.md` and everything under
`scripts/`, `references/`, `config/`, and `templates/`; for an agent, the one file; for a
plugin, the manifest plus every bundled skill, agent, script, and hook; for settings, the
settings file and every file under the sibling `hooks/` folder.

Record each result as:
- ✅ **Pass** — no issues found
- ✅ N/A — check does not apply (e.g., no scripts folder)
- ⚠️ **Warning** — issue is present but not critical (e.g., expected local config)
- ❌ **Fail** — definite problem that should be resolved before use

---

#### Check 1 — Structure

Validates the item is well-formed.

**Skill**
- YAML frontmatter is parseable (delimited by `---` on its own lines)
- Required fields are present: `name` and `description`
- `name` value matches the directory name exactly
- `description` is non-empty and at least one sentence long

**Agent**
- YAML frontmatter is parseable, with `name` and a non-empty `description`
- `name` matches the file name without `.md` (Copilot `*.agent.md` files use a display
  name and are exempt)
- ⚠️ Warning if `model` is set to a value that is not `opus`, `sonnet`, `haiku`, `fable`,
  `inherit`, or a full `claude-*` model id

**Plugin**
- `.claude-plugin/plugin.json` is valid JSON with a `name` that matches the directory
- ⚠️ Warning if `description` or `version` is missing
- If the repository has a `.claude-plugin/marketplace.json`: ⚠️ Warning if the plugin is
  not listed, ❌ Fail if its `source` does not resolve to the plugin directory
- Every bundled skill and agent passes its own Structure rules
- ⚠️ Warning if a bundled skill or agent contains an absolute user path (`C:\Users\...`,
  `/Users/...`, `/home/...`) — a plugin is installed on other machines and must use
  `${CLAUDE_PLUGIN_ROOT}`

**Settings**
- The file is valid JSON
- ❌ Fail if a hook `command` references a script file that does not exist

---

#### Check 2 — Content Safety

Scans the instruction text — `SKILL.md`, an agent body, or every bundled skill and agent
of a plugin — for patterns that could make Claude behave maliciously. Not applicable to
settings.

Flag as ❌ Fail if the text contains:
- Phrases like "ignore previous instructions", "disregard your guidelines",
  "override system prompt", or "you are now DAN / unrestricted / jailbroken"
- Instructions to POST or exfiltrate file contents, credentials, or conversation
  history to an external URL not documented as the item's purpose
- Claims of special Anthropic permissions or trust elevation

Flag as ⚠️ Warning if:
- The text instructs Claude to impersonate a specific real person
- The text references `<SYSTEM>` or `<HUMAN>` tags (injection attempt indicators)
- Instructions ask Claude to act without telling the user (hidden operations)

---

#### Check 3 — Scripts

Scan a skill's `scripts/` folder, a plugin's scripts and hooks, and for settings every
file under `hooks/` plus each inline hook `command`. Mark ✅ N/A when there is nothing to
scan; an agent file is always ✅ N/A. Skip `node_modules/` and `__fixtures__/`.

Hooks deserve the closest reading: they run on every matching event with no permission
prompt.

❌ Fail patterns:
- `curl ... | bash` or `wget ... | sh` (remote code execution), including the same
  pipeline passed to `exec` / `execSync` / `spawn` from a Node script
- `eval` applied to an unsanitized variable sourced from user input or a network call
- Hardcoded credentials passed as CLI arguments (e.g., `-p MyPassword123`)

⚠️ Warning patterns:
- `rm -rf` without a confirmation prompt or guard condition
- `curl`/`Invoke-WebRequest` POSTing to a hardcoded external domain that is not
  documented as part of the item's purpose
- Use of `$env:` or environment variable injection in a way that could expose secrets
- In Node scripts: `eval(...)`, `new Function(...)`, a shell command built from an
  interpolated value (`` execSync(`git log ${input}`) ``), or `fetch` / `https.request`
  to a hardcoded external host

---

#### Check 4 — Secrets

Scan all files for patterns matching known secret formats:

❌ Fail — definite secret:
- Anthropic keys: `sk-ant-[A-Za-z0-9_-]{20,}`
- OpenAI keys: `sk-[A-Za-z0-9]{20,}`
- GitHub tokens: `gh[opsur]_[A-Za-z0-9]{36}` or `github_pat_[A-Za-z0-9_]{82}`
- Atlassian API tokens: `ATATT[A-Za-z0-9_=-]{20,}`
- Slack tokens: `xox[baprs]-[0-9A-Za-z-]{10,}`
- Private key headers: `-----BEGIN (RSA|EC|OPENSSH) PRIVATE KEY-----`
- Generic high-confidence patterns: `password\s*[:=]\s*["'][^"']{8,}["']`

⚠️ Warning — likely local-only (expected but worth flagging):
- A `*.local.json` or `*.local.*` file exists inside the item's folder.
  These are intentionally gitignored credential stores — their presence is expected,
  but confirm they are not checked in.

---

#### Check 5 — Permissions

What the item is allowed to do without asking.

**Skill**

If `SKILL.md` frontmatter does not include a `tools` field: mark ✅ N/A.

Otherwise:
- Each tool listed in `tools` should be referenced or clearly used in the body
- ⚠️ Warning if a tool is listed but not mentioned anywhere in the body
- ⚠️ Warning if `tools` uses a wildcard like `[*]` or `[all]` without justification

**Agent** — least privilege. `tools` is a comma-separated string or a list.
- ⚠️ Warning if there is no `tools` field: the agent inherits every tool, MCP included
- ⚠️ Warning if `tools` uses a wildcard
- ⚠️ Warning if a read-only role — a name ending in `reviewer`, `analyst`, or `auditor`,
  or a description that says "read-only" — holds `Write`, `Edit`, or `NotebookEdit`
- ⚠️ Warning if an MCP tool that changes an external system (its name starts with or
  contains a verb such as create, update, delete, transition, add, send, merge) is granted
  but never referenced in the body
- When reading by hand, also question `Bash` on an agent whose body never runs a command

**Plugin**
- Every bundled skill and agent passes its own Permissions rules
- ⚠️ Warning if the plugin bundles hooks (`hooks/` folder or a `hooks` key in the
  manifest): they start running as soon as the plugin is enabled
- ⚠️ Warning if the plugin bundles MCP servers (`.mcp.json` or an `mcpServers` key)

**Settings**
- ❌ Fail if `permissions.allow` contains `*`, `Bash`, or `Bash(*)` — unrestricted shell
- ❌ Fail if `permissions.defaultMode` is `bypassPermissions`
- ⚠️ Warning for an MCP wildcard such as `mcp__atlassian__*`: it pre-approves every tool
  on that server, including the ones that write
- ⚠️ Warning if `enableAllProjectMcpServers` is `true`

---

### Step 3 — Determine risk level per item

| Level | Criteria |
|-------|----------|
| 🟢 Low | All checks pass (✅ or N/A) |
| 🟡 Medium | 1–2 warnings with no fails |
| 🔴 High | Any ❌ Fail, or 3 or more warnings |

### Step 4 — Output the results table

Always output the summary table first, then a findings section for anything that is not
a clean pass.

#### Summary table

```
## Security Validation Report
Scope: skills (`.github/skills/`)  |  Checked: <N> items  |  Date: <YYYY-MM-DD>

| Name | Type | Structure | Content | Scripts | Secrets | Permissions | Risk |
|------|------|:---------:|:-------:|:-------:|:-------:|:-----------:|:----:|
| git-commit-creator | skill | ✅ | ✅ | ✅ | ✅ | N/A | 🟢 Low |
| jira-issue-creator | skill | ✅ | ✅ | ✅ | ⚠️ | N/A | 🟡 Medium |
| qa-scenario-reviewer | agent | ✅ | ✅ | N/A | ✅ | ✅ | 🟢 Low |
| slack-bug-triage | plugin | ✅ | ✅ | ✅ | ✅ | ✅ | 🟢 Low |
| settings.json | settings | ✅ | N/A | ✅ | ✅ | ⚠️ | 🟡 Medium |
```

#### Findings section

For every non-passing result, add a subsection below the table:

```
## Findings

### jira-issue-creator (skill) — Secrets ⚠️
`config/jira-defaults.local.json` exists. This file is gitignored and expected to stay
local, but if accidentally committed it would expose Jira credentials. Verify it is
listed in `.gitignore`.

### settings.json (settings) — Permissions ⚠️
`mcp__atlassian__*` in `permissions.allow` pre-approves every tool on the Atlassian MCP
server, including the ones that create and transition issues.
```

If every item passes cleanly, output this line instead of a Findings section:
> ✅ All items passed security validation — no issues found.

## Helper script

`scripts/validate_skill.py` runs the pattern-based part of these checks and prints the
same table. It needs Python with `pyyaml`. Pass any mix of targets; each one is
classified by what it is on disk:

```bash
python .github/skills/skill-validator/scripts/validate_skill.py \
  .github/skills/*/ .claude/agents/*.md plugins/*/ .claude/settings.json
```

The script cannot judge intent. Still read the files for what a pattern cannot see: a
hidden operation, a network call whose host is undocumented, a tool grant wider than the
job needs.

## Hard rules

- **Read only.** Never modify, delete, or rewrite any file during this audit.
- Report all findings objectively — do not suppress a warning because the file "looks OK".
- `.local.*` config files are expected to hold credentials; flag their existence as ⚠️
  Warning (not ❌ Fail) since they are designed to remain local.
- Skills with no `scripts/` folder get ✅ N/A for Scripts — that is a clean result.
- Skills with no `tools` frontmatter field get ✅ N/A for Permissions — also clean.
- An agent with no `tools` field is **not** clean: it inherits everything, so it gets ⚠️.
