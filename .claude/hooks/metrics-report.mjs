#!/usr/bin/env node
/**
 * Renders `.workflow/metrics/<TICKET-ID>.jsonl` as the run-cost table the orchestrator prints at the
 * end of a workflow: one row per agent run in the order the runs were recorded, then a total.
 *
 *   node .claude/hooks/metrics-report.mjs SCRUM-139                 # markdown table
 *   node .claude/hooks/metrics-report.mjs SCRUM-139 --detail        # + the in/out/cache split
 *   node .claude/hooks/metrics-report.mjs SCRUM-139 --json          # aggregate + one entry per run
 *   node .claude/hooks/metrics-report.mjs SCRUM-139 --last <agent>  # one AGENT_RUN_METRICS line
 *   node .claude/hooks/metrics-report.mjs SCRUM-139 --no-reconcile  # read only, change nothing
 *
 * Multiple runs of the same agent stay as separate rows on purpose — the iteration count is the
 * point of the table.
 *
 * WHAT `Tokens` AND `Cost` ARE. The run's bill: every API call the agent made, summed from its own
 * transcript under `~/.claude/projects/` — input, output, cache read and cache write, with the model,
 * the cache TTL and the speed read off each call — and priced at the list rates in `lib/pricing.mjs`.
 * Nothing in those two columns is assumed. Earlier versions of this report printed the agent's
 * final-turn context under the heading `End context` and priced *that*, with three paragraphs
 * explaining why the number was not what it looked like; the transcript makes the number that was
 * wanted available, so the columns now hold it and the paragraphs are gone.
 *
 * RECONCILIATION, in two passes, both idempotent. (1) A launch that never produced a completion row
 * sits in `metrics/pending/`; it is promoted into the log exactly once — priced from its transcript
 * when one exists, marked `interrupted` when it does not. (2) Any row without a `billed` block — a
 * background launch the hook could only name, or a row written before this measure existed — is
 * completed from its transcript, found by `agent_id` or through the `.meta.json` beside it by
 * `tool_use_id`. The log is rewritten whole, atomically, only when something changed.
 *
 * WHAT CANNOT BE PRICED IS COUNTED, NOT ESTIMATED. An interrupted run has no bill on record. A
 * background run whose session directory is gone has no transcript to read. A pre-transcript row
 * carries only its final-turn context. Each case has its own footnote with its own count, and no
 * row lands in two of them.
 *
 * NOTHING HERE EVER CRASHES ON BAD DATA. This is the last thing a `DECLINED` or `PAUSED` return
 * prints, and a throw at that point would destroy the whole cost section — which is exactly the
 * record that matters most when a run stopped early. A torn line is skipped and counted.
 */

import { readFileSync, existsSync, readdirSync, unlinkSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import path from "node:path";
import { resolveProjectDir, metricsDir, metricsFile, pendingDir } from "./lib/paths.mjs";
import { priceBilled, priceRow, formatUsd, RATES_AS_OF, ASSUMED_CACHE_TTL } from "./lib/pricing.mjs";
import { billedForRun } from "./lib/transcript-usage.mjs";
import { metricsLine } from "./agent-metrics.mjs";

const argv = process.argv.slice(2);
const ticket = argv[0];
const asJson = argv.includes("--json");
const detail = argv.includes("--detail");
const reconcile = !argv.includes("--no-reconcile");
const lastIdx = argv.indexOf("--last");
const lastAgent = lastIdx >= 0 ? (argv[lastIdx + 1] && !argv[lastIdx + 1].startsWith("--") ? argv[lastIdx + 1] : "*") : null;

if (!ticket || ticket.startsWith("--")) {
  console.error(
    "usage: node .claude/hooks/metrics-report.mjs <TICKET-ID> [--json] [--detail] [--last <agent>] [--no-reconcile]",
  );
  process.exit(1);
}

const projectDir = resolveProjectDir(null);
const file = metricsFile(projectDir, ticket);

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const TERMINAL_FAILURES = new Set(["interrupted", "timed_out", "failed"]);

/** Fold a transcript summary into a row. Only fills what the row lacks; never overwrites a measurement. */
function complete(row, billed) {
  const { agent_id, request_shape, ...block } = billed;
  row.billed = block;
  row.agent_id ??= agent_id;
  row.model = row.model ?? billed.model;
  row.duration_ms = num(row.duration_ms) ?? billed.duration_ms;
  row.finished_at ??= billed.finished_at;
  row.tool_uses = num(row.tool_uses) ?? billed.tool_uses;
  if (request_shape) row.request_shape = request_shape;
  if (row.status === "background" || row.status === "async_uncosted" || row.status == null) {
    row.status = billed.complete ? "completed" : "incomplete";
  }
  row.cost_source = "subagent_transcript";
  delete row.reason;
  return row;
}

/** Promote every unreconciled launch record for this ticket into the log, once. */
function reconcilePending() {
  const dir = pendingDir(projectDir);
  const result = { promoted: 0, otherTickets: new Set() };
  if (!existsSync(dir)) return result;
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const pendingPath = path.join(dir, name);
    let record;
    try {
      record = JSON.parse(readFileSync(pendingPath, "utf8"));
    } catch {
      continue;
    }
    if (record?.ticket !== ticket) {
      if (record?.ticket) result.otherTickets.add(record.ticket);
      continue;
    }
    try {
      mkdirSync(metricsDir(projectDir), { recursive: true });
      const seq = existsSync(file)
        ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()).length + 1
        : 1;
      const row = {
        seq,
        ticket,
        ticket_source: record.ticket_source ?? null,
        tool_use_id: record.tool_use_id ?? null,
        agent: record.agent ?? "unknown",
        description: record.description ?? "",
        step: record.step ?? null,
        run_mode: record.run_mode ?? null,
        prompt_chars: record.prompt_chars ?? null,
        // A launch with no completion row. If its transcript is on disk the run happened and can be
        // priced; if not, and it was not a background launch, the session died underneath it.
        status: record.async ? "background" : "interrupted",
        model: null,
        agent_id: record.agent_id ?? null,
        started_at: record.started_at ?? null,
        started_at_measured: Boolean(record.started_at),
        finished_at: null,
        duration_ms: null,
        end_context: null,
        billed: null,
        tool_uses: null,
        reason: record.async ? "launch_record_only" : "no_completion_record",
        session_id: record.session_id ?? null,
      };
      const billed = billedForRun({
        sessionId: row.session_id,
        agentId: row.agent_id,
        toolUseId: row.tool_use_id,
      });
      if (billed) {
        // The transcript is the completion record the hook never got. `interrupted` stays only when the
        // transcript itself ends mid-run.
        row.status = record.async ? "background" : billed.complete ? "completed" : "interrupted";
        complete(row, billed);
        if (!billed.complete && !record.async) row.status = "interrupted";
      }
      appendFileSync(file, `${JSON.stringify(row)}\n`, "utf8");
      unlinkSync(pendingPath);
      result.promoted += 1;
    } catch {
      /* leave it pending; the next report tries again */
    }
  }
  return result;
}

function appendFileSync(target, text, enc) {
  writeFileSync(target, (existsSync(target) ? readFileSync(target, enc) : "") + text, enc);
}

/** Read the log; a torn line is skipped and counted, never fatal. */
function readRows() {
  let skipped = 0;
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        skipped += 1;
        return null;
      }
    })
    .filter(Boolean);
  return { rows, skipped };
}

/**
 * Complete every row that has no bill yet and whose transcript is on this machine. Rewrites the log
 * only when a row changed, atomically, preserving `seq` and the torn lines' absence.
 */
function reconcileRows(rows) {
  let changed = 0;
  for (const row of rows) {
    if (row.billed || TERMINAL_FAILURES.has(row.status)) continue;
    if (!row.session_id || (!row.agent_id && !row.tool_use_id)) continue;
    const billed = billedForRun({ sessionId: row.session_id, agentId: row.agent_id, toolUseId: row.tool_use_id });
    if (!billed) continue;
    complete(row, billed);
    changed += 1;
  }
  if (changed > 0) {
    const tmp = `${file}.tmp-${process.pid}`;
    writeFileSync(tmp, rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    renameSync(tmp, file);
  }
  return changed;
}

// ---------------------------------------------------------------------------------------------

const pendingResult = reconcile ? reconcilePending() : { promoted: 0, otherTickets: new Set() };

if (!existsSync(file)) {
  console.log(`No metrics recorded for ${ticket} (${file} does not exist).`);
  process.exit(0);
}

const { rows, skipped } = readRows();
const reconciled = reconcile ? reconcileRows(rows) : 0;

/** Which footnote a row without a bill belongs to. Exactly one. */
function bucket(row) {
  if (row.billed) return "billed";
  if (TERMINAL_FAILURES.has(row.status)) return "interrupted";
  if (row.status === "background" || row.status === "async_uncosted" || row.status === "incomplete") return "unobserved";
  if (row.end_context || row.tokens) return "legacy";
  return "unobserved";
}

const runsPerAgent = rows.reduce((m, r) => m.set(r.agent, (m.get(r.agent) ?? 0) + 1), new Map());

const records = (() => {
  const iteration = new Map();
  return rows.map((r) => {
    const i = (iteration.get(r.agent) ?? 0) + 1;
    iteration.set(r.agent, i);
    const price = r.billed ? priceBilled(r.billed, r.started_at) : null;
    return {
      seq: r.seq ?? null,
      step: r.step ?? null,
      agent: r.agent ?? "unknown",
      run: i,
      runs_for_agent: runsPerAgent.get(r.agent) ?? 1,
      run_mode: r.run_mode ?? null,
      status: r.status ?? "unknown",
      model: r.billed?.model ?? r.model ?? null,
      api_calls: num(r.billed?.api_calls),
      tool_uses: num(r.tool_uses),
      tool_stats: r.tool_stats ?? null,
      duration_ms: num(r.duration_ms),
      prompt_chars: num(r.prompt_chars),
      billed: r.billed ?? null,
      cost_usd: price?.usd ?? null,
      cost_unpriced_reason: price && price.usd === null ? price.reason : null,
      cost_assumed_ttl_tokens: price?.assumed_ttl_tokens ?? 0,
      // Kept for legacy rows and for anyone who wants the final-turn context; never the run's cost.
      end_context: r.end_context ?? (r.tokens ? { ...r.tokens, scope: "final_turn" } : null),
      end_context_usd: r.billed ? null : priceRow(r),
      bucket: bucket(r),
      cost_source: r.cost_source ?? null,
      started_at: r.started_at ?? null,
      started_at_measured: Boolean(r.started_at_measured),
      finished_at: r.finished_at ?? null,
      description: r.description ?? "",
    };
  });
})();

// `--last`: one line for the orchestrator, after reconciliation, for the most recent run of an agent.
if (lastAgent !== null) {
  const pick = [...rows].reverse().find((r) => lastAgent === "*" || r.agent === lastAgent);
  if (!pick) {
    console.log(`AGENT_RUN_METRICS: unavailable — no run of ${lastAgent} recorded for ${ticket}`);
  } else {
    console.log(metricsLine(pick, ticket));
  }
  process.exit(0);
}

const billedRows = records.filter((r) => r.bucket === "billed");
const priced = billedRows.filter((r) => r.cost_usd !== null);
const unpriced = billedRows.filter((r) => r.cost_usd === null);
const counts = {
  interrupted: records.filter((r) => r.bucket === "interrupted").length,
  unobserved: records.filter((r) => r.bucket === "unobserved").length,
  legacy: records.filter((r) => r.bucket === "legacy").length,
};

const sum = (list, f) => list.reduce((a, r) => a + (f(r) ?? 0), 0);
const total = {
  // Measured on interrupted and legacy rows too, so these two span every row that has them.
  duration_ms: sum(records, (r) => r.duration_ms),
  tool_uses: sum(records, (r) => r.tool_uses),
  // Billed rows only.
  api_calls: sum(billedRows, (r) => r.api_calls),
  tokens: sum(billedRows, (r) => r.billed.total),
  input: sum(billedRows, (r) => r.billed.input),
  output: sum(billedRows, (r) => r.billed.output),
  cache_read: sum(billedRows, (r) => r.billed.cache_read),
  cache_write: sum(billedRows, (r) => r.billed.cache_write),
};
const totalUsd = priced.length ? sum(priced, (r) => r.cost_usd) : null;
const assumedTtlTokens = sum(priced, (r) => r.cost_assumed_ttl_tokens);
const totalPromptChars = records.some((r) => r.prompt_chars !== null) ? sum(records, (r) => r.prompt_chars) : null;

/**
 * Wall clock spans one session — first launch to last finish — and the sum of durations exceeds it
 * whenever two streams ran in parallel. A log that accumulates across sessions (a resume days later)
 * is grouped by `session_id`, and the figure printed is the latest session's; spanning them all would
 * print the calendar, not the run.
 */
const bySession = new Map();
for (const r of rows) {
  const key = r.session_id ?? "(no session)";
  const s = bySession.get(key) ?? { runs: 0, starts: [], finishes: [] };
  s.runs += 1;
  const st = Date.parse(r.started_at ?? "");
  const fi = Date.parse(r.finished_at ?? "");
  if (Number.isFinite(st)) s.starts.push(st);
  if (Number.isFinite(fi)) s.finishes.push(fi);
  bySession.set(key, s);
}
const latestSession = [...bySession.entries()]
  .filter(([, s]) => s.starts.length && s.finishes.length)
  .sort((a, b) => Math.max(...b[1].starts) - Math.max(...a[1].starts))[0] ?? null;
const wallClockMs = latestSession
  ? Math.max(...latestSession[1].finishes) - Math.min(...latestSession[1].starts)
  : null;
const wallClockRuns = latestSession ? latestSession[1].runs : 0;
const latestSessionDurationMs = latestSession
  ? sum(records.filter((r) => (rows[records.indexOf(r)]?.session_id ?? "(no session)") === latestSession[0]), (r) => r.duration_ms)
  : 0;

if (asJson) {
  console.log(
    JSON.stringify(
      {
        ticket,
        runs: rows.length,
        billed_runs: billedRows.length,
        interrupted: counts.interrupted,
        unobserved: counts.unobserved,
        legacy_final_turn_only: counts.legacy,
        unreadable_lines: skipped,
        promoted_this_run: pendingResult.promoted,
        reconciled_this_run: reconciled,
        totals_scope: "billed_sum_over_api_calls",
        total,
        total_usd: totalUsd,
        pricing: {
          rates_as_of: RATES_AS_OF,
          priced_rows: priced.length,
          unpriced_rows_with_tokens: unpriced.length,
          assumed_ttl_tokens: assumedTtlTokens,
          scope: "run_list_price",
        },
        wall_clock_ms: wallClockMs,
        wall_clock_scope: latestSession ? { session_id: latestSession[0], runs: wallClockRuns, sessions_in_log: bySession.size } : null,
        pending_for_other_tickets: [...pendingResult.otherTickets].sort(),
        records,
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;
const n = (v) => (v === null || v === undefined ? "—" : v.toLocaleString("en-US"));
const dur = (v) => (num(v) === null ? "—" : secs(v));
const cell = (v) => (v === null || v === undefined ? "—" : String(v));

console.log(`### Agent run cost — ${ticket}\n`);
const headCols = ["#", "Step", "Agent", "Run", "Mode", "Status", "Model", "Calls", "Tools", "Duration", "Tokens"];
const tailCols = detail ? ["In", "Out", "Cache read", "Cache write", "Cost", "Prompt chars"] : ["Cost"];
const cols = [...headCols, ...tailCols];
console.log(`| ${cols.join(" | ")} |`);
console.log(`|${cols.map(() => "---").join("|")}|`);

for (const r of records) {
  const base = [
    r.seq,
    cell(r.step),
    `\`${r.agent}\``,
    `${r.run}/${r.runs_for_agent}`,
    cell(r.run_mode),
    r.status,
    cell(r.model),
    n(r.api_calls),
    n(r.tool_uses),
    dur(r.duration_ms),
    n(r.billed?.total ?? null),
  ];
  const tail = detail
    ? [
        n(r.billed?.input ?? null),
        n(r.billed?.output ?? null),
        n(r.billed?.cache_read ?? null),
        n(r.billed?.cache_write ?? null),
        formatUsd(r.cost_usd),
        n(r.prompt_chars),
      ]
    : [formatUsd(r.cost_usd)];
  console.log(`| ${[...base, ...tail].join(" | ")} |`);
}

const sigma = [
  "**Σ**",
  "",
  `**${rows.length} runs**`,
  "",
  "",
  "",
  "",
  `**${n(total.api_calls)}**`,
  `**${n(total.tool_uses)}**`,
  `**${secs(total.duration_ms)}**`,
  `**${n(total.tokens)}**`,
];
const sigmaTail = detail
  ? [
      `**${n(total.input)}**`,
      `**${n(total.output)}**`,
      `**${n(total.cache_read)}**`,
      `**${n(total.cache_write)}**`,
      `**${totalUsd === null ? "—" : formatUsd(totalUsd)}**`,
      `**${n(totalPromptChars)}**`,
    ]
  : [`**${totalUsd === null ? "—" : formatUsd(totalUsd)}**`];
console.log(`| ${[...sigma, ...sigmaTail].join(" | ")} |`);

console.log(
  `\n**Tokens and Cost are the run's bill.** Every API call the agent made — input, output, cache read ` +
    `and cache write — summed from its own transcript and priced at list rates as of ${RATES_AS_OF}. ` +
    `The model, the cache-write TTL and the speed are read per call from the transcript, not assumed. ` +
    `\`Calls\` is API calls and \`Tools\` is tool uses, both true counts over the run.`,
);
if (assumedTtlTokens > 0) {
  console.log(
    `${n(assumedTtlTokens)} cache-write token(s) carried no TTL in the transcript and were priced at the ` +
      `${ASSUMED_CACHE_TTL} rate.`,
  );
}
if (unpriced.length > 0) {
  const reasons = [...new Set(unpriced.map((r) => r.cost_unpriced_reason))].join(", ");
  console.log(
    `${unpriced.length} run(s) carry token counts but no price (${reasons}): a model absent from the rate ` +
      `table or a run at a non-standard speed is left blank rather than guessed.`,
  );
}

const notes = [];
const incomplete = records.filter((r) => r.status === "incomplete").length;
if (incomplete > 0) {
  notes.push(
    `${incomplete} run(s) are incomplete: the transcript ends mid-run, so their Tokens and Cost are what ` +
      `was billed before the agent stopped, not a finished run's total.`,
  );
}
if (counts.interrupted > 0) {
  notes.push(
    `${counts.interrupted} run(s) were interrupted before the agent stopped: duration where the harness ` +
      `measured one, no tokens — a run that never finished has no bill on record, and a partial sum is ` +
      `not one.`,
  );
}
if (counts.unobserved > 0) {
  notes.push(
    `${counts.unobserved} run(s) have no transcript on this machine: launched in the background, never ` +
      `observed by a completion hook, and \`~/.claude/projects\` holds no session directory for them. ` +
      `The cost existed; it is not recoverable from here.`,
  );
}
if (counts.legacy > 0) {
  notes.push(
    `${counts.legacy} row(s) carry only the final turn's context (\`end_context\`), recorded before the ` +
      `transcript measure existed and with no transcript left to re-read. They contribute duration and ` +
      `tool counts to Σ and no tokens; \`--json\` still carries the block.`,
  );
}
if (notes.length) console.log(`\n${notes.join("\n")}`);
if (skipped > 0) console.log(`${skipped} unreadable line(s) skipped.`);
if (reconciled > 0 || pendingResult.promoted > 0) {
  console.log(
    `\nReconciled this run: ${reconciled} row(s) completed from transcripts, ${pendingResult.promoted} launch ` +
      `record(s) promoted.`,
  );
}
if (pendingResult.otherTickets.size > 0) {
  console.log(
    `${pendingResult.otherTickets.size} pending launch record(s) belong to other tickets ` +
      `(${[...pendingResult.otherTickets].sort().join(", ")}); run the report for those to reconcile them.`,
  );
}

if (wallClockMs === null) {
  console.log(`\nWall clock: unavailable (no run carries both a start and a finish).`);
} else {
  const scope =
    bySession.size > 1
      ? `latest session, ${wallClockRuns} of ${rows.length} runs; ${bySession.size} sessions in this log`
      : `first start -> last finish`;
  console.log(`\nWall clock (${scope}): ${secs(wallClockMs)}`);
  if (latestSessionDurationMs > wallClockMs) {
    console.log(`Parallelism saved ${secs(latestSessionDurationMs - wallClockMs)} against serial execution.`);
  }
}
