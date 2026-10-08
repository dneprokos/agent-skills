---
name: exploratory-testing
description: >-
  Explore a website and return a Markdown file of potential bugs. Builds a site map (from the live site,
  from source code, or both), then runs time-boxed exploratory testing along the map under hard limits:
  same origin only, no page analyzed twice, a wall-clock budget, no destructive actions, admin credentials
  redacted and never written to a file. Findings are unverified candidates. Use when asked to "explore this
  site", "do exploratory testing", "find bugs on <url>", "crawl and test the app", "build a site map and test
  it", "smoke explore the website", or "/exploratory-testing". Claude Code only: it spawns the et-sitemapper
  and et-explorer sub-agents.
argument-hint: "[mode=live|source|both] [base_url=<url>] [repo=<path|https-url>] [minutes=<n>]"
allowed-tools: Bash(node:*), Bash(curl:*), Bash(git clone:*), Bash(playwright-cli list), Read, Write, Glob, Agent
---

# Exploratory testing

One run: a site map, then one time-boxed exploratory session along it, then a findings file.

```
/exploratory-testing  (this skill, main thread)
  1. Ask: mode, base_url, repo (source/both), admin credentials (optional), time budget
  2. Preflight: curl base_url. Clone the repo if it is a URL.
  3. Spawn et-sitemapper  -> docs/exploratory/<slug>/site-map.md
  4. Spawn et-explorer    -> findings text; this skill saves docs/exploratory/<slug>/findings.md
  5. Scrub, clean up, print the summary and the path
```

It runs on the main thread because sub-agents can neither ask the user a question nor spawn another agent, and
because hosts refuse report files written by sub-agents. This skill owns the questions, the preflight, the clock,
the hand-off between the two agents and the saving of the findings file. It does no browsing and writes no
finding itself.

`<skill-dir>` below is `.claude/skills/exploratory-testing`. Run every command from the project root.

**The output is a list of unverified candidates.** Nothing in `findings.md` has been reproduced by a human or
checked against a requirement. Say so when you hand it over.

## Where the guardrails live

The limits are not instructions the agents are trusted to follow; they are enforced in
`<skill-dir>/scripts/pw.mjs`, the only way either agent drives the browser:

| Limit | Enforced by `pw.mjs` |
|---|---|
| Same origin only | `open`/`goto`/`click` to another origin is refused; a landing on one (redirect, popup, script) is undone and logged |
| No page twice | normalized URL (fragment dropped, query sorted, trailing slash dropped, `#/route` kept) goes in a visited set; a second `goto` is refused |
| Time budget | every browser command after the deadline is refused, so the report gets written |
| No destructive actions | `click`, and `Enter`/`Space` on a focused control, refused when the name, link target or form action matches delete / remove / pay / purchase / send / buy / checkout / logout / sign out … |
| Credentials | passed as flags on each call, never stored; redacted from output and from every snapshot/console/network file it writes |
| Nothing else | a fixed allow-list of commands; no raw `eval`, no `go-back`, no `state-load` |

## Inputs

| Param | Required | Default | Notes |
|---|---|---|---|
| `mode` | yes | — | `live` (crawl with the browser), `source` (read the router config), `both` (merge; a route in code that the live site does not serve becomes a finding candidate). |
| `base_url` | **yes** | — | Where the running app is. **Never inferred** — not from `.env`, config, a README or memory. |
| `repo` | for `source`, `both` | — | A local path, or an `https://` git URL. A URL is shallow-cloned to a scratch directory and only ever read. |
| `minutes` | no | `20` | Wall-clock budget for the whole run. |
| admin credentials | no | none | Asked for separately, typed in chat. See "Credentials". |
| `slug` | no | from `base_url`, kebab-case, ≤ 40 characters (`localhost-3000`) | Names the output folder and both browser sessions. |

Ask for everything that is missing **in one message**, with the defaults visible. Take values the user already
gave; do not ask again.

If `base_url` is missing, stop and reply exactly:

> `base_url` is required. Example: `/exploratory-testing mode=live base_url=http://localhost:3000`

`mode` is a choice; use `AskUserQuestion` for it if it is the only thing missing. `source`/`both` with no `repo`
-> ask for it. A `repo` that is neither an existing directory nor an `https://` URL -> stop and say so
(`git@…`, `file://`, `ext::` and the like are refused, because cloning them can run code).

### Credentials

Ask once, as a separate, optional question, with this warning shown next to it:

> Admin credentials are optional. Without them, admin and login-gated pages are excluded and listed as such.
> Anything you type here stays in this conversation's transcript and goes to the explorer agent for this run.
> It is never written to a file by this workflow, and it is redacted from tool output and browser files. Use a
> test account, not a real one.

- Held in this session only. Never write them to a file, a todo, a note, a commit message or a command you run
  yourself (the scrub in Step 7 is the one exception, and it is a command line, not a file).
- Both a username and a password, or neither. One without the other -> ask again.
- A value shorter than 3 characters cannot be redacted reliably: ask for a different account.
- The run does not repeat them back to the user, in the summary or anywhere else.

## The run

### 1. Resolve inputs

1. Apply the Inputs table. Stop on a missing `base_url`, an invalid `mode`, a bad `repo`.
2. `slug` from `base_url`: host and port, lowercased, anything outside `a-z0-9` becomes `-`, collapsed,
   trimmed. `out_dir` = `docs/exploratory/<slug>/`. If it already exists and is not empty, use
   `docs/exploratory/<slug>-<yyyymmdd-hhmm>/` instead and tell the user; never overwrite a previous run.
3. Record the start: `node -e "console.log(new Date().toISOString())"` -> `started_at`.

### 2. Preflight

```bash
curl -s -o /dev/null -w "%{http_code}" <base_url>
playwright-cli list
```

- Any status that is not 2xx/3xx: **stop**. Report the status code (or "no response"), write nothing. Never try
  another URL, port or scheme to "make it work".
- `playwright-cli` not found: stop and say so. Browsers already open in other sessions are not yours; leave them.

### 3. Repo (`source`, `both`)

- Local directory: use it as `repo_path`. Read-only; nothing from it is ever run.
- `https://` URL: clone into a **new, empty** scratch directory and remember it as `clone_dir`:

  ```bash
  node -e "const fs=require('fs'),p=require('path'),o=require('os');console.log(fs.mkdtempSync(p.join(o.tmpdir(),'et-repo-')))"
  git clone --depth 1 --single-branch --no-tags -- <repo-url> <clone_dir>
  ```

  Clone fails -> say why in one line, set `mode` to `live`, carry on. Do not retry with another URL.
- The sitemapper reports when it finds no supported router (React Router, Next.js `app/` and `pages/`). That is
  the same fallback: it maps live and says so in its receipt; you tell the user.

### 4. Clock

`budget` = `minutes`. `run_deadline` = `started_at` + `budget` minutes. `map_deadline` = `started_at` +
`max(2, ceil(budget / 4))` minutes. Both as ISO timestamps:

```bash
node -e "console.log(new Date(Date.parse(process.argv[1])+Number(process.argv[2])*60000).toISOString())" <started_at> <minutes>
```

The map gets at most a quarter of the budget; whatever it does not use goes to the explorer, whose deadline is
`run_deadline`. A `source` map opens no browser, so the deadline only binds it if it falls back to a live crawl.

### 5. Site map

Spawn **`et-sitemapper`** (foreground). Prompt: `mode`, `base_url`, `repo_path` (if any), `site_map_path`
(`<out_dir>/site-map.md`), `slug`, `deadline` (= `map_deadline`, always — a `source` run that finds no router falls back to a live crawl), `max_pages` only if the user
set one. **No credentials.**

Read the last line of its answer:

```
SITEMAP_RESULT: OK | BLOCKED | ABORT   pages=<n>   used=<mode>   path=<path>   reason=<phrase>
```

| Result | Do |
|---|---|
| `OK` and `pages` ≥ 1 | Continue. If `used` differs from the `mode` you asked for, tell the user why (`reason`). |
| `OK` and `pages=0` | Stop. An empty map has nothing to explore. Say what the mapper reported. |
| `BLOCKED` / `ABORT` / no receipt | Stop. Report `reason`. Do not retry, do not edit the prompt and re-run. |

### 6. Exploration

Spawn **`et-explorer`** (foreground). Prompt: `site_map_path`, `base_url`, `deadline` (= `run_deadline`),
`findings_path` (`<out_dir>/findings.md`), `slug`, `mode` (= the `used` value from the map receipt),
`started_at`, `budget_minutes`, and — only if supplied — `admin_user` and `admin_pass`, exactly as typed.

The explorer writes no file (hosts refuse report files written by sub-agents). Its answer holds the findings
document between two marker lines, then the receipt as the last line:

```
=== FINDINGS BEGIN ===
…the document…
=== FINDINGS END ===
EXPLORE_RESULT: OK | PARTIAL | BLOCKED | ABORT   findings=<n>   analyzed=<a>/<total>   path=<path>   reason=<phrase>
```

**You save it.** Take everything between the two marker lines, unchanged, and `Write` it to `findings_path`. Do
not edit, reword, reorder or "improve" it. Then check it against the receipt:
the number of `### EX-` headings equals `findings=`. A mismatch is not fixed silently: save the file as received
and tell the user about the mismatch.

- Receipt `OK`/`PARTIAL` but no markers, or an empty document -> nothing to save. Report that the explorer
  returned no document; do not reconstruct one from the receipt.
- `PARTIAL` is a normal outcome (the budget ran out); it is not a failure and it is not retried.
- `BLOCKED`/`ABORT`/no receipt -> report `reason`; the map is still on disk and worth mentioning.

### 7. Wrap-up — on every path, including a failed Step 5 or 6

1. If credentials were supplied: run the scrub as a safety net over everything the run wrote.

   ```bash
   node <skill-dir>/scripts/pw.mjs -s=et-explore-<slug> --admin-user '<user>' --admin-pass '<pass>' scrub <out_dir>/findings.md <out_dir>/site-map.md
   ```

   `scrubbed <file>` in the output means a credential had reached the file and has now been replaced: tell the
   user that, without repeating the value. Skip a file that does not exist.
2. `playwright-cli list`. A browser named `et-map-<slug>` or `et-explore-<slug>` still open -> close it with
   `node <skill-dir>/scripts/pw.mjs -s=<that name> close`. Touch no other session.
3. If you cloned: delete exactly `clone_dir` — verify its path contains `et-repo-` first — and nothing else.
4. Print the summary (below).

### Summary to the user

Short, in this order:

- result (`OK`, `PARTIAL`, or why it stopped) and the budget used;
- pages mapped / analyzed, admin scope explored or excluded (and why);
- potential findings by severity guess (read the run-summary table in `findings.md`; do not recount);
- guardrail blocks, if any (destructive controls skipped, external links not followed);
- the two paths: `<out_dir>/site-map.md`, `<out_dir>/findings.md`;
- one sentence: these are unverified candidates; reproduce one before filing it (`bug-report-formatter` turns a
  confirmed one into a Jira-ready report).

## Hard rules

- `base_url` is given by the user, never guessed.
- Credentials: never in a file, never repeated back, never passed to the sitemapper.
- A preflight failure stops the run. No second URL.
- Never run, install or build anything from the repo being read.
- Never re-spawn an agent to "try again", never widen the budget, never loosen a guard on the user's behalf.
  A refusal from `pw.mjs` is the system working.
- Never present a finding as confirmed.
- Not in scope: filing Jira issues, fixing anything, writing automated tests.
