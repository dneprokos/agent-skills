---
name: jira-bug-creator
description: File a well-formed bug in the SCRUM Jira project from a failed Playwright test, a static-defect-scan finding, or a plain description. Builds the draft with scripts, checks for duplicates, shows a preview for approval, creates the issue over MCP, then prints the created bug. Use when asked to "create a jira bug", "file this failure", "raise a ticket", "log this defect", "open a bug for this test failure", or when a test failure needs tracking.
---

# Jira Bug Creator

Files bugs into **SCRUM** (`dneprokos-test.atlassian.net`) that a stranger can act
on: reproduction steps, the observed status code, and the Defect Detection Phase
set correctly.

Scripts do the parsing, validation and rendering. The Jira write is an MCP call
**you** make — the scripts hold no credentials, on purpose. A script here that
could authenticate to Jira would mean a secret in a tracked file, which is a
defect class this repo already files bugs about.

## The flow

```
draft-bug.js  →  duplicate check (MCP)  →  preview + user approval
              →  createJiraIssue (MCP)  →  render-created.js
```

Never skip the approval step. A Jira issue is outward-facing and awkward to
unmake; a bad parse becomes a real ticket someone has to triage and close.

## 1. Build the draft

```bash
node .claude/skills/jira-bug-creator/scripts/draft-bug.js <source> [options]
```

| Source | Use |
|---|---|
| `--playwright [file]` | a Playwright JSON report — defaults to `test-results/results.json` |
| `--finding <selector>` | a `.static-scan/findings.json` entry, by rule id (`CM-02`), subject (`imageUrl`) or index |
| `--manual` | a plain description; the script then tells you exactly what to ask for |
| `--draft <file>` | reload `.jira-bug/draft.json` to refine it |

| Option | Effect |
|---|---|
| `--list` | show the candidates in the source and stop |
| `--index <n>` | pick one, counted within the **matches** the previous run printed |
| `--base-url <url>` | the environment the test ran against; drives the phase |
| `--env production` | set the phase explicitly instead of inferring it |
| `--set key=value` | set any field; repeatable. `\n` becomes a newline |
| `--set steps+=text` | append one step. Same for `labels+=` |
| `--json` | the draft, the missing list and the ready-made MCP payload |

Exit codes: **0** ready · **2** something required is missing or invalid · **1**
the input could not be read.

The script writes `.jira-bug/draft.json` (gitignored) and prints the description
exactly as Jira will render it.

## 2. When fields are missing — ask, do not invent

On exit 2 the script prints a `MISSING` block naming each field and the question
to ask:

```
MISSING — ask the user for each of these, then re-run with --set:
  · summary: A one-line summary: what breaks, not which rule fired.
  · steps: Steps to Reproduce: numbered, each one action.
```

Ask the user those questions — `AskUserQuestion` for anything with a small set of
sensible answers (phase, priority), plain questions for free text. Then re-run
with `--draft .jira-bug/draft.json --set …`.

**Never fill a required field with a guess.** A fabricated reproduction is worse
than an incomplete ticket, because the next person spends an hour failing to
reproduce it. The one exception is a field the script itself marked `INFERRED` —
those are stated assumptions, printed for the user to correct.

## 3. Check for duplicates

The script prints a ready JQL query. Run it:

```
mcp__atlassian__searchJiraIssuesUsingJql
  cloudId: <config.cloudId>
  jql:     <the printed query>
  fields:  ["summary", "status", "customfield_10203"]
```

If anything comes back, show the user the candidates and ask: **create anyway**,
**comment on the existing issue** (`addCommentToJiraIssue`), or **abort**. Do not
decide this alone — whether two symptoms are one defect is a judgement about the
product, not about the text.

## 4. Preview and approve

Show the user the preview the script printed — summary, phase, priority, labels,
and the full description. Call out anything under `INFERRED`. Get a yes.

## 5. Create

Use the payload from `--json` (`createPayload`), or assemble it:

```
mcp__atlassian__createJiraIssue
  cloudId:       66b3ea22-1466-4c68-afca-75d07051091c
  projectKey:    SCRUM
  issueTypeName: Bug
  summary:       <draft.summary>
  contentFormat: markdown
  description:   <the rendered description>
  additional_fields: {
    "customfield_10203": { "value": "Production" | "Development" },
    "priority": { "name": "High" },
    "labels": [ … ]
  }
```

`customfield_10203` is **Defect Detection Phase** and it is **required**. It
defaults to `Development`, so a Production bug filed without it is silently
mislabelled — always set it explicitly.

## 6. Print the result

```bash
node .claude/skills/jira-bug-creator/scripts/render-created.js --key SCRUM-179 \
  [--duplicate-of SCRUM-167] [--archive]
```

Renders `assets/created-bug.template.md` — key, link, every field, the steps, and
a reminder of anything inferred. `--archive` keeps a copy at
`.jira-bug/<KEY>.json`.

Show that block to the user as the final answer.

## Choosing the phase

`Production` means found in live use, by a person or a monitor, against a
deployed environment. `Development` means found before release — by a test run,
a code review or a scan.

The script infers it and flags the inference:

| Source | Inferred | Why |
|---|---|---|
| Playwright against `localhost` | Development | a pre-release run |
| Playwright against any other host | Production | a run against a deployed environment |
| static-defect-scan finding | Development | found by reading code, never by a user |
| manual | *asked* | only the reporter knows where they saw it |

`--env production` or `--env development` overrides it, and an explicit value is
not flagged as inferred.

A Production bug reads differently from a Development one, and should. Production
describes a business outcome — *"the Owner cannot onboard an admin on a
`.technology` address"*. Development describes a code-level contract — *"the
route validator is looser than the schema"*. Same defect, different reader, so
lead with what that reader needs.

## Writing the summary

Say what breaks, not which rule fired or which test failed:

- **Good** — `Cover image URL with no file extension fails with "Server error"`
- **Bad** — `CM-02 on Game.imageUrl`
- **Bad** — `search.spec.js:42 failing`

An auto-drafted summary from a Playwright failure reads
`<spec title> — expected 3, received 12`. That is a starting point. Rewrite it in
product terms before filing if you can see what the assertion means.

## Description template

Fixed by `assets/bug-description.template.md`, matching the template the SCRUM
Bug issue type already defines:

**Version** · **Initial Condition** · **Steps to Reproduce** · **Expected
Results** · **Actual Results** · *Evidence* · *Root cause* · **Affected Tests**

Evidence and Root cause appear only when supplied. Keep steps numbered and one
action each, and put a runnable `curl` or `npx playwright test` command in them
wherever an API or a spec is involved.

## Configuration

Everything Jira-specific is in `config.json` — cloud id, project key, issue type,
the custom field id and its allowed values, the severity→priority map, the
per-source labels, and the duplicate-search tuning. Changing project means
editing that file, not the scripts.

## Tests

```bash
node --test .claude/skills/jira-bug-creator/scripts/bug.test.js
```

61 tests on the Node built-in runner, no dependency, all against synthetic
fixtures — no live report, no live findings file, no Jira. Add a case whenever
you touch a parser or the field contract.

## Troubleshooting

**"No failed specs in …"** — the report records a passing run. Re-run the suite,
or use `--manual` if you are filing something the suite did not catch.

**Several failures, one root cause** — file one bug and list the others in
Affected Tests. Do not file five tickets for one broken selector.

**`--index` picked the wrong finding** — the index counts within the *matches*
of your selector, which is the list the previous run printed. Drop the selector
to index the whole file.

**Jira rejects the create call** — most often a label containing a space, or a
phase value that is not exactly `Development` or `Production`. The script catches
both; if you hand-assembled the payload instead, it will not.

**The duplicate search returns nothing for an obvious duplicate** — it searches
distinctive words from the summary's subject half over the last 180 days. Widen
it by hand, or search on the rule-id label.

## These scripts are also driven headlessly

`scripts/draft-bug.js` and `scripts/lib.js` are consumed by the Slack bug-triage
workflow as libraries, without this file. That is structural rather than a
loophole: no agent in this repository has `Skill` in its `tools:` list, so a
subagent cannot reach these instructions at all. The approval rule above governs
a human running this skill; an automated caller carries its own gate, and the
triage workflow's default mode asks per bug exactly as step 4 does.

Two consequences worth knowing:

- **`.jira-bug/draft.json` is one fixed path, overwritten on every run.** A caller
  filing several bugs copies it out after each build, in the same command. Do not
  run this skill by hand while a triage run is in flight — the two clobber each
  other and the second bug is filed with the first bug's steps.
- **A headless caller supplies every field.** `--manual` with a complete `--set`
  set exits 0 and emits a ready `createPayload`; exit 2 and its `MISSING` block are
  how that caller detects a report it cannot file yet.
