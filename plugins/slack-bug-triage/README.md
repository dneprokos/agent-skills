# slack-bug-triage — Claude Code plugin

Reads a Slack bug-reports channel, claims each new message in a ledger, drafts a bug from it, checks the
Jira backlog for an existing ticket, and either files a new bug or points the reporter at the one that
already exists — replying in thread and marking the message every time.

The workflow itself is documented in `skills/slack-bug-triage/README.md`. This file covers only what
changes when it ships as a plugin: what it needs from the host, what it writes where, and the two places
the plugin form behaves differently from the same files sitting in a project's `.claude/`.

## What it ships

```
.claude-plugin/plugin.json                     the manifest
skills/slack-bug-triage/SKILL.md               the orchestrator — routing, caps, the ledger, the return block
skills/slack-bug-triage/README.md              the workflow's own documentation
skills/slack-bug-triage/references/            run shape, the Slack server, and the two shared contracts
skills/slack-bug-triage/assets/                the three reply templates, posted verbatim
agents/triage-*.md                             the five steps — one file each, none naming another
scripts/slack-triage-journal.mjs               the only writer of the ledger; owns the skip filter
scripts/draft-bug.js, scripts/lib.js           the bug-draft builder and its field rules
scripts/config.json                            the Jira project, its fields and the dedupe settings
scripts/assets/bug-description.template.md     the Jira description body, rendered by substitution
scripts/__tests__/, scripts/__fixtures__/      the journal suite — `node --test "scripts/__tests__/*.test.mjs"`
```

Invocation is namespaced: `/slack-bug-triage:slack-bug-triage`. Every path inside the skill and the agents
is written as `${CLAUDE_PLUGIN_ROOT}/…`, which Claude Code substitutes for the install directory when the
markdown loads.

## Install

```bash
# from a marketplace (this repository is one)
/plugin marketplace add dneprokos/agent-skills
/plugin install slack-bug-triage@agent-skills

# or, while developing it
claude --plugin-dir ./plugins/slack-bug-triage
```

## What the host must provide

The plugin brings the workflow. It does not bring the credentials, the MCP servers, or the Jira project —
all three are per-workspace, and two of them are secrets.

**1. Two MCP servers, under the names `slack` and `atlassian`.** The five agents hold literal tool
allowlists (`mcp__slack__conversations_history`, `mcp__atlassian__createJiraIssue`, …), so the server names
are part of the contract. Put this in the host project's `.mcp.json`:

```json
{
  "mcpServers": {
    "atlassian": {
      "type": "sse",
      "url": "https://mcp.atlassian.com/v1/sse"
    },
    "slack": {
      "command": "npx",
      "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
      "env": {
        "SLACK_MCP_XOXB_TOKEN": "${SLACK_MCP_XOXB_TOKEN}",
        "SLACK_MCP_ADD_MESSAGE_TOOL": "${SLACK_TRIAGE_CHANNEL_ID}",
        "SLACK_MCP_REACTION_TOOL": "${SLACK_TRIAGE_CHANNEL_ID}"
      }
    }
  }
}
```

The servers are deliberately **not** bundled in the plugin. A plugin-provided server is exposed under a
scoped name, which would not match the allowlists above, and a second `slack` server in a project that
already declares one is a conflict rather than a convenience.

**2. Three OS environment variables** — not `.env` keys; `${VAR}` in `.mcp.json` expands from the process
environment:

| Variable | What it is |
|---|---|
| `SLACK_MCP_XOXB_TOKEN` | a **bot** token (`xoxb-`) |
| `SLACK_TRIAGE_CHANNEL_ID` | the channel id (`C…`) the run reads, and the only channel the two write tools are scoped to |
| `SLACK_TRIAGE_SELF_USER_ID` | the user id this workflow posts as, so a run never files a ticket about its own reply |

Posting and reacting stay off unless `SLACK_MCP_ADD_MESSAGE_TOOL` and `SLACK_MCP_REACTION_TOOL` are set —
one variable gates both reaction tools. Set each to the channel id, never to `true`.

**3. The bot invited to the channel, once, by hand** (`/invite @<app-name>`). A bot reads no channel it is
not a member of, public ones included, so the omission surfaces as `not_in_channel` on the channel read —
before anything is drafted, searched or filed.

**4. `"slack"` in `enabledMcpjsonServers`** in the host's `.claude/settings.local.json`. That file is
gitignored, so it is an operator step rather than a repository change.

**5. A Jira project that matches `scripts/config.json`** — the site, cloud id, project key, issue type, the
`Defect Detection Phase` custom-field id and the priority values all live there. Point it at your own
project before the first run; nothing in the scripts hardcodes a Jira value.

## What it writes, and where

Everything the run produces is **project-local**, never inside the plugin install:

```
.slack-triage/journal.jsonl        the ledger — track it in git, with `merge=union` in .gitattributes
.slack-triage/runs/<run_id>/       intake.json, drafts-index.json, verdicts.json, per-message drafts
.jira-bug/                         the draft builder's scratch output
```

The root is `CLAUDE_PROJECT_DIR`, falling back to the working directory when a script is run by hand. This
is the one behavioural change the plugin form required: both scripts previously resolved their root by
walking up from their own location, which inside a plugin install would put one workspace's ledger next to
another's. A run against repo A and a run against repo B are different backlogs.

The ledger is the durable statement that a Slack message already became a ticket. Losing it means the next
run refiles everything, which is why it is tracked rather than ignored — and why a `slack-<channel>-<ts>`
label on every filed bug is searched before any create, as the second half of the idempotency guarantee.

## Two things to know when both copies exist

This plugin was extracted from a project that still carries the same skill and agents under `.claude/`.
Where both are present:

- **The project's `.claude/agents/triage-*.md` win.** Project and user agent definitions override
  same-named plugin agents, so in that project the plugin's copies are inert until the originals are
  removed. Elsewhere the plugin's agents are the only ones there.
- **Both skills are invocable.** Plugin skills are namespaced, so `/slack-bug-triage` (project) and
  `/slack-bug-triage:slack-bug-triage` (plugin) are two commands, not a collision. They share the ledger,
  the label and the caps, so running either is safe — but only one of them is the copy you are editing.

## Tests

```bash
node --test "scripts/__tests__/*.test.mjs"
```

The suite spawns `slack-triage-journal.mjs` as a CLI and asserts on its exit codes and `ST-E<nn>` codes.
The cases that matter most are the ones nobody can check by reading the channel: a message excluded
forever, a bug filed twice, or a reporter asked the same question every run until they mute the channel.
