#!/usr/bin/env node
/**
 * slack-triage-journal.mjs — the durable record of which Slack messages have already been triaged,
 * and the only thing allowed to decide which of them are still in scope.
 *
 * The obvious design for "collect the messages nobody has handled yet" is to read the emoji back off
 * each message: skip anything already carrying an eye or a tick. That design cannot be built. The
 * official Slack MCP server does not return reactions from its read tools at all
 * (slackapi/slack-skills-plugin#26, open since 2026-04-05), and the third-party servers that expose
 * `reactions_add` do not document whether `conversations_history` carries a `reactions` array. A
 * reaction may therefore be write-only: something the workflow can set and can never see again.
 *
 * Worse, a write-only reaction cannot be *un*set by a run that has died. Marking a message with an eye
 * and then crashing before filing the bug would strand that message forever, invisible to every later
 * run, with nobody to notice.
 *
 * So the journal is primary and the reactions are secondary. This file is the ledger: one append-only
 * record per event, folded by `(channel, message_ts)` on read. A claim carries a *lease*, so a run that
 * dies releases its messages by expiry rather than by cleanup. Reactions, where the installed server
 * turns out to expose them, are a second exclusion joined on top — never the first.
 *
 * Usage:
 *   node scripts/slack-triage-journal.mjs plan     --intake <path> [--reactions-readable yes|no]
 *                                                  [--lease-minutes <n>] [--now <iso>] [--json]
 *                                                  [--include-skipped] [--include-escalated]
 *   node scripts/slack-triage-journal.mjs claim    --intake <path> --run-id <ID>
 *                                                  [--lease-minutes <n>] [--now <iso>] [--json]
 *   node scripts/slack-triage-journal.mjs record   --channel <C> --ts <ts> --state <state>
 *                                                  [--run-id <ID>] [--jira-key <KEY>]
 *                                                  [--duplicate-of <KEY>] [--confidence high|medium|low]
 *                                                  [--justification <text>] [--missing <a,b,c>]
 *                                                  [--reaction <name>]... [--reply-ts <ts>]
 *                                                  [--text-sha256 <hex>] [--note <text>] [--now <iso>]
 *   node scripts/slack-triage-journal.mjs get      --channel <C> --ts <ts> [--json]
 *   node scripts/slack-triage-journal.mjs validate [--strict] [--json]
 *   node scripts/slack-triage-journal.mjs compact  [--dry-run] [--json]
 *   node scripts/slack-triage-journal.mjs print-schema [--json | --markdown]
 *
 * `--journal <path>` overrides the default `.slack-triage/journal.jsonl` under the repository root,
 * on every command. A dry run and every test case point it at a scratch file.
 *
 * THE JOURNAL IS TRACKED IN GIT, unlike `.workflow/` and `.jira-bug/`, which are scratch that
 * regenerates. This file is the only durable statement that a Slack message has already become a
 * SCRUM ticket; ignoring it means a second machine refiles every bug the first machine filed. The
 * repository carries `.slack-triage/journal.jsonl merge=union` in `.gitattributes`, which is exactly
 * what an append-only log wants from a merge.
 *
 * APPEND-ONLY, NOT THE WHOLE-DOCUMENT REWRITE `workflow-state.mjs` USES. That script re-emits its
 * whole document on every write because the defect it was built against was a duplicate key inside one
 * YAML mapping — a failure mode that cannot occur in a one-record-per-line log. Rewriting a long
 * ledger to change one field would instead reintroduce a full-file clobber, on the one file here whose
 * loss means refiling every bug ever triaged. `compact` is the single command that rewrites, and it
 * writes atomically and keeps a `.bak`.
 *
 * Exit codes:
 *   0  clean; a row that was written; a row that was already satisfied (`unchanged`)
 *   1  violations found in the journal or the intake
 *   2  usage error — an unknown flag, a missing required flag, or a state missing its companion field
 *   3  the journal or the intake file is missing, or holds a line this parser cannot read
 *   4  refused by policy — re-stating a terminal row, or claiming a message another run holds live
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE. It never judges whether a message is a bug report, whether a
 * duplicate verdict was right, whether a confidence band was earned, or whether the text of a threaded
 * reply says anything useful. It answers one question — which messages are still in scope, and why
 * each of the others is not — and it answers it the same way every time, which is the whole reason the
 * question was taken away from a model.
 */

import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  openSync,
  closeSync,
  fsyncSync,
  renameSync,
  appendFileSync,
  statSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/*
 * The ledger belongs to the project being triaged, not to this plugin. A run against repo A and a run
 * against repo B are different backlogs, and a journal resolved next to the script would merge them into
 * one file inside the plugin install. Claude Code sets CLAUDE_PROJECT_DIR for plugin components; a bare
 * `node …` invocation from a shell falls back to the working directory, which is the same place.
 */
const repoRoot = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd());

const EXIT_CLEAN = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;
const EXIT_MISSING = 3;
const EXIT_REFUSED = 4;

const RECORD_VERSION = 1;
const DEFAULT_JOURNAL = join(".slack-triage", "journal.jsonl");
const DEFAULT_LEASE_MINUTES = 30;

/* ------------------------------------------------------------------ *
 * Schema
 * ------------------------------------------------------------------ */

/**
 * The states a message can be in. `filed` and `duplicate` are terminal: the message produced a Jira
 * outcome and no later run may reconsider it. Everything else is a waypoint.
 */
const STATES = {
  claimed: "a run holds a lease on this message and is working on it",
  filed: "a Jira bug was created for this message (terminal)",
  duplicate: "this message was judged a duplicate of an existing bug (terminal)",
  thin: "the message is missing reporter-supplied fields; a question was asked in thread",
  escalated: "the workflow declined to decide alone and left it for a human",
  skipped: "deliberately passed over — not a bug report, or handled elsewhere",
  declined: "a human declined to file this one",
  failed: "the run errored on this message; a later run retries it",
};

const TERMINAL_STATES = new Set(["filed", "duplicate"]);

/** Reactions that mean "somebody has already dealt with this", when the server lets us read them. */
const HANDLED_REACTIONS = new Set(["eyes", "white_check_mark", "bulb", "question"]);

const CONFIDENCES = new Set(["high", "medium", "low"]);

/** Every field a record may carry, and what it is for. `print-schema` renders this. */
const FIELDS = [
  ["v", "record format version; a record from a newer build is refused rather than guessed at"],
  ["channel", "Slack channel id (C…), never the name — a renamed channel keeps its id"],
  ["message_ts", "Slack message ts, `\\d{10}\\.\\d{6}`; unique within a channel"],
  ["thread_ts", "the parent ts when the message sits in a thread, else null"],
  ["run_id", "the triage run that wrote this record, e.g. BUGTRIAGE-20260824-01"],
  ["state", `one of: ${Object.keys(STATES).join(", ")}`],
  ["author", "Slack user id of the reporter"],
  ["text_sha256", "hash of the message text, so an edit is detectable without storing the text"],
  ["permalink", "Slack permalink, for a human reading the ledger"],
  ["jira_key", "the created bug; required when state is `filed`"],
  ["duplicate_of", "the matched bug; required when state is `duplicate`"],
  ["confidence", "high | medium | low; required when state is `duplicate`"],
  ["justification", "one line of evidence for the duplicate verdict"],
  ["missing_fields", "the reporter-supplied fields absent from the message; required when `thin`"],
  ["question_sha256", "hash of the sorted missing set — the same set never asks twice"],
  ["reactions_applied", "reactions this workflow actually set, not the ones it intended to"],
  ["reply_ts", "ts of the threaded reply this workflow posted, so a resume finishes the other half"],
  ["claimed_at", "when the lease was taken"],
  ["lease_expires_at", "when a dead run's claim stops blocking a later one"],
  ["updated_at", "when this record was written"],
  ["note", "one line of free text; never parsed"],
];

/* ------------------------------------------------------------------ *
 * Failure collection
 * ------------------------------------------------------------------ */

const violations = [];

function fail(code, message, where = null) {
  violations.push({ code, message, where });
}

function die(exitCode, code, message) {
  process.stderr.write(`[${code}] ${message}\n`);
  return exitCode;
}

function printViolations() {
  for (const v of violations) {
    const where = v.where ? ` (${v.where})` : "";
    process.stdout.write(`[${v.code}] ${v.message}${where}\n`);
  }
}

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

const TS_RE = /^\d{10}\.\d{6}$/;

function sha256(text) {
  return createHash("sha256").update(String(text), "utf8").digest("hex");
}

/** The hash that makes a thin report ask its question exactly once per distinct missing set. */
function questionHash(missingFields) {
  const sorted = [...(missingFields || [])].map((f) => String(f).trim()).filter(Boolean).sort();
  return sorted.length === 0 ? null : sha256(sorted.join(","));
}

function key(channel, messageTs) {
  return `${channel} ${messageTs}`;
}

/** Slack ts values are decimal strings; compare them numerically, never lexically. */
function tsNewer(a, b) {
  if (!a || !b) return false;
  return Number(a) > Number(b);
}

function isoNow(override) {
  return override || new Date().toISOString();
}

function addMinutes(iso, minutes) {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

function writeAtomic(filePath, text) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = join(dirname(filePath), `.${Date.now()}.${process.pid}.tmp`);
  const fd = openSync(tmp, "w");
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, filePath);
}

/** One line onto the end of the log, flushed before the process can exit. */
function appendLine(filePath, obj) {
  mkdirSync(dirname(filePath), { recursive: true });
  appendFileSync(filePath, `${JSON.stringify(obj)}\n`, "utf8");
  const fd = openSync(filePath, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/* ------------------------------------------------------------------ *
 * Reading
 * ------------------------------------------------------------------ */

/**
 * Every record in the log, in order, with the line number each came from.
 * A journal that does not exist yet is an empty journal, not an error — the first run of a fresh
 * checkout must not have to create one by hand.
 */
function readJournal(filePath) {
  if (!existsSync(filePath)) return { records: [], missing: true };
  let text;
  try {
    text = readFileSync(filePath, "utf8");
  } catch (err) {
    return { records: [], missing: true, unreadable: err.message };
  }
  const records = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      fail("ST-E01", `line ${i + 1} is not parseable JSON`, filePath);
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail("ST-E01", `line ${i + 1} is not a JSON object`, filePath);
      continue;
    }
    records.push({ ...parsed, __line: i + 1 });
  }
  return { records, missing: false };
}

/** Fold the log by `(channel, message_ts)`, last record wins. */
function fold(records) {
  const byKey = new Map();
  for (const rec of records) {
    if (!rec.channel || !rec.message_ts) continue;
    byKey.set(key(rec.channel, rec.message_ts), rec);
  }
  return byKey;
}

function readIntake(filePath) {
  if (!existsSync(filePath)) {
    return { entries: null, error: `intake file not found: ${filePath}` };
  }
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (err) {
    return { entries: null, error: `intake file is not parseable JSON: ${err.message}` };
  }
  const entries = Array.isArray(parsed) ? parsed : parsed?.messages;
  if (!Array.isArray(entries)) {
    return { entries: null, error: "intake must be a JSON array, or an object with a `messages` array" };
  }
  return { entries, error: null };
}

/** Intake entries are produced by a model reading Slack, so check them before trusting them. */
function validateIntake(entries, filePath) {
  const seen = new Set();
  entries.forEach((entry, i) => {
    const at = `${filePath} entry ${i}`;
    if (!entry || typeof entry !== "object") {
      fail("ST-E11", `entry ${i} is not an object`, filePath);
      return;
    }
    for (const field of ["channel", "message_ts", "text"]) {
      if (entry[field] === undefined || entry[field] === null || String(entry[field]).trim() === "") {
        fail("ST-E11", `entry ${i} is missing \`${field}\``, at);
      }
    }
    if (entry.message_ts && !TS_RE.test(String(entry.message_ts))) {
      fail("ST-E12", `entry ${i} has message_ts "${entry.message_ts}", which is not \\d{10}\\.\\d{6}`, at);
    }
    if (entry.channel && entry.message_ts) {
      const k = key(entry.channel, entry.message_ts);
      if (seen.has(k)) fail("ST-E11", `entry ${i} repeats ${entry.channel}/${entry.message_ts}`, at);
      seen.add(k);
    }
  });
}

/* ------------------------------------------------------------------ *
 * The skip filter — the reason this file exists
 * ------------------------------------------------------------------ */

/**
 * Decide, for one intake entry, whether this run should process it.
 *
 * `reactionsReadable` is resolved per run by whoever read the channel, not configured: a server that
 * starts returning reactions makes the extra exclusion switch itself on. When it is false the
 * `reacted_elsewhere` rule cannot fire, and a human who marked a message by hand will not be honoured
 * — which is a real hole, and one the caller is expected to state out loud rather than paper over.
 */
function decide(entry, prior, opts) {
  const { now, reactionsReadable, runId, includeSkipped, includeEscalated } = opts;
  const textHash = sha256(entry.text ?? "");

  if (!prior) {
    if (reactionsReadable) {
      const marks = (entry.reactions || []).filter((r) => HANDLED_REACTIONS.has(String(r)));
      if (marks.length > 0) {
        return { inScope: false, reason: "reacted_elsewhere", detail: marks.join(", "), textHash };
      }
    }
    return { inScope: true, reason: "new", textHash };
  }

  const state = prior.state;

  if (TERMINAL_STATES.has(state)) {
    const ref = prior.jira_key || prior.duplicate_of || "";
    return { inScope: false, reason: "terminal", detail: `${state}${ref ? ` ${ref}` : ""}`, textHash };
  }

  if (state === "claimed") {
    const expired = prior.lease_expires_at ? new Date(prior.lease_expires_at) <= new Date(now) : true;
    if (!expired && prior.run_id && runId && prior.run_id === runId) {
      return { inScope: true, reason: "resume", detail: prior.run_id, textHash };
    }
    if (!expired) {
      return { inScope: false, reason: "claimed_by_live_run", detail: prior.run_id || "unknown run", textHash };
    }
    return { inScope: true, reason: "lease_expired", detail: prior.lease_expires_at || "no lease", textHash };
  }

  if (state === "failed") {
    return { inScope: true, reason: "retry_after_failure", textHash };
  }

  if (state === "thin") {
    const edited = prior.text_sha256 && prior.text_sha256 !== textHash;
    const answered = tsNewer(entry.latest_reply_ts, prior.reply_ts);
    if (edited || answered) {
      return {
        inScope: true,
        reason: "thin_answered",
        detail: edited ? "message edited" : "newer reply in thread",
        textHash,
      };
    }
    return {
      inScope: false,
      reason: "thin_unanswered",
      detail: (prior.missing_fields || []).join(", ") || "unspecified",
      textHash,
    };
  }

  if (state === "escalated") {
    return includeEscalated
      ? { inScope: true, reason: "escalated_included", textHash }
      : { inScope: false, reason: "awaiting_human", detail: prior.note || "", textHash };
  }

  if (state === "skipped" || state === "declined") {
    return includeSkipped
      ? { inScope: true, reason: "declined_included", textHash }
      : { inScope: false, reason: "previously_declined", detail: state, textHash };
  }

  // An unknown state is reported by `validate`; here it is treated as blocking, because acting on a
  // record this build does not understand is the one outcome with no safe default.
  return { inScope: false, reason: "unknown_state", detail: String(state), textHash };
}

function buildPlan(intakeEntries, folded, opts) {
  const rows = [];
  for (const entry of intakeEntries) {
    if (!entry?.channel || !entry?.message_ts) continue;
    const prior = folded.get(key(entry.channel, entry.message_ts)) || null;
    const verdict = decide(entry, prior, opts);
    rows.push({
      channel: entry.channel,
      message_ts: entry.message_ts,
      author: entry.author ?? null,
      permalink: entry.permalink ?? null,
      thread_ts: entry.thread_ts ?? null,
      text_sha256: verdict.textHash,
      in_scope: verdict.inScope,
      reason: verdict.reason,
      detail: verdict.detail ?? null,
      prior_state: prior?.state ?? null,
    });
  }
  return applyLimit(rows, opts.limit);
}

/**
 * Cap how many messages a run works, keeping the oldest untracked ones.
 *
 * The cap belongs here rather than in the collector, which holds no ledger tool and so cannot tell an
 * unhandled message from a finished one: capping at collection returns the same oldest N every run,
 * every one of them already terminal, and the backlog behind them is never reached. Applied after the
 * skip filter, the budget is spent only on messages nobody has handled, so run 1 takes the oldest N
 * and run 2 takes the next.
 *
 * Rows beyond the cap are re-labelled, never removed. A run that silently drops messages is
 * indistinguishable from a run that had none, so `total` stays the whole intake and each deferral
 * says why it is out of scope.
 */
function applyLimit(rows, limit) {
  if (!limit) return rows;
  let budget = limit;
  return rows.map((row) => {
    if (!row.in_scope) return row;
    if (budget > 0) {
      budget -= 1;
      return row;
    }
    return { ...row, in_scope: false, reason: "deferred_over_limit", detail: `over the cap of ${limit}` };
  });
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

/** `--limit` is optional everywhere; absent means no cap, and 0 is a caller mistake rather than one. */
function readLimit(args) {
  const raw = args.value("--limit");
  if (raw === undefined) return { limit: null };
  const limit = Number(raw);
  if (!Number.isInteger(limit) || limit < 1) {
    return { error: `--limit must be an integer >= 1, got "${raw}"` };
  }
  return { limit };
}

function cmdPlan(args) {
  const intakePath = args.value("--intake");
  if (!intakePath) return die(EXIT_USAGE, "ST-E20", "plan requires --intake <path>");

  const { entries, error } = readIntake(intakePath);
  if (error) return die(EXIT_MISSING, "ST-E10", error);

  validateIntake(entries, intakePath);

  const journalPath = args.journalPath();
  const { records } = readJournal(journalPath);
  if (violations.length > 0) {
    printViolations();
    return violations.some((v) => v.code === "ST-E01") ? EXIT_MISSING : EXIT_VIOLATIONS;
  }

  const readable = args.value("--reactions-readable");
  if (readable && !["yes", "no"].includes(readable)) {
    return die(EXIT_USAGE, "ST-E20", `--reactions-readable takes yes or no, got "${readable}"`);
  }

  const { limit, error: limitError } = readLimit(args);
  if (limitError) return die(EXIT_USAGE, "ST-E20", limitError);

  const opts = {
    now: isoNow(args.value("--now")),
    reactionsReadable: readable === "yes",
    runId: args.value("--run-id") || null,
    includeSkipped: args.has("--include-skipped"),
    includeEscalated: args.has("--include-escalated"),
    limit,
  };

  const rows = buildPlan(entries, fold(records), opts);
  const inScope = rows.filter((r) => r.in_scope);
  const deferred = rows.filter((r) => r.reason === "deferred_over_limit");

  if (args.has("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          scope: "which messages are still to be triaged, and why each of the others is not",
          journal: journalPath,
          intake: intakePath,
          now: opts.now,
          reactions_readable: opts.reactionsReadable,
          limit: limit ?? null,
          total: rows.length,
          in_scope: inScope.length,
          deferred_over_limit: deferred.length,
          rows,
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_CLEAN;
  }

  process.stdout.write(`journal: ${journalPath}\n`);
  process.stdout.write(`intake:  ${intakePath} (${rows.length} message${rows.length === 1 ? "" : "s"})\n`);
  process.stdout.write(`reactions readable: ${opts.reactionsReadable ? "yes" : "no"}\n\n`);
  for (const row of rows) {
    const mark = row.in_scope ? "+" : "-";
    const detail = row.detail ? ` — ${row.detail}` : "";
    process.stdout.write(`  ${mark} ${row.message_ts}  ${row.reason}${detail}\n`);
  }
  process.stdout.write(`\nin scope: ${inScope.length} of ${rows.length}\n`);
  if (deferred.length > 0) {
    process.stdout.write(
      `deferred over the cap of ${limit}: ${deferred.length} — a later run picks them up in this order.\n`,
    );
  }
  if (!opts.reactionsReadable) {
    process.stdout.write(
      "note: reactions are not readable on this server, so a message somebody marked by hand is not excluded.\n",
    );
  }
  return EXIT_CLEAN;
}

function cmdClaim(args) {
  const intakePath = args.value("--intake");
  const runId = args.value("--run-id");
  if (!intakePath) return die(EXIT_USAGE, "ST-E20", "claim requires --intake <path>");
  if (!runId) return die(EXIT_USAGE, "ST-E20", "claim requires --run-id <ID>");

  const { entries, error } = readIntake(intakePath);
  if (error) return die(EXIT_MISSING, "ST-E10", error);
  validateIntake(entries, intakePath);

  const journalPath = args.journalPath();
  const { records } = readJournal(journalPath);
  if (violations.length > 0) {
    printViolations();
    return violations.some((v) => v.code === "ST-E01") ? EXIT_MISSING : EXIT_VIOLATIONS;
  }

  const readable = args.value("--reactions-readable") === "yes";
  const now = isoNow(args.value("--now"));
  const leaseMinutes = Number(args.value("--lease-minutes") ?? DEFAULT_LEASE_MINUTES);
  if (!Number.isFinite(leaseMinutes) || leaseMinutes <= 0) {
    return die(EXIT_USAGE, "ST-E20", `--lease-minutes must be a positive number, got "${args.value("--lease-minutes")}"`);
  }

  const { limit, error: limitError } = readLimit(args);
  if (limitError) return die(EXIT_USAGE, "ST-E20", limitError);

  const folded = fold(records);
  // Same buildPlan, same limit: a claim that leased more than the run intends to work would strand
  // the surplus under a lease nobody is holding on purpose.
  const rows = buildPlan(entries, folded, {
    now,
    reactionsReadable: readable,
    runId,
    includeSkipped: args.has("--include-skipped"),
    includeEscalated: args.has("--include-escalated"),
    limit,
  });

  // A live claim held by another run is the one case where claiming is refused rather than skipped:
  // the caller asked for these messages by name, so silently returning fewer would read as "done".
  const contested = rows.filter((r) => r.reason === "claimed_by_live_run");
  if (contested.length > 0) {
    for (const row of contested) {
      process.stdout.write(
        `[ST-E40] ${row.channel}/${row.message_ts} is claimed by ${row.detail} until its lease expires\n`,
      );
    }
    return EXIT_REFUSED;
  }

  const claimed = [];
  const alreadyMine = [];
  for (const row of rows.filter((r) => r.in_scope)) {
    const prior = folded.get(key(row.channel, row.message_ts));
    if (prior && prior.state === "claimed" && prior.run_id === runId) {
      alreadyMine.push(row.message_ts);
      continue;
    }
    const entry = entries.find((e) => e.channel === row.channel && e.message_ts === row.message_ts);
    const record = {
      v: RECORD_VERSION,
      channel: row.channel,
      message_ts: row.message_ts,
      thread_ts: entry?.thread_ts ?? null,
      run_id: runId,
      state: "claimed",
      author: entry?.author ?? null,
      text_sha256: row.text_sha256,
      permalink: entry?.permalink ?? null,
      claimed_at: now,
      lease_expires_at: addMinutes(now, leaseMinutes),
      updated_at: now,
    };
    appendLine(journalPath, record);
    claimed.push(row.message_ts);
  }

  if (args.has("--json")) {
    process.stdout.write(
      `${JSON.stringify({ run_id: runId, claimed, already_mine: alreadyMine, lease_minutes: leaseMinutes }, null, 2)}\n`,
    );
    return EXIT_CLEAN;
  }

  if (claimed.length === 0 && alreadyMine.length === 0) {
    process.stdout.write("nothing to claim\n");
    return EXIT_CLEAN;
  }
  if (claimed.length === 0) {
    process.stdout.write(`unchanged — ${alreadyMine.length} already claimed by ${runId}\n`);
    return EXIT_CLEAN;
  }
  process.stdout.write(`claimed ${claimed.length} for ${runId} (lease ${leaseMinutes}m)\n`);
  for (const ts of claimed) process.stdout.write(`  + ${ts}\n`);
  if (alreadyMine.length > 0) process.stdout.write(`  (${alreadyMine.length} already held by this run)\n`);
  return EXIT_CLEAN;
}

/** The fields a `record` write is about, ignoring the timestamps that always move. */
function meaningful(rec) {
  return JSON.stringify({
    state: rec.state ?? null,
    jira_key: rec.jira_key ?? null,
    duplicate_of: rec.duplicate_of ?? null,
    confidence: rec.confidence ?? null,
    justification: rec.justification ?? null,
    missing_fields: rec.missing_fields ?? null,
    question_sha256: rec.question_sha256 ?? null,
    reactions_applied: rec.reactions_applied ?? null,
    reply_ts: rec.reply_ts ?? null,
    text_sha256: rec.text_sha256 ?? null,
    note: rec.note ?? null,
  });
}

function cmdRecord(args) {
  const channel = args.value("--channel");
  const ts = args.value("--ts");
  const state = args.value("--state");

  if (!channel) return die(EXIT_USAGE, "ST-E20", "record requires --channel <C>");
  if (!ts) return die(EXIT_USAGE, "ST-E20", "record requires --ts <ts>");
  if (!state) return die(EXIT_USAGE, "ST-E20", "record requires --state <state>");
  if (!TS_RE.test(ts)) {
    return die(EXIT_USAGE, "ST-E12", `--ts "${ts}" is not \\d{10}\\.\\d{6}`);
  }
  if (!Object.hasOwn(STATES, state)) {
    return die(EXIT_USAGE, "ST-E03", `unknown state "${state}"; one of: ${Object.keys(STATES).join(", ")}`);
  }

  const jiraKey = args.value("--jira-key");
  const duplicateOf = args.value("--duplicate-of");
  const confidence = args.value("--confidence");
  const missing = args.value("--missing");

  if (state === "filed" && !jiraKey) {
    return die(EXIT_USAGE, "ST-E21", "--state filed requires --jira-key; a filed row with no key cannot be trusted as terminal");
  }
  if (state === "duplicate" && (!duplicateOf || !confidence)) {
    return die(EXIT_USAGE, "ST-E22", "--state duplicate requires both --duplicate-of and --confidence");
  }
  if (confidence && !CONFIDENCES.has(confidence)) {
    return die(EXIT_USAGE, "ST-E22", `--confidence takes high, medium or low, got "${confidence}"`);
  }
  if (state === "thin" && !missing) {
    return die(EXIT_USAGE, "ST-E24", "--state thin requires --missing <a,b,c>; the question and its hash come from that list");
  }

  const journalPath = args.journalPath();
  const { records } = readJournal(journalPath);
  if (violations.length > 0) {
    printViolations();
    return EXIT_MISSING;
  }

  const prior = fold(records).get(key(channel, ts)) || null;
  const now = isoNow(args.value("--now"));

  // A terminal row is the workflow's promise that a Jira outcome exists. Re-stating it as something
  // else would make a later run refile a bug that is already open.
  if (prior && TERMINAL_STATES.has(prior.state)) {
    const sameOutcome =
      prior.state === state &&
      (prior.jira_key ?? null) === (jiraKey ?? null) &&
      (prior.duplicate_of ?? null) === (duplicateOf ?? null);
    if (!sameOutcome) {
      return die(
        EXIT_REFUSED,
        "ST-E23",
        `${channel}/${ts} is already ${prior.state}${prior.jira_key ? ` as ${prior.jira_key}` : ""}${
          prior.duplicate_of ? ` of ${prior.duplicate_of}` : ""
        }; refusing to re-state it as ${state}`,
      );
    }
  }

  if (prior?.claimed_at && new Date(now) < new Date(prior.claimed_at)) {
    return die(
      EXIT_VIOLATIONS,
      "ST-E30",
      `--now ${now} is earlier than the claim at ${prior.claimed_at}; a clock moving backwards makes every lease meaningless`,
    );
  }

  const missingFields = missing ? missing.split(",").map((s) => s.trim()).filter(Boolean) : null;
  const reactions = args.values("--reaction");

  const record = {
    v: RECORD_VERSION,
    channel,
    message_ts: ts,
    thread_ts: prior?.thread_ts ?? null,
    run_id: args.value("--run-id") ?? prior?.run_id ?? null,
    state,
    author: prior?.author ?? null,
    text_sha256: args.value("--text-sha256") ?? prior?.text_sha256 ?? null,
    permalink: prior?.permalink ?? null,
    jira_key: jiraKey ?? null,
    duplicate_of: duplicateOf ?? null,
    confidence: confidence ?? null,
    justification: args.value("--justification") ?? null,
    missing_fields: missingFields,
    question_sha256: questionHash(missingFields),
    // Reactions and the reply are recorded separately on purpose: a run that posted the reply and
    // failed the reaction must be able to finish the reaction without posting a second reply.
    reactions_applied: reactions.length > 0 ? reactions : (prior?.reactions_applied ?? null),
    reply_ts: args.value("--reply-ts") ?? prior?.reply_ts ?? null,
    claimed_at: prior?.claimed_at ?? null,
    lease_expires_at: prior?.lease_expires_at ?? null,
    updated_at: now,
    note: args.value("--note") ?? null,
  };

  if (prior && meaningful(prior) === meaningful(record)) {
    process.stdout.write(`unchanged — ${channel}/${ts} is already ${state}\n`);
    return EXIT_CLEAN;
  }

  appendLine(journalPath, record);
  const extra = jiraKey ? ` ${jiraKey}` : duplicateOf ? ` of ${duplicateOf} (${confidence})` : "";
  process.stdout.write(`recorded ${channel}/${ts} ${state}${extra}\n`);
  return EXIT_CLEAN;
}

function cmdGet(args) {
  const channel = args.value("--channel");
  const ts = args.value("--ts");
  if (!channel || !ts) return die(EXIT_USAGE, "ST-E20", "get requires --channel <C> and --ts <ts>");

  const journalPath = args.journalPath();
  const { records, missing } = readJournal(journalPath);
  if (missing) return die(EXIT_MISSING, "ST-E10", `journal not found: ${journalPath}`);
  if (violations.length > 0) {
    printViolations();
    return EXIT_MISSING;
  }

  const rec = fold(records).get(key(channel, ts));
  if (!rec) {
    process.stdout.write(`no record for ${channel}/${ts}\n`);
    return EXIT_CLEAN;
  }
  const { __line, ...clean } = rec;
  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify(clean, null, 2)}\n`);
    return EXIT_CLEAN;
  }
  for (const [name] of FIELDS) {
    if (clean[name] === undefined || clean[name] === null) continue;
    const value = Array.isArray(clean[name]) ? clean[name].join(", ") : clean[name];
    process.stdout.write(`${name.padEnd(18)} ${value}\n`);
  }
  return EXIT_CLEAN;
}

function cmdValidate(args) {
  const journalPath = args.journalPath();
  const { records, missing } = readJournal(journalPath);
  if (missing) {
    process.stdout.write(`no journal at ${journalPath} — nothing to validate\n`);
    return EXIT_CLEAN;
  }

  records.forEach((rec) => {
    const at = `line ${rec.__line}`;
    for (const field of ["channel", "message_ts", "state"]) {
      if (rec[field] === undefined || rec[field] === null || String(rec[field]).trim() === "") {
        fail("ST-E02", `record is missing \`${field}\``, at);
      }
    }
    if (rec.state !== undefined && !Object.hasOwn(STATES, rec.state)) {
      fail("ST-E03", `unknown state "${rec.state}"`, at);
    }
    if (rec.v !== undefined && Number(rec.v) > RECORD_VERSION) {
      fail("ST-E04", `record version ${rec.v} is newer than this build understands (${RECORD_VERSION})`, at);
    }
    if (rec.message_ts !== undefined && !TS_RE.test(String(rec.message_ts))) {
      fail("ST-E12", `message_ts "${rec.message_ts}" is not \\d{10}\\.\\d{6}`, at);
    }
    if (rec.state === "filed" && !rec.jira_key) fail("ST-E21", "state `filed` with no jira_key", at);
    if (rec.state === "duplicate" && (!rec.duplicate_of || !rec.confidence)) {
      fail("ST-E22", "state `duplicate` with no duplicate_of or no confidence", at);
    }
    if (rec.confidence && !CONFIDENCES.has(rec.confidence)) {
      fail("ST-E22", `confidence "${rec.confidence}" is not high, medium or low`, at);
    }
    if (rec.state === "thin" && (!rec.missing_fields || rec.missing_fields.length === 0)) {
      fail("ST-E24", "state `thin` with no missing_fields", at);
    }
  });

  // A terminal row followed by a different terminal row means two Jira outcomes for one message.
  const seenTerminal = new Map();
  for (const rec of records) {
    if (!TERMINAL_STATES.has(rec.state)) continue;
    const k = key(rec.channel, rec.message_ts);
    const before = seenTerminal.get(k);
    if (before && (before.state !== rec.state || (before.jira_key ?? null) !== (rec.jira_key ?? null))) {
      fail(
        "ST-E23",
        `${rec.channel}/${rec.message_ts} is terminal twice with different outcomes — line ${before.__line} says ${before.state}${
          before.jira_key ? ` ${before.jira_key}` : ""
        }, line ${rec.__line} says ${rec.state}${rec.jira_key ? ` ${rec.jira_key}` : ""}`,
        `line ${rec.__line}`,
      );
    }
    seenTerminal.set(k, rec);
  }

  if (args.has("--json")) {
    process.stdout.write(`${JSON.stringify({ journal: journalPath, records: records.length, violations }, null, 2)}\n`);
  } else {
    printViolations();
    if (violations.length === 0) {
      const folded = fold(records);
      process.stdout.write(`${journalPath}: ${records.length} records, ${folded.size} messages, clean\n`);
    }
  }
  if (violations.length === 0) return EXIT_CLEAN;
  return violations.some((v) => v.code === "ST-E01") ? EXIT_MISSING : EXIT_VIOLATIONS;
}

function cmdCompact(args) {
  const journalPath = args.journalPath();
  const { records, missing } = readJournal(journalPath);
  if (missing) return die(EXIT_MISSING, "ST-E10", `journal not found: ${journalPath}`);
  if (violations.length > 0) {
    printViolations();
    return EXIT_MISSING;
  }

  const folded = fold(records);
  const kept = [...folded.values()].map(({ __line, ...rec }) => rec);
  const dropped = records.length - kept.length;

  if (args.has("--dry-run")) {
    process.stdout.write(`would keep ${kept.length} of ${records.length} records (${dropped} superseded)\n`);
    return EXIT_CLEAN;
  }
  if (dropped === 0) {
    process.stdout.write(`unchanged — ${records.length} records, none superseded\n`);
    return EXIT_CLEAN;
  }

  const backup = `${journalPath}.bak`;
  writeAtomic(backup, readFileSync(journalPath, "utf8"));
  writeAtomic(journalPath, `${kept.map((r) => JSON.stringify(r)).join("\n")}\n`);
  process.stdout.write(`compacted ${records.length} -> ${kept.length} records; previous log at ${backup}\n`);
  return EXIT_CLEAN;
}

function cmdPrintSchema(args) {
  if (args.has("--json")) {
    process.stdout.write(
      `${JSON.stringify(
        {
          record_version: RECORD_VERSION,
          fields: Object.fromEntries(FIELDS),
          states: STATES,
          terminal_states: [...TERMINAL_STATES],
          handled_reactions: [...HANDLED_REACTIONS],
        },
        null,
        2,
      )}\n`,
    );
    return EXIT_CLEAN;
  }
  process.stdout.write("# Slack triage journal — record schema\n\n");
  process.stdout.write(`Record version ${RECORD_VERSION}. One JSON object per line; folded by \`(channel, message_ts)\`.\n\n`);
  process.stdout.write("## Fields\n\n| Field | Meaning |\n|---|---|\n");
  for (const [name, meaning] of FIELDS) process.stdout.write(`| \`${name}\` | ${meaning} |\n`);
  process.stdout.write("\n## States\n\n| State | Meaning |\n|---|---|\n");
  for (const [name, meaning] of Object.entries(STATES)) {
    const terminal = TERMINAL_STATES.has(name) ? " **(terminal)**" : "";
    process.stdout.write(`| \`${name}\` | ${meaning}${terminal} |\n`);
  }
  return EXIT_CLEAN;
}

/* ------------------------------------------------------------------ *
 * argv
 * ------------------------------------------------------------------ */

const VALUE_FLAGS = new Set([
  "--journal",
  "--intake",
  "--run-id",
  "--lease-minutes",
  "--limit",
  "--now",
  "--reactions-readable",
  "--channel",
  "--ts",
  "--state",
  "--jira-key",
  "--duplicate-of",
  "--confidence",
  "--justification",
  "--missing",
  "--reaction",
  "--reply-ts",
  "--text-sha256",
  "--note",
]);

const BOOL_FLAGS = new Set([
  "--json",
  "--markdown",
  "--strict",
  "--dry-run",
  "--include-skipped",
  "--include-escalated",
]);

function parseArgs(argv) {
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (BOOL_FLAGS.has(arg)) {
      flags.add(arg);
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { error: `${arg} needs a value` };
      }
      if (!values.has(arg)) values.set(arg, []);
      values.get(arg).push(next);
      i += 1;
      continue;
    }
    return { error: `unknown flag ${arg}` };
  }
  return {
    positional,
    has: (f) => flags.has(f),
    value: (f) => values.get(f)?.[0],
    values: (f) => values.get(f) ?? [],
    journalPath: () => resolve(repoRoot, values.get("--journal")?.[0] ?? DEFAULT_JOURNAL),
  };
}

const USAGE = `Usage:
  node scripts/slack-triage-journal.mjs plan     --intake <path> [--reactions-readable yes|no]
                                                 [--run-id <ID>] [--lease-minutes <n>] [--limit <n>]
                                                 [--now <iso>] [--json]
                                                 [--include-skipped] [--include-escalated]
  node scripts/slack-triage-journal.mjs claim    --intake <path> --run-id <ID> [--lease-minutes <n>]
                                                 [--limit <n>] [--now <iso>] [--json]

  --limit <n> caps how many messages the run works, keeping the oldest ones nobody has handled.
              Rows beyond it stay listed, as deferred_over_limit.
  node scripts/slack-triage-journal.mjs record   --channel <C> --ts <ts> --state <state> [...]
  node scripts/slack-triage-journal.mjs get      --channel <C> --ts <ts> [--json]
  node scripts/slack-triage-journal.mjs validate [--strict] [--json]
  node scripts/slack-triage-journal.mjs compact  [--dry-run]
  node scripts/slack-triage-journal.mjs print-schema [--json]

  --journal <path> overrides .slack-triage/journal.jsonl on every command.
`;

function main(argv) {
  const command = argv[0];
  const parsed = parseArgs(argv.slice(1));
  if (parsed.error) {
    process.stderr.write(`[ST-E20] ${parsed.error}\n\n${USAGE}`);
    return EXIT_USAGE;
  }

  switch (command) {
    case "plan":
      return cmdPlan(parsed);
    case "claim":
      return cmdClaim(parsed);
    case "record":
      return cmdRecord(parsed);
    case "get":
      return cmdGet(parsed);
    case "validate":
      return cmdValidate(parsed);
    case "compact":
      return cmdCompact(parsed);
    case "print-schema":
      return cmdPrintSchema(parsed);
    default:
      process.stderr.write(`[ST-E20] ${command ? `unknown command "${command}"` : "no command given"}\n\n${USAGE}`);
      return EXIT_USAGE;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { STATES, TERMINAL_STATES, HANDLED_REACTIONS, FIELDS, RECORD_VERSION, decide, questionHash };
