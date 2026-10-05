# Slack MCP — the server, its gates, and what it cannot tell you

**Read this before the first delegation of a session.** It is part of the skill: same rules, including the
one that no file here names an agent.

---

## 1. The server

`korotovsky/slack-mcp-server`, run over stdio via `npx`. It is chosen over the official Slack MCP plugin
for one reason that decides the whole design: the official plugin's read tools **do not return emoji
reactions**, and have not since the request was opened
([slackapi/slack-skills-plugin#26](https://github.com/slackapi/slack-skills-plugin/issues/26), 2026-04-05,
still open). It also lacks a remove-reaction tool.

This server ships `reactions_add` and `reactions_remove`, `conversations_replies`, and
`conversations_add_message` with `thread_ts`. Whether *its* `conversations_history` returns a `reactions`
array is undocumented — see §4.

## 2. `.mcp.json`

```json
"slack": {
  "command": "npx",
  "args": ["-y", "slack-mcp-server@latest", "--transport", "stdio"],
  "env": {
    "SLACK_MCP_XOXB_TOKEN": "${SLACK_MCP_XOXB_TOKEN}",
    "SLACK_MCP_ADD_MESSAGE_TOOL": "${SLACK_TRIAGE_CHANNEL_ID}",
    "SLACK_MCP_REACTION_TOOL": "${SLACK_TRIAGE_CHANNEL_ID}"
  }
}
```

`.claude/settings.local.json` must also carry `"slack"` in `enabledMcpjsonServers`. That file is
gitignored, so it is an operator step and not a repository change.

## 3. The two gates, and the environment they read from

Posting and reacting are **off unless enabled**. Two environment variables, not three:

| Variable | Gates | Accepts |
|---|---|---|
| `SLACK_MCP_ADD_MESSAGE_TOOL` | `conversations_add_message` | `true`, a channel list, or `!`-prefixed exclusions |
| `SLACK_MCP_REACTION_TOOL` | `reactions_add` **and** `reactions_remove` together | the same three forms |

One variable covers both reaction tools. There is no separate remove flag.

Both are set to the **channel id**, not `true`. A token that can post anywhere in the workspace is the
difference between a bad run and an incident, and the server already offers the narrower form.

**`${VAR}` in `.mcp.json` expands from the process environment, not from `.env`.** This repository's `.env`
is read by `dotenv` inside the Playwright config and nothing else. The token has to be a real OS
environment variable:

```
Windows:  setx SLACK_MCP_XOXB_TOKEN "xoxb-..."      # then restart the terminal
POSIX:    export SLACK_MCP_XOXB_TOKEN=xoxb-...
```

`.env.example` lists the keys so the required set is discoverable in one place. It is documentation there,
not a source.

A gate left unset fails **closed** — the tool is simply absent from the server's list. That is the safe
direction, but it fails at run time, several delegations in, as `tool not found`. That error means the
server was started wrong; it does not mean Slack refused anything, and the two need different fixes.

## 4. The reactions probe

Run once, by hand, before trusting anything about reactions:

1. React to any message in the channel with 👀.
2. Call `mcp__slack__conversations_history` on that channel with `limit: 5` and print the raw first message.
3. Look for `"reactions": [{"name": "eyes", …}]`.

**Record the answer here as documentation only.** Every run resolves it again from its own response and
reports it on the channel-reading receipt, and that per-run value is the one the workflow uses. A server
that starts returning reactions in a later release makes the extra exclusion switch itself on, and only a
per-run answer can notice that.

Result of the last probe: **not yet run** — fill this in after the first end-to-end run.

## 5. The token, its scopes, and the invite

**This repository runs on a bot token (`xoxb-`), set as `SLACK_MCP_XOXB_TOKEN`.** The server accepts four
credentials — `xoxp-` (user), `xoxb-` (bot), and the `xoxc-`/`xoxd-` browser-session pair — and `.mcp.json`
passes exactly one. Changing which is a two-file edit: the key in `.mcp.json` and this section.

Bot Token Scopes: `channels:history`, `channels:read`, `groups:history`, `groups:read`, `reactions:read`,
`reactions:write`, `chat:write`, `users:read`.

**A bot token must be invited to the channel before it can be used, and nothing in the run does that.**
Run `/invite @<app-name>` in the triaged channel once, by hand, at setup.

Skipping it fails the run on its **first read**, not its first write: `conversations.history` returns
`not_in_channel` for a bot token that is not a member, and it does so on a **public** channel too —
visibility and membership are different things, and only membership is checked. Verified against this
workspace on 2026-08-24: `conversations.info` on the public channel `bug-reports` answered with
`is_member: false`, and `conversations.history` on the same channel answered `not_in_channel`.

That is the cheap direction to fail in, and it is worth knowing which direction it is. Nothing has been
drafted, no Jira search has run and no ticket exists when it happens, so the fix is one `/invite` and a
re-run. `not_in_channel` from the channel read means the invite was never done; the same error from the
responding step means the app was removed from the channel mid-run.

The responding step's first call is still a single probe reaction, because read and write permission are
granted separately and a token that reads a channel may still be refused a reaction on it.

A bot token was chosen over a user token here for a mundane reason worth recording: the workspace is a
free-plan personal workspace whose app had org-readiness enabled, and the user-token install was refused
with *"Apps with this feature are only available to Enterprise customers"*. Disabling org-readiness
(app → Settings → Org Level Apps → **Enable org-readiness** off) fixes that install; adding User Token
Scopes and reinstalling then yields an `xoxp-` alongside the `xoxb-`.

Two things a bot token costs against a user one. It has **no search capability** — this workflow never
searches Slack, so the cost is zero today and is a constraint on anything added later. And it does **not**
inherit your channel membership, which is the invite above. What it buys is a credential scoped to one
app, revocable on its own, that is not your login.

## 6. Rate limits, and the shape of a burst

`conversations.history` is roughly 50 calls a minute. `reactions.add` and `chat.postMessage` are roughly
one per second per channel.

The dangerous moment is the claim barrier: N reactions in a burst, one per collected message. Three things
hold it down — a message cap of 25 per run, serial responding, and a hard rule against retrying a 429 more
than once. A retry loop against a channel rate limit turns one run's tidiness into an outage for every
other client of that token.

A rate-limited run is not a failed run. The journal records only the reactions that actually landed, so the
next run finishes the job.

## 7. Four things the server cannot tell you

1. **Whether a reaction is present**, on a build whose read tools omit them. Nothing routes on a mark.
2. **When a reaction was added.** Slack carries no timestamp on one, which is why a claim needs a lease in
   the ledger rather than an age read off the emoji.
3. **Whether a message was edited**, without comparing the text. The ledger stores a hash for exactly this.
4. **Who a `bot_id` belongs to**, reliably, across a token rotation. That is why the workflow's own replies
   carry a literal marker line as well as being matched on author id.
