# Exploratory heuristics

What the explorer does on each page, in what order, and what counts as a problem. Every check is a
read-only observation or a harmless input. The guardrails in `scripts/pw.mjs` still apply to all of it.

## Per-page routine

Spend roughly an equal share of the remaining time on each remaining page; do not sink more than a quarter of
the budget into one.

1. **Land.** `goto <url>`. Read the `PW {…}` line: `status` ≥ 400 on a page the map says exists is a finding;
   `redirected: true` to a login page confirms `requires`.
2. **Read.** `snapshot`, then read the snapshot file it names. Note the heading, landmarks, controls, forms.
3. **Errors.** `console` and `network`; read both files they name. Every `[ERROR]` line, every uncaught
   exception, every `=> [4xx]` / `=> [5xx]` is a candidate. A 404 for `/favicon.ico` is `trivial`, not `minor`.
4. **Audit.** `audit` once. Each non-empty list is a candidate (see "Reading the audit" below).
5. **Links.** `links`. A same-origin link the map lists that answers ≥ 400 is a `link` finding. Do not open
   links just to check them — the map already carries their status. Off-origin links are `external`, never opened.
6. **Forms.** Exercise each form, see "Forms" below.
7. **Keyboard.** `press Tab` eight to twelve times, `snapshot` after a few. Look for: focus that never moves,
   focus that disappears (no element marked `[active]`), a control reachable by mouse but never by Tab, a trap
   (Tab cycles inside a region with no way out and no dialog open), `Escape` not closing an open dialog.
8. **Responsive.** `resize 375 812`, `audit` (read `horizontalOverflow`), `snapshot` (is the main navigation
   still reachable?), then `resize 1280 800`. Do this on the first page and on any page with a table, a wide
   form or a different layout.
9. **Record.** Add findings now, while the evidence is fresh. Update the coverage row.

## Reading the audit

| Field | Candidate when | Category | Typical severity |
|---|---|---|---|
| `brokenImages` | non-empty | content | minor |
| `imagesWithoutAlt` | non-empty (decorative images need `alt=""`, which is not `null`) | accessibility | minor |
| `inputsWithoutLabel` | non-empty | accessibility | minor |
| `buttonsWithoutName`, `linksWithoutName` | non-empty | accessibility | minor |
| `deadLinks` | non-empty (`href="#"` or no `href`) | link | minor |
| `h1Count` | 0 or > 1 | accessibility | trivial |
| `headingLevelsSkipped` | true | accessibility | trivial |
| `lang` | null | accessibility | trivial |
| `viewportMeta` | false | layout | minor if the 375 px check also overflows, else trivial |
| `duplicateIds` | non-empty | functional | minor |
| `positiveTabindex` | > 0 | keyboard | trivial |
| `horizontalOverflow` | true at 375 px | layout | minor |
| `title` | empty, or identical on every page | content | trivial |

## Forms

For each form in the map or the audit, in this order, stopping at the first thing that submits real data:

1. **Empty submit** — focus the first field and `press Enter` with nothing typed. Required fields should be
   refused with a visible, specific message that names the field.
2. **Invalid values** — one field at a time: malformed email (`a@`, `a b@c.d`), letters in a numeric field,
   a date in the wrong shape, a value that breaks `pattern`.
3. **Boundaries** — one character over `maxlength` (the field should stop it or say so); the `min`/`max` the
   audit reported, one below and one above; a single space; leading and trailing spaces.
4. **Odd text** — non-ASCII (`Zoë Ünal`), a long unbroken string (200 characters), and markup-looking text
   (`<b>x</b>` and `"quotes"`): it must come back escaped, never rendered.
5. **Recovery** — after a refusal, are the other fields still filled? Is the focus on the first invalid field?
   Is the message tied to its field (read through the snapshot, not by position)?

A search or filter form is safe to run to completion with plain words, an empty string and a no-match string.
Observe: result count, empty-state message, the URL (is the query reflected, is it shareable).

**What this routine never does:**
- Submit a *valid* state-changing form — sign-up, contact, comment, checkout, profile save, create/edit. Empty
  and invalid submits are fine; a valid one writes data. Record it in the coverage notes: `valid submit not exercised`.
- Press a control the guardrail refuses. A refusal is information, not an obstacle: it appears in section 3b.
- Submit the real admin username with a wrong password. A rejected-login check uses a made-up account
  (`qa-invalid-user@example.invalid`), so a lockout policy cannot lock the real one.

## Login (only when admin credentials were supplied)

1. On the login page, first run the page routine with no credentials — empty submit and the made-up account.
2. Fill the real credentials with `{{ADMIN_USER}}` / `{{ADMIN_PASS}}` — never the literal values in an argument
   you write — and submit.
3. Success is a navigation away from the login page, or a control that was absent before. Failure (the form
   comes back, an error shows) means `credentials rejected`: exclude the admin scope, do **not** retry, continue
   with the public pages.
4. Logged in, the map's `auth` and `admin` pages become reachable. Walk them like any other page.
5. There is no logout. `Logout` / `Sign out` is refused by the guardrail; the session simply ends at the close.

## What counts as a problem — oracles

Name the oracle in the finding's *Expected*. Use these, strongest first:

| Oracle | Example |
|---|---|
| The platform | HTTP 5xx; uncaught exception in the console; a blank page; a navigation that never settles |
| The page against itself | A link that leads to an error; a heading that does not match the title; a count that does not match the list |
| Consistency | The same control labelled or behaving differently on two pages |
| Standards | Missing label/alt/lang; focus lost; contrast is **not** measurable here, so never claim it |
| Convention | A form that loses the user's input on error; a page with no way back |
| The map | A route the code declares that the live site does not serve |

Every finding must say why it is a problem: the person affected and the oracle broken (see the template). A difference you merely dislike is not a finding. A behaviour you cannot explain either way is `low` confidence,
and only worth writing if a user would be affected.

## Severity and noise

- Collapse duplicates: one finding per root cause, listing every page it appears on.
- A third-party failure on the base origin's own page (a blocked analytics script) is `trivial`, and only if
  the console shows it.
- Never report what you did not observe in this session. A hunch goes in `notes` of the coverage row, not in
  the findings.
