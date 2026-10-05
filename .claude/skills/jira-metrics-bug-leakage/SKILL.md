---
name: jira-metrics-bug-leakage
description: Measure defect leakage — the share of bugs found in production rather than before release — from the Defect Detection Phase field in Jira. Produces a terminal summary, a markdown report and a shareable dashboard, broken down by month, priority and area, with the escaped defects still open. Use when asked about "bug leakage", "defect leakage", "escaped defects", "containment rate", "defect detection effectiveness", "how many bugs reached production", or for a QA metrics review.
---

# Bug Leakage

**Leakage** is the share of defects found in production rather than before
release. In this project it is read off one field:

| `Defect Detection Phase` | Meaning |
|---|---|
| `Production` | the defect **escaped** — a person or a monitor found it in live use |
| `Development` | the defect was **caught** — a test, a review or a scan found it first |
| unset | counted on **neither** side, and reported as a data-quality problem |

`leakage = escaped ÷ classified` · `containment = 1 − leakage`

Scripts do the maths and the rendering; the Jira read is an MCP call **you**
make. No credentials live in a tracked script.

## The flow

```
leakage.js --jql   →   searchJiraIssuesUsingJql (MCP)   →   write issues.json
                   →   leakage.js                       →   report + terminal
                   →   build-dashboard.js               →   Artifact publish
```

### 1. Get the query

```bash
node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js --jql
```

Prints the cloud id, the JQL and the exact field list. The field list matters:
without `created` there is no trend, without `resolutiondate` there is no
time-to-fix, without the phase custom field there is no metric at all.

### 2. Fetch and save

Run `mcp__atlassian__searchJiraIssuesUsingJql` with those arguments, then write
the result to `.bug-leakage/issues.json` as:

```json
{ "fetchedAt": "<iso>", "jql": "<the query>", "issues": [ … ] }
```

The raw Jira issue shape is what the parser expects — `{key, fields: {...}}` —
so paste the `issues` array through unchanged. Page with `nextPageToken` if the
project has more than 100 bugs and concatenate before writing.

### 3. Report

```bash
node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js                       # terminal summary + markdown report
node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js --since 90         # only the last 90 days
node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js --as-of 2026-08-21T12:00:00Z   # pin the clock
node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js --json             # metrics.json to stdout
```

Writes `.bug-leakage/metrics.json` and `.bug-leakage/leakage-report.md`, both
gitignored.

### 4. Dashboard

```bash
node .claude/skills/jira-metrics-bug-leakage/scripts/build-dashboard.js
```

Renders `.bug-leakage/dashboard.html` from `metrics.json` — the same numbers as
the report, so the two can never disagree. Publish it with the Artifact tool:

```
Artifact  file_path: .bug-leakage/dashboard.html
          title: "<PROJECT> Bug Leakage"
          favicon: "🕳️"
          description: "<one sentence naming the current rate>"
```

Artifacts start private. Give the user the link and let them decide who sees it
— a leakage number is a statement about a team's testing, and that is theirs to
share.

To update later, publish the same file path again, or pass the existing `url`.

## What it computes

| Metric | Meaning |
|---|---|
| **Leakage rate** | escaped ÷ classified |
| **Containment rate** | its complement — the headline for a "how are we doing" review |
| **Severity-weighted leakage** | weighted by priority (Highest 5 … Lowest 1), because one escaped Highest is not one escaped Low |
| **By month** | leakage per month the defect was raised; suppressed below two months |
| **By priority** | whether what escapes is the serious end |
| **By area** | which part of the product leaks, from the area labels |
| **Open in production** | escaped defects not yet resolved, with age; median days-to-fix for the resolved ones |
| **Unclassified** | defects with no phase set, excluded from every rate and listed |

Compare the raw and the weighted rate. When weighted is higher, the defects that
escape are the serious ones and the headline understates the problem.

## Reading it honestly

Say these out loud when you present the number — they are in the report and the
dashboard because leaving them out makes the metric misleading:

- **It measures where a defect was found, not where it was introduced.** A defect
  written a year ago and reported today counts against today.
- **The field is filled in by hand.** A falling leakage rate can mean testing
  improved, or that nobody set the field on the last production report. Always
  read it beside the unclassified count.
- **Small samples are not percentages.** Below the configured minimum (20) the
  report says so and prints how far one more defect would move the headline.
  At 12 classified defects, one more moves it by nearly 8 points.
- **A bug counts once per area**, under the first area label in config order.
  Counting it in every matching area would make the totals exceed the bug count.
- **Leakage is not a person's score.** It measures a process — where the net has
  holes — and using it to rank individuals reliably produces a project where
  nobody sets the field to `Production`.

## Configuration

`config.json` holds everything project-specific: cloud id, project key, the
phase field id and its two values, the priority weights, the area-label
taxonomy, and the targets (`leakageRate` 20%, `warnAt` 30%,
`minSampleForTrend` 20). Retargeting means editing that file, not the scripts.

## The dashboard's design

Two colours carry meaning and nothing else does: escaped is status red
`#d03b3b`, caught is blue `#2a78d6` (light) / `#3987e5` (dark). Green was the
obvious first choice for "caught" and was rejected — the validator measured
green↔red at CVD ΔE 4.1, indistinguishable for the commonest form of colour
blindness. Blue↔red measures 23.8 and passes every gate in both themes. Every
proportion is also labelled with its counts, so no reading depends on hue.

If you change those colours, re-run the check rather than eyeballing it:

```bash
node <dataviz-skill>/scripts/validate_palette.js "#2a78d6,#d03b3b" --mode light --surface "#fcfcfb"
```

## Tests

```bash
node --test .claude/skills/jira-metrics-bug-leakage/scripts/leakage.test.js
```

62 tests on the Node built-in runner, no dependency, all against hand-built
exports with a pinned clock — never the live project. A test asserting "leakage
is 41.7%" would fail the moment someone files a bug, which measures the project
rather than the code.

## Troubleshooting

**"No export at .bug-leakage/issues.json"** — step 2 has not run. `--jql` prints
what to fetch.

**Every defect is unclassified** — the export omitted the custom field, or the
project uses a different field id. Check `config.json` against
`getJiraIssueTypeMetaWithFields`.

**The rate looks too good** — check the unclassified count first. Ten defects
with no phase set and two classified gives a confident-looking rate built on two
data points.

**No trend** — fewer than two months of classified defects. The section says so
rather than drawing a line through one point.

**Areas are all "(no area label)"** — the bugs carry labels that are not in
`config.areaLabels`. Add them, or file bugs with the taxonomy the config knows.
