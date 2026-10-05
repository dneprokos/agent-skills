/**
 * Tests for scripts/slack-triage-journal.mjs.
 *
 * Same shape as the workflow-state suite: the subject is a CLI, so every case spawns it and asserts on
 * the exit code and the `ST-E<nn>` codes it printed.
 *
 *   node --test scripts/__tests__/            (or: npm run test:scripts)
 *
 * The cases that matter most are the ones nobody can check by reading the channel. `plan` decides which
 * Slack messages get triaged, and every way it can be wrong is expensive in a direction a human notices
 * late: a message excluded forever, a bug filed twice, or a reporter asked the same question every run
 * until they mute the channel. Those three live at the bottom of this file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const script = join(repoRoot, "scripts", "slack-triage-journal.mjs");
const fixture = (name) => join(repoRoot, "scripts", "__fixtures__", name);

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.error, undefined, `failed to spawn: ${result.error?.message}`);
  return { ...result, out: `${result.stdout}${result.stderr}` };
}

/** A writable journal in its own temp dir. Never the repository's own. */
function scratchJournal(contents = "") {
  const dir = mkdtempSync(join(tmpdir(), "slack-triage-"));
  const path = join(dir, "journal.jsonl");
  writeFileSync(path, contents, "utf8");
  return path;
}

/** A copy of a checked-in journal fixture, so a writing case cannot mutate the fixture. */
function scratchFrom(name) {
  return scratchJournal(readFileSync(fixture(name), "utf8"));
}

/** The distinct codes one run reported. */
function codes(out) {
  return [...new Set([...out.matchAll(/\[(ST-E\d+)\]/g)].map((m) => m[1]))].sort();
}

/** The plan rows, keyed by message ts. */
function planRows(journalPath, intakeName, ...flags) {
  const { status, out, stdout } = run(
    "plan",
    "--intake",
    fixture(intakeName),
    "--journal",
    journalPath,
    "--json",
    ...flags,
  );
  assert.equal(status, 0, out);
  const parsed = JSON.parse(stdout);
  return Object.fromEntries(parsed.rows.map((r) => [r.message_ts, r]));
}

/* ------------------------------------------------------------------ *
 * Usage and argv
 * ------------------------------------------------------------------ */

test("no command at all is a usage error, not a crash", () => {
  const { status, out } = run();
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E20]"), out);
});

test("an unknown flag names itself rather than being ignored", () => {
  const { status, out } = run("validate", "--not-a-flag");
  assert.equal(status, 2, out);
  assert.match(out, /unknown flag --not-a-flag/);
});

test("a value flag with no value is refused rather than swallowing the next flag", () => {
  const { status, out } = run("plan", "--intake", "--json");
  assert.equal(status, 2, out);
  assert.match(out, /--intake needs a value/);
});

/* ------------------------------------------------------------------ *
 * validate
 * ------------------------------------------------------------------ */

test("a journal holding one row per state is clean", () => {
  const { status, out } = run("validate", "--journal", fixture("slack-journal-clean.jsonl"));
  assert.equal(status, 0, out);
  assert.deepEqual(codes(out), []);
  assert.match(out, /8 records, 8 messages, clean/);
});

test("an unparseable line is ST-E01 and exits 3, and the readable lines around it still parse", () => {
  const { status, out } = run("validate", "--journal", fixture("slack-journal-bad-line.jsonl"));
  assert.equal(status, 3, out);
  assert.ok(out.includes("[ST-E01]"), out);
  assert.match(out, /line 2 is not parseable JSON/);
});

test("a message that went terminal twice with different keys is ST-E23", () => {
  const { status, out } = run("validate", "--journal", fixture("slack-journal-terminal-refile.jsonl"));
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E23]"), out);
  assert.match(out, /SCRUM-214/);
  assert.match(out, /SCRUM-231/);
});

test("a missing journal is not an error — a fresh checkout has nothing to validate", () => {
  const { status, out } = run("validate", "--journal", join(tmpdir(), "no-such-triage-journal.jsonl"));
  assert.equal(status, 0, out);
  assert.match(out, /nothing to validate/);
});

test("a filed row with no jira_key is ST-E21", () => {
  const path = scratchJournal(
    `${JSON.stringify({ v: 1, channel: "C1", message_ts: "1756000000.000100", state: "filed" })}\n`,
  );
  const { status, out } = run("validate", "--journal", path);
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E21]"), out);
});

test("an unknown state is ST-E03 and names the states that exist", () => {
  const path = scratchJournal(
    `${JSON.stringify({ v: 1, channel: "C1", message_ts: "1756000000.000100", state: "triaged" })}\n`,
  );
  const { status, out } = run("validate", "--journal", path);
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E03]"), out);
});

test("a record from a newer build is ST-E04 rather than being read on a guess", () => {
  const path = scratchJournal(
    `${JSON.stringify({ v: 2, channel: "C1", message_ts: "1756000000.000100", state: "skipped" })}\n`,
  );
  const { status, out } = run("validate", "--journal", path);
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E04]"), out);
});

/* ------------------------------------------------------------------ *
 * Intake validation
 * ------------------------------------------------------------------ */

test("a missing intake file is ST-E10 and exits 3", () => {
  const { status, out } = run("plan", "--intake", join(tmpdir(), "no-such-intake.json"));
  assert.equal(status, 3, out);
  assert.ok(out.includes("[ST-E10]"), out);
});

test("an intake entry with no text is ST-E11", () => {
  const { status, out } = run(
    "plan",
    "--intake",
    fixture("slack-intake-missing-text.json"),
    "--journal",
    scratchJournal(),
  );
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E11]"), out);
  assert.match(out, /missing `text`/);
});

test("a truncated message_ts is ST-E12 — a ts is the join key, so a bad one is not a formatting nit", () => {
  const { status, out } = run(
    "plan",
    "--intake",
    fixture("slack-intake-bad-ts.json"),
    "--journal",
    scratchJournal(),
  );
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E12]"), out);
});

/* ------------------------------------------------------------------ *
 * record
 * ------------------------------------------------------------------ */

test("state filed without --jira-key is ST-E21, before anything is written", () => {
  const path = scratchJournal();
  const { status, out } = run("record", "--journal", path, "--channel", "C1", "--ts", "1756000000.000100", "--state", "filed");
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E21]"), out);
  assert.equal(readFileSync(path, "utf8"), "");
});

test("state duplicate without a confidence is ST-E22", () => {
  const { status, out } = run(
    "record", "--journal", scratchJournal(),
    "--channel", "C1", "--ts", "1756000000.000100",
    "--state", "duplicate", "--duplicate-of", "SCRUM-167",
  );
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E22]"), out);
});

test("state thin without --missing is ST-E24 — the question and its hash come from that list", () => {
  const { status, out } = run(
    "record", "--journal", scratchJournal(),
    "--channel", "C1", "--ts", "1756000000.000100", "--state", "thin",
  );
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E24]"), out);
});

test("re-stating a terminal row as a different outcome is refused with ST-E23 and exit 4", () => {
  const path = scratchFrom("slack-journal-clean.jsonl");
  const before = readFileSync(path, "utf8");
  const { status, out } = run(
    "record", "--journal", path,
    "--channel", "C08ABCD1234", "--ts", "1756000000.000100",
    "--state", "filed", "--jira-key", "SCRUM-999",
  );
  assert.equal(status, 4, out);
  assert.ok(out.includes("[ST-E23]"), out);
  assert.match(out, /already filed as SCRUM-201/);
  assert.equal(readFileSync(path, "utf8"), before, "a refused write must leave the journal untouched");
});

test("re-recording a terminal row with the same outcome is `unchanged`, not a refusal", () => {
  const path = scratchFrom("slack-journal-clean.jsonl");
  const mtimeBefore = statSync(path).mtimeMs;
  const { status, out } = run(
    "record", "--journal", path,
    "--channel", "C08ABCD1234", "--ts", "1756000000.000100",
    "--state", "filed", "--jira-key", "SCRUM-201",
    "--reaction", "eyes", "--reaction", "white_check_mark",
    "--reply-ts", "1756000060.000200", "--text-sha256", "aaaa0000",
  );
  assert.equal(status, 0, out);
  assert.match(out, /unchanged/);
  assert.equal(statSync(path).mtimeMs, mtimeBefore, "an unchanged write must not touch mtime");
});

test("a clock that moved backwards is ST-E30 rather than a lease nobody can reason about", () => {
  const path = scratchFrom("slack-journal-clean.jsonl");
  const { status, out } = run(
    "record", "--journal", path,
    "--channel", "C08ABCD1234", "--ts", "1756000000.000700",
    "--state", "failed", "--now", "2026-08-24T08:00:00.000Z",
  );
  assert.equal(status, 1, out);
  assert.ok(out.includes("[ST-E30]"), out);
});

test("recording a duplicate writes the key, the confidence and the justification", () => {
  const path = scratchJournal();
  const { status, out } = run(
    "record", "--journal", path,
    "--channel", "C08ABCD1234", "--ts", "1756040113.000300",
    "--state", "duplicate", "--duplicate-of", "SCRUM-167", "--confidence", "high",
    "--justification", "same endpoint and the same 500 body",
    "--reaction", "bulb", "--reply-ts", "1756040220.000100",
  );
  assert.equal(status, 0, out);
  const rec = JSON.parse(readFileSync(path, "utf8").trim());
  assert.equal(rec.duplicate_of, "SCRUM-167");
  assert.equal(rec.confidence, "high");
  assert.deepEqual(rec.reactions_applied, ["bulb"]);
  assert.equal(rec.reply_ts, "1756040220.000100");
});

test("the reply and the reaction are separate fields, so a half-done response can be finished", () => {
  const path = scratchJournal();
  run(
    "record", "--journal", path,
    "--channel", "C1", "--ts", "1756000000.000100",
    "--state", "thin", "--missing", "steps,expected", "--reply-ts", "1756000060.000200",
  );
  // The reaction failed the first time round; a resume records it without a second reply.
  const { status, out } = run(
    "record", "--journal", path,
    "--channel", "C1", "--ts", "1756000000.000100",
    "--state", "thin", "--missing", "steps,expected", "--reaction", "question",
  );
  assert.equal(status, 0, out);
  const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[1].reactions_applied, ["question"]);
  assert.equal(rows[1].reply_ts, "1756000060.000200", "the reply ts must carry forward, or the resume posts twice");
});

test("the question hash depends on the missing set, not on the order it was listed in", () => {
  const a = scratchJournal();
  const b = scratchJournal();
  run("record", "--journal", a, "--channel", "C1", "--ts", "1756000000.000100", "--state", "thin", "--missing", "steps,expected,actual");
  run("record", "--journal", b, "--channel", "C1", "--ts", "1756000000.000100", "--state", "thin", "--missing", "actual,steps,expected");
  const hashOf = (p) => JSON.parse(readFileSync(p, "utf8").trim()).question_sha256;
  assert.equal(hashOf(a), hashOf(b));
});

/* ------------------------------------------------------------------ *
 * get
 * ------------------------------------------------------------------ */

test("get folds the log and returns the last record for a message", () => {
  const { status, stdout, out } = run(
    "get", "--journal", fixture("slack-journal-terminal-refile.jsonl"),
    "--channel", "C08ABCD1234", "--ts", "1756036800.001900", "--json",
  );
  assert.equal(status, 0, out);
  assert.equal(JSON.parse(stdout).jira_key, "SCRUM-231");
});

test("get on a message the journal has never seen says so rather than inventing a state", () => {
  const { status, out } = run(
    "get", "--journal", fixture("slack-journal-clean.jsonl"),
    "--channel", "C08ABCD1234", "--ts", "1799999999.999999",
  );
  assert.equal(status, 0, out);
  assert.match(out, /no record for/);
});

/* ------------------------------------------------------------------ *
 * compact
 * ------------------------------------------------------------------ */

test("compact --dry-run reports what it would drop and writes nothing", () => {
  const path = scratchFrom("slack-journal-terminal-refile.jsonl");
  const before = readFileSync(path, "utf8");
  const { status, out } = run("compact", "--journal", path, "--dry-run");
  assert.equal(status, 0, out);
  assert.match(out, /would keep 1 of 2 records/);
  assert.equal(readFileSync(path, "utf8"), before);
  assert.ok(!existsSync(`${path}.bak`), "a dry run must not leave a backup behind");
});

test("compact keeps the folded row, leaves a .bak, and is a no-op the second time", () => {
  const path = scratchFrom("slack-journal-terminal-refile.jsonl");
  const first = run("compact", "--journal", path);
  assert.equal(first.status, 0, first.out);
  assert.ok(existsSync(`${path}.bak`));
  const rows = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].jira_key, "SCRUM-231");

  const second = run("compact", "--journal", path);
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, /unchanged/);
});

/* ------------------------------------------------------------------ *
 * plan — the part that decides what gets triaged
 * ------------------------------------------------------------------ */

test("with an empty journal every message is new", () => {
  const rows = planRows(scratchJournal(), "slack-intake-clean.json");
  assert.equal(Object.values(rows).filter((r) => r.in_scope).length, 3);
  assert.equal(rows["1756036800.001900"].reason, "new");
});

test("a filed message is never in scope again — the assertion the whole file exists for", () => {
  const path = scratchJournal();
  run(
    "record", "--journal", path,
    "--channel", "C08ABCD1234", "--ts", "1756036800.001900",
    "--state", "filed", "--jira-key", "SCRUM-214",
  );
  const rows = planRows(path, "slack-intake-clean.json");
  assert.equal(rows["1756036800.001900"].in_scope, false);
  assert.equal(rows["1756036800.001900"].reason, "terminal");
  assert.match(rows["1756036800.001900"].detail, /SCRUM-214/);
});

test("a live claim by another run blocks; the same run resumes its own", () => {
  const path = scratchFrom("slack-journal-expired-lease.jsonl");
  const inLease = { "--now": "2026-08-23T09:10:00.000Z" };

  const foreign = planRows(path, "slack-intake-clean.json", "--now", inLease["--now"], "--run-id", "BUGTRIAGE-20260824-01");
  assert.equal(foreign["1756036800.001900"].in_scope, false);
  assert.equal(foreign["1756036800.001900"].reason, "claimed_by_live_run");

  const mine = planRows(path, "slack-intake-clean.json", "--now", inLease["--now"], "--run-id", "BUGTRIAGE-20260823-09");
  assert.equal(mine["1756036800.001900"].in_scope, true);
  assert.equal(mine["1756036800.001900"].reason, "resume");
});

test("an expired lease releases the message — a run that died must not strand it forever", () => {
  const path = scratchFrom("slack-journal-expired-lease.jsonl");
  const before = planRows(path, "slack-intake-clean.json", "--now", "2026-08-23T09:29:59.000Z");
  assert.equal(before["1756036800.001900"].in_scope, false, "one second inside the lease still blocks");

  const after = planRows(path, "slack-intake-clean.json", "--now", "2026-08-23T09:30:01.000Z");
  assert.equal(after["1756036800.001900"].in_scope, true);
  assert.equal(after["1756036800.001900"].reason, "lease_expired");
});

test("a thin report with the same missing set is never asked again", () => {
  const path = scratchFrom("slack-journal-thin-same-question.jsonl");
  const rows = planRows(path, "slack-intake-clean.json");
  assert.equal(rows["1756041999.000100"].in_scope, false);
  assert.equal(rows["1756041999.000100"].reason, "thin_unanswered");
});

test("a thin report comes back into scope when the reporter edits the message", () => {
  const path = scratchFrom("slack-journal-thin-same-question.jsonl");
  const intakeDir = mkdtempSync(join(tmpdir(), "slack-triage-intake-"));
  const intakePath = join(intakeDir, "intake.json");
  const intake = JSON.parse(readFileSync(fixture("slack-intake-clean.json"), "utf8"));
  intake[2].text = "app broken — steps: open /games, search for zelda. Expected three cards, actual empty state.";
  writeFileSync(intakePath, JSON.stringify(intake), "utf8");

  const { status, stdout, out } = run("plan", "--intake", intakePath, "--journal", path, "--json");
  assert.equal(status, 0, out);
  const row = JSON.parse(stdout).rows.find((r) => r.message_ts === "1756041999.000100");
  assert.equal(row.in_scope, true);
  assert.equal(row.reason, "thin_answered");
  assert.equal(row.detail, "message edited");
});

test("a thin report comes back into scope when a newer reply lands in its thread", () => {
  const path = scratchFrom("slack-journal-thin-same-question.jsonl");
  const intakeDir = mkdtempSync(join(tmpdir(), "slack-triage-intake-"));
  const intakePath = join(intakeDir, "intake.json");
  const intake = JSON.parse(readFileSync(fixture("slack-intake-clean.json"), "utf8"));
  // The journal's question was posted at 1756042100.000200; this answer is later.
  intake[2].latest_reply_ts = "1756042500.000100";
  writeFileSync(intakePath, JSON.stringify(intake), "utf8");

  const { stdout } = run("plan", "--intake", intakePath, "--journal", path, "--json");
  const row = JSON.parse(stdout).rows.find((r) => r.message_ts === "1756041999.000100");
  assert.equal(row.in_scope, true);
  assert.equal(row.reason, "thin_answered");
});

test("a reply older than the question does not reopen a thin report", () => {
  const path = scratchFrom("slack-journal-thin-same-question.jsonl");
  const intakeDir = mkdtempSync(join(tmpdir(), "slack-triage-intake-"));
  const intakePath = join(intakeDir, "intake.json");
  const intake = JSON.parse(readFileSync(fixture("slack-intake-clean.json"), "utf8"));
  intake[2].latest_reply_ts = "1756042000.000100";
  writeFileSync(intakePath, JSON.stringify(intake), "utf8");

  const { stdout } = run("plan", "--intake", intakePath, "--journal", path, "--json");
  const row = JSON.parse(stdout).rows.find((r) => r.message_ts === "1756041999.000100");
  assert.equal(row.in_scope, false, "Slack ts values must be compared numerically, not lexically");
});

test("a hand-marked message is excluded only when reactions are readable", () => {
  const intakeDir = mkdtempSync(join(tmpdir(), "slack-triage-intake-"));
  const intakePath = join(intakeDir, "intake.json");
  const intake = JSON.parse(readFileSync(fixture("slack-intake-clean.json"), "utf8"));
  intake[0].reactions = ["white_check_mark"];
  writeFileSync(intakePath, JSON.stringify(intake), "utf8");
  const journalPath = scratchJournal();

  const readable = JSON.parse(
    run("plan", "--intake", intakePath, "--journal", journalPath, "--json", "--reactions-readable", "yes").stdout,
  ).rows.find((r) => r.message_ts === "1756036800.001900");
  assert.equal(readable.in_scope, false);
  assert.equal(readable.reason, "reacted_elsewhere");

  const blind = JSON.parse(
    run("plan", "--intake", intakePath, "--journal", journalPath, "--json", "--reactions-readable", "no").stdout,
  ).rows.find((r) => r.message_ts === "1756036800.001900");
  assert.equal(blind.in_scope, true, "with write-only reactions the guarantee is off, and it must not be faked");
});

test("the plain output says so when reactions cannot be read", () => {
  const { out } = run(
    "plan", "--intake", fixture("slack-intake-clean.json"),
    "--journal", scratchJournal(), "--reactions-readable", "no",
  );
  assert.match(out, /reactions are not readable on this server/);
});

test("--reactions-readable takes only yes or no", () => {
  const { status, out } = run(
    "plan", "--intake", fixture("slack-intake-clean.json"),
    "--journal", scratchJournal(), "--reactions-readable", "maybe",
  );
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E20]"), out);
});

test("escalated and declined stay out until they are asked for by name", () => {
  const journalPath = scratchJournal();
  run("record", "--journal", journalPath, "--channel", "C08ABCD1234", "--ts", "1756036800.001900", "--state", "escalated");
  run("record", "--journal", journalPath, "--channel", "C08ABCD1234", "--ts", "1756040113.000300", "--state", "declined");

  const closed = planRows(journalPath, "slack-intake-clean.json");
  assert.equal(closed["1756036800.001900"].reason, "awaiting_human");
  assert.equal(closed["1756040113.000300"].reason, "previously_declined");

  const opened = planRows(journalPath, "slack-intake-clean.json", "--include-escalated", "--include-skipped");
  assert.equal(opened["1756036800.001900"].in_scope, true);
  assert.equal(opened["1756040113.000300"].in_scope, true);
});

test("a failed message is retried without being asked for", () => {
  const journalPath = scratchJournal();
  run("record", "--journal", journalPath, "--channel", "C08ABCD1234", "--ts", "1756036800.001900", "--state", "failed");
  const rows = planRows(journalPath, "slack-intake-clean.json");
  assert.equal(rows["1756036800.001900"].in_scope, true);
  assert.equal(rows["1756036800.001900"].reason, "retry_after_failure");
});

/* ------------------------------------------------------------------ *
 * claim
 * ------------------------------------------------------------------ */

test("claim takes a lease on every in-scope message and is idempotent for the same run", () => {
  const path = scratchJournal();
  const first = run("claim", "--intake", fixture("slack-intake-clean.json"), "--journal", path, "--run-id", "BUGTRIAGE-20260824-01");
  assert.equal(first.status, 0, first.out);
  assert.match(first.out, /claimed 3 for BUGTRIAGE-20260824-01/);

  const second = run("claim", "--intake", fixture("slack-intake-clean.json"), "--journal", path, "--run-id", "BUGTRIAGE-20260824-01");
  assert.equal(second.status, 0, second.out);
  assert.match(second.out, /unchanged — 3 already claimed/);
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3, "a second claim must not append a second lease");
});

test("claiming a message another run holds live is refused with ST-E40 and exit 4", () => {
  const path = scratchFrom("slack-journal-expired-lease.jsonl");
  const { status, out } = run(
    "claim", "--intake", fixture("slack-intake-clean.json"), "--journal", path,
    "--run-id", "BUGTRIAGE-20260824-01", "--now", "2026-08-23T09:10:00.000Z",
  );
  assert.equal(status, 4, out);
  assert.ok(out.includes("[ST-E40]"), out);
  assert.match(out, /BUGTRIAGE-20260823-09/);
});

test("claim writes the lease it was asked for", () => {
  const path = scratchJournal();
  run(
    "claim", "--intake", fixture("slack-intake-clean.json"), "--journal", path,
    "--run-id", "BUGTRIAGE-20260824-01", "--now", "2026-08-24T09:00:00.000Z", "--lease-minutes", "45",
  );
  const rec = JSON.parse(readFileSync(path, "utf8").trim().split("\n")[0]);
  assert.equal(rec.state, "claimed");
  assert.equal(rec.claimed_at, "2026-08-24T09:00:00.000Z");
  assert.equal(rec.lease_expires_at, "2026-08-24T09:45:00.000Z");
});

test("a lease of zero minutes is a usage error, not a lease that expires instantly", () => {
  const { status, out } = run(
    "claim", "--intake", fixture("slack-intake-clean.json"), "--journal", scratchJournal(),
    "--run-id", "BUGTRIAGE-20260824-01", "--lease-minutes", "0",
  );
  assert.equal(status, 2, out);
  assert.ok(out.includes("[ST-E20]"), out);
});

test("claim never re-claims a message that is already terminal", () => {
  const path = scratchJournal();
  run("record", "--journal", path, "--channel", "C08ABCD1234", "--ts", "1756036800.001900", "--state", "filed", "--jira-key", "SCRUM-214");
  const { out } = run("claim", "--intake", fixture("slack-intake-clean.json"), "--journal", path, "--run-id", "BUGTRIAGE-20260824-01");
  assert.match(out, /claimed 2 /);
});

/* ------------------------------------------------------------------ *
 * print-schema
 * ------------------------------------------------------------------ */

test("print-schema names every state and marks the terminal ones", () => {
  const { status, stdout, out } = run("print-schema", "--json");
  assert.equal(status, 0, out);
  const schema = JSON.parse(stdout);
  assert.deepEqual(schema.terminal_states.sort(), ["duplicate", "filed"]);
  assert.ok(Object.hasOwn(schema.states, "thin"));
  assert.ok(schema.handled_reactions.includes("eyes"));
});

/* ------------------------------------------------------------------ *
 * --limit — how much work one run takes on
 * ------------------------------------------------------------------ */

/** The whole `plan --json` payload, not just its rows. */
function planJson(journalPath, intakeName, ...flags) {
  const { status, out, stdout } = run(
    "plan", "--intake", fixture(intakeName), "--journal", journalPath, "--json", ...flags,
  );
  assert.equal(status, 0, out);
  return JSON.parse(stdout);
}

test("--limit keeps the oldest in-scope messages, and it is the oldest that survive", () => {
  const plan = planJson(scratchJournal(), "slack-intake-backlog.json", "--limit", "5");
  assert.equal(plan.total, 8);
  assert.equal(plan.in_scope, 5);
  const kept = plan.rows.filter((r) => r.in_scope).map((r) => r.message_ts);
  const oldest = plan.rows.slice(0, 5).map((r) => r.message_ts);
  assert.deepEqual(kept, oldest);
  // Oldest by number, never by string: a ts is a decimal, and lexical order is not its order.
  const asNumbers = kept.map(Number);
  assert.deepEqual(asNumbers, [...asNumbers].sort((a, b) => a - b));
});

test("messages over the cap stay listed as deferred_over_limit rather than vanishing", () => {
  const plan = planJson(scratchJournal(), "slack-intake-backlog.json", "--limit", "5");
  const deferred = plan.rows.filter((r) => r.reason === "deferred_over_limit");
  assert.equal(deferred.length, 3);
  assert.equal(plan.deferred_over_limit, 3);
  assert.equal(plan.total, 8, "the cap bounds the work, never the report");
  for (const row of deferred) {
    assert.equal(row.in_scope, false);
    assert.match(row.detail, /cap of 5/);
  }
});

test("a second run takes the next batch — the reason the cap is applied after the skip filter", () => {
  const path = scratchFrom("slack-journal-backlog-first-batch.jsonl");
  const plan = planJson(path, "slack-intake-backlog.json", "--limit", "5");
  const kept = plan.rows.filter((r) => r.in_scope).map((r) => r.message_ts);
  assert.deepEqual(kept, ["1756050015.000115", "1756050016.000116", "1756050017.000117"]);
  // The five the earlier run finished are stepped over, not counted against this run's budget.
  const terminal = plan.rows.filter((r) => r.reason === "terminal");
  assert.equal(terminal.length, 5);
  assert.equal(plan.deferred_over_limit, 0);
});

test("the cap spends its budget only on untracked work, so a done batch never consumes it", () => {
  const path = scratchFrom("slack-journal-backlog-first-batch.jsonl");
  const plan = planJson(path, "slack-intake-backlog.json", "--limit", "2");
  assert.equal(plan.in_scope, 2);
  assert.deepEqual(
    plan.rows.filter((r) => r.in_scope).map((r) => r.message_ts),
    ["1756050015.000115", "1756050016.000116"],
  );
  assert.equal(plan.deferred_over_limit, 1);
});

test("claim honours the same cap — a leased message the run will not work is stranded for 30 minutes", () => {
  const path = scratchJournal();
  const { status, out } = run(
    "claim", "--intake", fixture("slack-intake-backlog.json"), "--journal", path,
    "--run-id", "BUGTRIAGE-20260824-01", "--limit", "5", "--json",
  );
  assert.equal(status, 0, out);
  const claimed = JSON.parse(out).claimed;
  assert.equal(claimed.length, 5);
  assert.deepEqual(claimed, [
    "1756050010.000110", "1756050011.000111", "1756050012.000112",
    "1756050013.000113", "1756050014.000114",
  ]);
  const written = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(written.length, 5, "the deferred three must carry no lease");
});

test("plan and claim cannot disagree about the cap — both read it through buildPlan", () => {
  const path = scratchFrom("slack-journal-backlog-first-batch.jsonl");
  const planned = planJson(path, "slack-intake-backlog.json", "--limit", "2")
    .rows.filter((r) => r.in_scope).map((r) => r.message_ts);
  const { stdout } = run(
    "claim", "--intake", fixture("slack-intake-backlog.json"), "--journal", path,
    "--run-id", "BUGTRIAGE-20260824-02", "--limit", "2", "--json",
  );
  assert.deepEqual(JSON.parse(stdout).claimed, planned);
});

test("no --limit means no cap, which is what every existing caller gets", () => {
  const plan = planJson(scratchJournal(), "slack-intake-backlog.json");
  assert.equal(plan.in_scope, 8);
  assert.equal(plan.limit, null);
  assert.equal(plan.deferred_over_limit, 0);
});

test("a cap of zero is a usage error on both commands, not a run that does nothing", () => {
  for (const [command, extra] of [["plan", []], ["claim", ["--run-id", "BUGTRIAGE-20260824-01"]]]) {
    const { status, out } = run(
      command, "--intake", fixture("slack-intake-backlog.json"),
      "--journal", scratchJournal(), "--limit", "0", ...extra,
    );
    assert.equal(status, 2, `${command}: ${out}`);
    assert.deepEqual(codes(out), ["ST-E20"], out);
  }
});

test("a cap that is not a whole number is refused rather than rounded", () => {
  for (const bad of ["abc", "-2", "2.5"]) {
    const { status, out } = run(
      "plan", "--intake", fixture("slack-intake-backlog.json"),
      "--journal", scratchJournal(), "--limit", bad,
    );
    assert.equal(status, 2, out);
    assert.ok(out.includes(`got "${bad}"`), out);
  }
});

test("the plain output names the deferred remainder, so a capped run does not read as a finished one", () => {
  const { status, out } = run(
    "plan", "--intake", fixture("slack-intake-backlog.json"),
    "--journal", scratchJournal(), "--limit", "5",
  );
  assert.equal(status, 0, out);
  assert.match(out, /in scope: 5 of 8/);
  assert.match(out, /deferred over the cap of 5: 3/);
});
