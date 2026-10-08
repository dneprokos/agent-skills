# Exploratory Testing Agentic Workflow — Design

Date: 2026-10-08
Status: Draft, pending user review

## Goal

An agentic workflow that explores a website and returns a file of potential bugs.

- Agent 1 builds a site map.
- Agent 2 follows the map and runs exploratory testing under hard limits.
- Output is a Markdown findings file. Findings are unverified candidates, not confirmed defects.

## Decisions

| Topic | Decision |
|---|---|
| Orchestration | Skill on main thread + 2 sub-agents. Sub-agents cannot prompt the user, so the skill collects all inputs. Pattern follows `qa-workflow`: stateless agents, path-based inputs, one receipt line each. |
| Map source | User picks one of: `live` (playwright-cli), `source` (code), `both`. |
| Source input | Local path or GitHub URL. A URL is shallow-cloned to a scratch dir, read-only. |
| Admin credentials | Typed in chat, optional. Held in session only. Never written to any file. Redacted in all output. Warning shown when collected. |
| Missing creds | Admin scope excluded. Listed under "Excluded scenarios" in the findings file with reason. |
| Limits | Same-origin only. No page analyzed twice. Wall-clock budget (default 20 min, user-overridable). No destructive actions (default on): no delete, purchase, send, logout-style actions. |
| Output | `docs/exploratory/<slug>/`, Markdown. |

## Architecture

```
/exploratory-testing  (skill, main thread)
  1. Ask user: mode {live|source|both}, base_url, repo (path|URL; source/both only),
     admin creds (optional), time budget
  2. Preflight: curl base_url (non-2xx/3xx -> stop). Clone repo if URL.
  3. Spawn et-sitemapper -> docs/exploratory/<slug>/site-map.md
  4. Spawn et-explorer   -> docs/exploratory/<slug>/findings.md
  5. Print summary and path
```

### et-sitemapper

- Read-only. Never receives credentials.
- `live`: crawl same-origin links and navigation with playwright-cli. Dedupe by normalized URL.
- `source`: parse router config (React Router, Next.js `app/` and `pages/`).
- `both`: merge. A route found in code but unreachable live is recorded as a finding candidate.
- Marks gated pages `requires: auth|admin`.
- Receipt: `SITEMAP_RESULT: OK|BLOCKED|ABORT` + page count + path.

### et-explorer

- Input: site-map path, base_url, deadline, creds (only if supplied), findings path.
- Walks the map once. Per page: snapshot, console and network errors, broken images and links, forms (empty, invalid, boundary input), basic accessibility, layout, keyboard use.
- Off-origin link: recorded as "external, not followed".
- Admin pages: login once if creds supplied; otherwise skip and list as excluded.
- Stops at the deadline and reports covered vs remaining.
- Receipt: `EXPLORE_RESULT: OK|PARTIAL|BLOCKED|ABORT` + findings count + path.

## Files

```
.claude/skills/exploratory-testing/SKILL.md
.claude/skills/exploratory-testing/references/{findings-template.md, site-map-schema.md, heuristics.md}
.claude/skills/exploratory-testing/scripts/pw.mjs
.claude/agents/et-sitemapper.md
.claude/agents/et-explorer.md
```

Mirror the skill to `.github/skills/` and `.cursor/skills/` (per CLAUDE.md). Agents stay Claude-only, like `qa-*`. Update the CLAUDE.md "Known gaps" notes if the skill is Claude-only in practice.

## Data formats

### site-map.md

Header: base_url, mode, date, page count, code-only routes, live-only routes.

| id | url (normalized) | title | source (live/code/both) | requires (none/auth/admin) | links_to | forms | notes |
|---|---|---|---|---|---|---|---|

### findings.md

1. Run summary: url, mode, duration, pages mapped, pages analyzed.
2. Coverage table: page, status (analyzed / skipped / external / excluded).
3. Excluded scenarios: admin without creds, reason.
4. Potential findings: id, page, severity guess, steps, expected vs actual, evidence, confidence.

## Guardrails (enforced in `pw.mjs`, not only in prose)

- Origin guard: any `goto` or click that lands off-origin is blocked and logged.
- Visited set: normalized URL (strip fragment, sort query, drop trailing slash) kept in a state file. A second visit is refused.
- Redaction: creds substituted at call time, replaced in all output and snapshots.
- Deadline: calls after the deadline are rejected, so the explorer writes the final report.
- Destructive-action filter: wrapper refuses clicks on elements whose accessible name matches a deny list (delete, remove, pay, purchase, send, logout, sign out).

## Error handling

| Condition | Behavior |
|---|---|
| Preflight non-2xx/3xx | Stop. Never guess the URL. |
| Clone fails or no router found | Fall back to `live`, tell user. |
| Login fails | Exclude admin scope ("creds rejected"), continue. |
| Page crash or timeout | Record as finding, continue. |
| Budget reached | Partial report with "not covered" list. |
| Any exit | Close browser session (`playwright-cli list` shows no browsers). |

## Testing

- Unit tests for `pw.mjs` pure logic via `node --test`: URL normalization, origin check, redaction, deadline, deny list.
- Manual run on a demo site with a seeded broken link and an admin route. Assert: no external navigation, no duplicate analysis, admin excluded without creds, findings file written.
- Run `skill-validator` before commit.

## Settings

Add to the `.claude/settings.json` allow list: `Bash(node .claude/skills/exploratory-testing/scripts/pw.mjs*)`. No playwright-cli permission exists today.

## Risks and notes

- Typed credentials enter the transcript. Mitigated only for files and tool output, not the chat itself. Env var names (as in `web-user-guide`) remain the safer alternative.
- The destructive-action deny list is name-based and can miss unusual labels. Findings stay "potential" for this reason.
- `playwright-cli` has no local SKILL.md in this repo. The command list in `docs/automation/references/browser-exploration.md` is the reference.
- Not in scope: Jira filing. Findings can later be passed to `bug-report-formatter`.
