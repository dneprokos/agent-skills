# findings.md — template

The explorer's output, returned as text and saved by the skill. Path: `docs/exploratory/<slug>/findings.md`. Copy this skeleton, fill it, keep the
four numbered sections in this order.

**Findings are unverified candidates, not confirmed defects.** Say so in the file; the header block below does.

```markdown
# Exploratory testing findings — <base_url>

> Potential findings from one time-boxed exploratory session. Each is an unverified candidate: reproduce it
> before filing. Nothing here was confirmed against requirements.

## 1. Run summary

| | |
|---|---|
| URL | <base_url> |
| Mode | <requested> (map built from: <mode_used>) |
| Started | <ISO timestamp> |
| Duration | <mm:ss> of <budget> min budget |
| Result | OK / PARTIAL — <why> |
| Pages mapped | <n> |
| Pages analyzed | <n> |
| Potential findings | <n> (critical <a>, major <b>, minor <c>, trivial <d>) |
| Admin scope | explored / excluded — <reason> |
| Guardrail blocks | <n> (see section 3) |

## 2. Coverage

| Page | URL | Status | Notes |
|---|---|---|---|
| P01 | / | analyzed | |
| P05 | /admin | excluded | admin without credentials |
| P09 | /products/:id | skipped | pattern, not navigable |
| P11 | /reports | skipped | deadline reached |
| — | https://example.org/ | external | not followed (linked from P01) |

Status is exactly one of: `analyzed`, `skipped`, `external`, `excluded`.

**Not covered at the deadline:** <P-ids, or "none">.

## 3. Excluded scenarios

### 3a. Scope excluded

| Scope | Reason |
|---|---|
| Admin pages (P05, P06) | No admin credentials supplied. |
| Admin pages (P05, P06) | Credentials rejected by the login form. |

`—` row if nothing was excluded.

### 3b. Actions blocked by guardrails

One row per distinct entry of `pw.mjs blocked`, grouped by reason (`destructive`, `off-origin`, `already-visited`,
`scheme`).

| Reason | Page | What was blocked |
|---|---|---|
| destructive | P03 | Button "Delete Widget" — name matches `delete` |

`—` row if nothing was blocked.

## 4. Potential findings

### EX-001 — <one-line title, symptom first>

| | |
|---|---|
| Page | P03 `/products` |
| Severity guess | critical / major / minor / trivial |
| Category | functional / validation / console / network / link / accessibility / layout / keyboard / content |
| Confidence | high / medium / low |

**Steps**
1. Open `/products`.
2. …

**Expected:** <what a user would reasonably expect>
**Actual:** <what happened>

**Why it is a problem:** <who is affected and how, and which oracle or standard this breaks; say what is inferred rather than observed>

**Evidence**
- Console: `[ERROR] Failed to load resource: the server responded with a status of 404 (Not Found) @ http://…/p.png:0`
- Network: `[GET] http://…/p.png => [404] Not Found`
- Snapshot: `.playwright-cli/page-….yml` line <n> — `img [ref=e17]` has no accessible name
```

## Rules

- **IDs** are `EX-001`, `EX-002`, … in the order found. A code-only route from the site map's
  `## Finding candidates` becomes a finding with confidence `low` and category `functional`, steps =
  "request the URL", and the map's note as the actual result.
- **Severity guess** is the explorer's guess from user impact, not a triage decision:
  `critical` — the page is unusable or data/security exposure is plausible; `major` — a feature is broken or a
  required path blocked; `minor` — wrong behaviour with a workaround, or a clear accessibility failure;
  `trivial` — cosmetic, copy, hygiene.
- **Confidence**: `high` — seen twice or the evidence is unambiguous (HTTP 4xx/5xx, uncaught console error, empty
  accessible name); `medium` — seen once, plausible oracle; `low` — a judgement call or a single observation
  without an oracle.
- **Evidence is quoted, not described.** Copy the console or network line exactly. Snapshot files under
  `.playwright-cli/` are scratch (gitignored) — cite them as a pointer, and quote the relevant line.
- **"Why it is a problem" is mandatory.** Two to four sentences, in this order: (1) who is hurt and what they
  cannot do or what risk they carry (user, business, security, accessibility); (2) the oracle or standard it
  breaks, named (`WCAG 4.1.2`, consistency with sibling pages, platform error, convention); (3) anything in the
  reasoning that is a guess about cause or intent, marked as such (`likely`, `not verified`). If you cannot name
  an affected person and a broken oracle, it is not a finding. If the honest reason is "probably expected
  behaviour, noted for completeness", say exactly that and keep confidence `low`.
- **One finding per root cause.** The same broken image on six pages is one finding listing the pages.
- **Credentials never appear**, not in steps, not in evidence. Use `<ADMIN_USER>` and `<ADMIN_PASS>`.
- **Steps are reproducible** by someone who has only this file and the URL. Name controls by their accessible
  name (`button "Search"`), never by snapshot ref (`e17`).
- **No requirements claims.** "Expected" is what a reasonable user expects; never cite a requirement that was
  not read.
