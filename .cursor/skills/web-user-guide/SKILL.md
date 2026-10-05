---
name: web-user-guide
description: Writes an end-user guide for a web page as a Markdown file with screenshots, by driving the real page with playwright-cli through a scenario described in plain words. Screenshots are taken only when the screen actually changes — a navigation, a dialog opening or closing, an alert appearing, a large content change — and several small actions on one screen (filling a form) share one screenshot taken after the last of them. Credentials are passed as environment variable names, never shown in the guide, the transcript or the images. Use whenever someone asks for a user guide, how-to, walkthrough, step-by-step instructions, onboarding doc, help page or "document how to do X" for a web app or page, even if they don't mention screenshots or Playwright. Invoked as /web-user-guide base_url=<url> "<scenario>".
allowed-tools: Bash(node:*), Bash(curl:*), Bash(playwright-cli list), Bash(sed:*), Read, Write, Glob
---

# Web user guide

Turn a scenario written in plain words into a guide a product user can follow: numbered steps in their
language, with a screenshot wherever the screen visibly changed and nowhere else.

The whole value of the skill is the screenshot discipline. A guide with an image under every click is
noise — ten near-identical pictures of the same form, each with one more character typed. A reader needs
one picture per *screen they will recognise*: the page they land on, the form as it looks once filled in,
the dialog that pops up, the result. So the decision of when to shoot is made by rules and a script, not
by feel, and it is made at the moments the screen can have changed.

`<skill-dir>` below means this skill's base directory (shown when the skill loads; in this repository
`.claude/skills/web-user-guide`). Run every command from the project root.

## Inputs

| Param | Required | Default | Notes |
|---|---|---|---|
| `base_url` | **yes** | — | Where the scenario starts. Never inferred — not from `.env`, not from config, not from memory. |
| scenario | **yes** | — | Free text: "log in as owner and add a new admin". |
| `slug` | no | from the scenario, kebab-case, ≤ 5 words (`add-new-admin`) | Names the output folder and the browser session. |
| `out_dir` | no | `docs/user-guides/<slug>/` | Guide goes to `<out_dir>/guide.md`, images to `<out_dir>/images/`. |
| `credentials` | no | — | Comma-separated env var **names**, e.g. `OWNER_EMAIL,OWNER_PASSWORD`. Literal values are refused. |
| `diff_threshold` | no | `0.25` | Share of the page that must change for a screenshot when no structural signal fired. |
| `max_screenshots` | no | `15` | After this, only navigation and structural changes still shoot. |
| `overwrite` | no | `false` | Allows writing into an `out_dir` that already has content. |

**If `base_url` is missing, stop before doing anything else** and reply with exactly:

> `base_url` is required. Example: `/web-user-guide base_url=http://localhost:9000 "log in as owner and add a new admin"`

Do the same for a missing scenario (`A scenario is required: describe what the guide should show.`).
Guessing a URL would produce a confident guide for an app nobody asked about.

If `credentials` holds anything that is not an env var name (it contains `@`, spaces, or lower-case
letters), stop and ask for the variable names instead — a literal secret typed into the conversation is
already leaked, and repeating it into commands makes it worse.

## Why everything goes through `pw.mjs`

`playwright-cli` echoes the code it ran — `fill('someone@company.com')` — and its snapshot files record
typed text. Called directly, a login step would put the real email into the transcript and onto disk.
`<skill-dir>/scripts/pw.mjs` sits in front of it:

- `{{ENV_NAME}}` in any argument is replaced by that variable's value (process env first, then `./.env`).
  The value never appears in the command you write.
- Every value it has substituted in this session is replaced by `<ENV_NAME>` in the output you read and in
  every snapshot file written. Pass `--secrets A,B` on the first call to register names up front.
- `{{GEN_<NAME>}}` (e.g. `{{GEN_PASSWORD}}`) is a secret the run *invents* — the password of a demo user
  the scenario creates. It is generated once per session, reused on every later `{{GEN_PASSWORD}}`, and
  redacted the same way. A made-up password typed as a literal would sit in plain text in every snapshot
  file after it; this way nobody, you included, ever sees it — and nobody needs to, because cleanup goes
  by the email.
- `shot <png>` blurs identity fields (email/username inputs, any element showing a secret value), takes the
  screenshot, and saves the page as the **baseline** for the next comparison.
- `check` snapshots the page and prints a JSON verdict against the baseline (details below).

So: **never call `playwright-cli` directly except `playwright-cli list`**, and never read `.env` in a way
that prints values. To learn which variable names exist, list names only:
`sed -n 's/^\([A-Za-z_][A-Za-z0-9_]*\)=.*/\1/p' .env`.

Every call takes `-s=wug-<slug>`. A named session keeps parallel runs apart and scopes the state folder
(`.playwright-cli/web-user-guide/wug-<slug>/`).

```bash
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin --secrets OWNER_EMAIL,OWNER_PASSWORD open http://localhost:9000/
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin fill e32 "{{OWNER_EMAIL}}"
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin click e44
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin check
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin shot docs/user-guides/add-new-admin/images/02-owner-dashboard.png
node <skill-dir>/scripts/pw.mjs -s=wug-add-new-admin close
```

Every other `playwright-cli` command (`goto`, `snapshot`, `click`, `fill`, `select`, `uncheck`, `press`, `hover`, `dialog-accept`, `tab-list`, …) passes through unchanged. Refs like
`e32` come from the latest snapshot. Every pass-through command prints a link to the snapshot it took
(already redacted) — read that; or run a pass-through `snapshot` when you need refs between shot points.
Refs change on every re-render, so take them from the newest snapshot, and never write one into the guide.

> `check e12` (with a ref) still ticks a checkbox; bare `check` is the wrapper's verdict.

## The run

### 1. Preflight

```bash
curl -s -o /dev/null -w "%{http_code}" <base_url>
```

Anything but 2xx/3xx: stop, report the status, write nothing. If `<out_dir>` already exists and is not
empty and `overwrite` is not `true`, stop and report `EXISTS: <out_dir>` — a guide someone may have edited
by hand is not yours to replace silently.

### 2. Plan the steps

Rewrite the scenario as a numbered list of user intents ("Open the login page", "Sign in as the owner",
"Open the admin section", "Add an admin with a new email"). Print it and carry on — this is the guide's
skeleton, not a question. If the scenario needs a login and no `credentials` were given, look up variable
names (names only, as above) that plausibly match the role; if none match, stop and ask for them.

Data the scenario must invent (a new admin's email) should be obviously synthetic and unique:
`guide-demo-<yyyymmddhhmm>@example.com`, with passwords as `{{GEN_PASSWORD}}`. Note anything you created
in the receipt (identifiers only, never a password), so it can be cleaned up.

### 3. Open

`open <base_url>` on a named session, with `--secrets` if you have credentials.

### 4. Walk the scenario in groups

Split the actions into **input actions** and **commit actions**:

- *Input:* `fill`, `type`, `select`, ticking a box, choosing a radio, and clicks that only open a dropdown or
  focus a field. They change what is in the form, not which screen the reader is on.
- *Commit:* anything that submits, navigates, opens or closes a dialog or panel, or otherwise produces a
  result — `click` on a button or link, `press Enter` in a form, `goto`, `dialog-accept`.

A **shot point** is the moment right before each commit action, plus the end of the scenario. At every
shot point run `check`, and shoot if it says so. Between shot points, do not check and do not shoot.

This is what makes several actions share one picture. Clicking **Login** on the home page navigates to
the login form; you do not shoot there, because the next actions fill that form. The shot point is just
before the form is submitted, so the one picture shows the form filled in — the thing the reader needs to
match. The navigation is not lost: `check` still sees it against the baseline, because the baseline is
the *last screenshot*, not the last action.

### 5. Read the verdict

`check` prints one JSON line:

```json
{"shoot":true,"reason":"navigation:/login->/owner","changeRatio":0.91,"added":40,"removed":22,"signals":["heading:changed"],"navigated":true,"url":"http://localhost:9000/owner"}
```

| `reason` | Meaning | Shoot? |
|---|---|---|
| `no-baseline` | first shot point of the run | yes — the reader's starting screen |
| `navigation:<from>-><to>` | path changed since the last screenshot | yes |
| `structural:dialog:appeared` / `…:closed`, `alertdialog`, `alert`, `status` | an overlay or message came or went | yes |
| `structural:heading:changed` | the page's level-1/2 heading changed: a new screen on the same URL | yes |
| `ratio:<n>` | no signal, but at least `diff_threshold` of the page changed | yes |
| `below-threshold` | small change — a typed value, a toggled icon | no |
| `identical` | nothing changed | no |

When it says shoot:

```bash
node <skill-dir>/scripts/pw.mjs -s=wug-<slug> shot <out_dir>/images/NN-<what-it-shows>.png
```

`NN` is a two-digit running number; the name says what the reader sees (`03-add-admin-dialog.png`), not
what you did. Shooting resets the baseline, which is the point: the next `check` measures against what the
reader last saw.

`shot` also frames the picture from the last verdict, because a single-page app keeps its scroll position
across a route change and a click near the bottom of a form leaves the page scrolled there — without
framing, "the new screen" is photographed from its middle and a success message at the top is out of
frame:

| Last verdict | Framing |
|---|---|
| a signal `<role>:appeared` (`status`, `alert`, `dialog`, `alertdialog`) | scroll that element into view — it is what the step produced |
| a field you just filled still has focus | frame its form whole — centred if it fits, from its top if not — so the submit button is in the picture. This beats the rows below: an inline "Add …" panel arrives with a new heading, and the form is still the subject |
| any `navigation:`, or the signal `heading:changed`, with no focused form | scroll to top — the reader arrives at the top of a new screen |
| anything else | leave the scroll alone |

It prints the framing it used (`"framing":"top"`). Override when the result is somewhere else: `--top`,
`--keep-scroll`, or add `--full-page` for a screen whose point is its whole length (a long results list).
Always look at the picture afterwards; if the thing the step is about is not in it, re-shoot with an
override rather than caption around the gap.

**Before the first shot, look at the snapshot.** If it shows a spinner, skeleton, or an empty region where
the result will land, the page is still loading: run `check` once more before shooting. One retry, not a
loop — if it is still loading, shoot and say so in the receipt.

**At the end of the scenario** run `check` once more and shoot unless the reason is `identical` — the final
result is the one screen every guide needs, even when it differs only a little from the last picture.

**At the cap** (`max_screenshots`), keep shooting only `navigation:` and `structural:` verdicts, and record
in the receipt which `ratio:` shots were skipped.

### 6. Things a screenshot cannot hold

- **Native browser dialogs** (`window.confirm`, `alert`, `prompt`) are drawn by the browser, not the page;
  the screenshot will not show them. When a commit action raises one, answer it with `dialog-accept` or
  `dialog-dismiss` and describe it in the guide in words.
- **A new tab**: if a click opens one, `tab-list`, `tab-select` it, then treat the next shot point as a
  navigation (shoot).
- **Hover-only UI** (a tooltip, a hover menu) disappears when the next action runs; if the scenario is about
  it, `hover`, then `shot` immediately — that is the one case where you shoot without a commit.

### 7. Close

`close` on the session **on every path** — success, blocked, error — then `playwright-cli list` must print
`(no browsers)`. `close` through the wrapper also deletes its state folder.

### 8. Write the guide

Read `<skill-dir>/references/guide-template.md` and write `<out_dir>/guide.md` in that shape. The steps
are the planned intents from step 2, merged or split to match the screenshots you actually took; each
image goes under the step that produced its screen. Describe controls by their visible label, in bold. Say
"your email address", never a value or a variable name.

Everything in the guide is something this run saw. A Troubleshooting entry, a tip or a "you can also…"
that was not observed is invention wearing the guide's authority — a reader will trust it exactly as much
as the steps that were real. Leave optional sections out rather than fill them from what seems likely.

Look at each screenshot before you caption it. The caption describes what is in the picture; if the
picture does not show what the step promised (still loading, an error), the guide must say what really
happened, not what the scenario hoped for.

**If a step cannot be done** — no matching control, an error the scenario did not expect, a page that never
loads — do not improvise a different route to the goal. Close the session, then write the guide up to that
point with the `Blocked at step N` callout from the template. A half guide that says where it stopped is
useful; a complete one that quietly documents a different workflow is not.

### 9. Receipt

End with this block, in chat:

```
GUIDE: <out_dir>/guide.md
SCREENSHOTS: <n> (cap <max_screenshots>)
  01-<name>.png  <reason from check>
  02-<name>.png  <reason>
SKIPPED_SHOT_POINTS: <n> (<reasons, e.g. 3 below-threshold, 1 identical>)
BLOCKED: none | step <N> — <why>
DATA_CREATED: none | <what, e.g. admin guide-demo-202609261830@example.com>
SESSION: closed (playwright-cli list: no browsers)
```

`DATA_CREATED` matters: a guide run on a real app leaves real records behind, and the person who asked
for the guide is the one who has to decide whether to delete them.

## Must not

- Start without `base_url`, or take one from `.env`, config or earlier conversation.
- Call `playwright-cli` directly for anything but `list`, or print `.env` values in any form.
- Put a credential value, an env var name, a snapshot ref (`e12`) or a CSS selector into the guide.
- Shoot after every action, or shoot at a shot point whose verdict was `below-threshold` or `identical`
  (the final shot is the one exception, as described).
- Leave the browser session open on any exit path.
- Write outside `<out_dir>`; the wrapper's state under `.playwright-cli/` is the only other thing touched.
- Describe what the scenario said should happen instead of what the screenshot shows.
