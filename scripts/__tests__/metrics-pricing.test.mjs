/**
 * Tests for .claude/hooks/lib/pricing.mjs and the `Cost` column it feeds.
 *
 * Two halves. The unit half checks the arithmetic: the four token classes carry different multipliers,
 * so a bug that bills cache reads at the input rate is a 10x error that looks perfectly plausible on
 * the page, and the two cache-write TTLs differ by 60%. The integration half checks that the column
 * prices the run's `billed` block and only that — a legacy final-turn block is never priced into it,
 * because a plausible number in a cost table is worse than no number at all.
 *
 * Every expected dollar figure here is computed by hand in the test, from the published per-MTok
 * rates, rather than by calling the module under test with different arguments.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  RATES,
  RATES_AS_OF,
  ASSUMED_CACHE_TTL,
  normalizeModel,
  rateFor,
  priceTokens,
  priceBilled,
  priceRow,
  formatUsd,
} from "../../.claude/hooks/lib/pricing.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const report = join(repoRoot, ".claude", "hooks", "metrics-report.mjs");

const close = (actual, expected, what) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${what}: got ${actual}, expected ${expected}`);

// ---------------------------------------------------------------------------------------------
// The rate table
// ---------------------------------------------------------------------------------------------

test("a model string keeps its identity through a context marker and a date snapshot", () => {
  assert.equal(normalizeModel("claude-opus-5"), "claude-opus-5");
  assert.equal(normalizeModel("claude-opus-5[1m]"), "claude-opus-5");
  assert.equal(normalizeModel("claude-haiku-4-5-20251001"), "claude-haiku-4-5");
  assert.equal(normalizeModel("  claude-sonnet-5  "), "claude-sonnet-5");
});

test("an unknown model is unpriced, not guessed at from its name", () => {
  assert.equal(normalizeModel("claude-opus-9"), null);
  assert.equal(normalizeModel("some-other-vendor-model"), null);
  assert.equal(normalizeModel(null), null);
  assert.equal(normalizeModel(""), null);
  assert.equal(priceTokens({ output: 1_000_000 }, "claude-opus-9", "2026-08-19"), null);
});

test("the rate is chosen by the record's own date — the sonnet-5 intro price expires", () => {
  const intro = rateFor("claude-sonnet-5", "2026-08-31T23:59:00Z");
  const full = rateFor("claude-sonnet-5", "2026-09-01T00:00:01Z");
  assert.deepEqual([intro.input, intro.output], [2, 10]);
  assert.deepEqual([full.input, full.output], [3, 15]);
});

test("a record with no usable start time is unpriced rather than priced at today's rate", () => {
  assert.equal(rateFor("claude-sonnet-5", null), null);
  assert.equal(rateFor("claude-sonnet-5", "not a date"), null);
  assert.equal(priceRow({ end_context: { output: 1000 }, model: "claude-sonnet-5" }), null);
});

test("every rate period is well-formed: ordered, non-overlapping, positive", () => {
  for (const [model, periods] of Object.entries(RATES)) {
    let previousUntil = -Infinity;
    for (const p of periods) {
      const from = p.from === null ? -Infinity : Date.parse(p.from);
      const until = p.until === null ? Infinity : Date.parse(p.until);
      assert.ok(from < until, `${model}: period starts after it ends`);
      assert.ok(from >= previousUntil, `${model}: periods overlap or are out of order`);
      assert.ok(p.input > 0 && p.output > 0, `${model}: non-positive rate`);
      assert.ok(p.output >= p.input, `${model}: output should not be cheaper than input`);
      previousUntil = until;
    }
    assert.equal(periods.at(-1).until, null, `${model}: no period is current`);
  }
});

// ---------------------------------------------------------------------------------------------
// The arithmetic
// ---------------------------------------------------------------------------------------------

test("each token class is billed at its own multiple of the input rate", () => {
  const priced = priceTokens(
    { input: 1_000_000, output: 1_000_000, cache_read: 1_000_000, cache_creation: 1_000_000 },
    "claude-opus-5",
    "2026-08-19T00:00:00Z",
  );
  // 5 + 25 + (5 * 0.1) + (5 * 1.25) = 36.75. Billing cache reads at the input rate would give 41.25,
  // which is the plausible-looking 10x error this case exists to catch.
  close(priced.usd, 36.75, "per-class rates");
  assert.equal(priced.model, "claude-opus-5");
});

test("a real final-turn row prices to the hand-computed figure", () => {
  // SCRUM-132 seq 10 — 115 tool calls, a few cents for its last turn. Kept as the legacy shape's check.
  const priced = priceTokens(
    { input: 2, output: 1214, cache_read: 282_887, cache_creation: 1562 },
    "claude-sonnet-5",
    "2026-08-10T00:00:00Z",
  );
  const expected = (2 * 2) / 1e6 + (1214 * 10) / 1e6 + (282_887 * 0.2) / 1e6 + (1562 * 2.5) / 1e6;
  close(priced.usd, expected, "seq 10");
});

test("a missing token class is zero, but a missing usage object is unpriced", () => {
  const priced = priceTokens({ output: 1000 }, "claude-opus-5", "2026-08-19T00:00:00Z");
  close(priced.usd, 0.025, "output only");
  assert.equal(priceRow({ model: "claude-opus-5", started_at: "2026-08-19T00:00:00Z" }), null);
});

test("the assumptions ride on a final-turn result, so a figure cannot be read without them", () => {
  const priced = priceTokens({ output: 1 }, "claude-opus-5", "2026-08-19T00:00:00Z");
  assert.equal(priced.assumed_cache_ttl, ASSUMED_CACHE_TTL);
  assert.equal(priced.assumes_standard_speed, true);
  assert.equal(priced.rates_as_of, RATES_AS_OF);
});

test("the 1-hour cache TTL costs more than the 5-minute one", () => {
  const short = priceTokens({ cache_creation: 1e6 }, "claude-opus-5", "2026-08-19T00:00:00Z");
  const long = priceTokens({ cache_creation: 1e6 }, "claude-opus-5", "2026-08-19T00:00:00Z", { cacheTtl: "1h" });
  close(short.usd, 6.25, "5m write");
  close(long.usd, 10, "1h write");
});

// ---------------------------------------------------------------------------------------------
// The run's bill
// ---------------------------------------------------------------------------------------------

const billed = (over = {}) => ({
  scope: "run",
  api_calls: 3,
  input: 0,
  output: 0,
  cache_read: 0,
  cache_write: 0,
  cache_write_5m: 0,
  cache_write_1h: 0,
  cache_write_unknown_ttl: 0,
  total: 0,
  tool_uses: 3,
  speed: "standard",
  model: "claude-opus-5",
  by_model: { "claude-opus-5": { input: 0, output: 0, cache_read: 0, cache_write_5m: 0, cache_write_1h: 0, cache_write_unknown_ttl: 0 } },
  ...over,
});

test("a bill honours the TTL split per class, and assumes nothing when the split is complete", () => {
  const priced = priceBilled(
    billed({
      by_model: {
        "claude-opus-5": { input: 1e6, output: 1e6, cache_read: 1e6, cache_write_5m: 1e6, cache_write_1h: 1e6, cache_write_unknown_ttl: 0 },
      },
    }),
    "2026-08-19T00:00:00Z",
  );
  // 5 + 25 + 0.5 + 6.25 + 10
  close(priced.usd, 46.75, "all five classes");
  assert.equal(priced.assumed_ttl_tokens, 0);
  assert.deepEqual(priced.models, ["claude-opus-5"]);
  assert.equal(priced.scope, "run_list_price");
});

test("a cache write with no recorded TTL is priced at the 5m rate and counted as assumed", () => {
  const priced = priceBilled(
    billed({ by_model: { "claude-opus-5": { cache_write_unknown_ttl: 1e6 } } }),
    "2026-08-19T00:00:00Z",
  );
  close(priced.usd, 6.25, "assumed 5m");
  assert.equal(priced.assumed_ttl_tokens, 1e6, "the footnote counts these; the figure does not hide them");
});

test("a run that switched models is priced per model at each one's rate", () => {
  const priced = priceBilled(
    billed({
      model: "mixed",
      by_model: {
        "claude-sonnet-5": { output: 1e6 },
        "claude-opus-5": { output: 1e6 },
      },
    }),
    "2026-08-19T00:00:00Z",
  );
  close(priced.usd, 10 + 25, "sonnet intro + opus");
  assert.deepEqual(priced.models.sort(), ["claude-opus-5", "claude-sonnet-5"]);
});

test("a run at a non-standard speed, or on an unknown model, is unpriced with the reason named", () => {
  const fast = priceBilled(billed({ speed: "fast" }), "2026-08-19T00:00:00Z");
  assert.equal(fast.usd, null);
  assert.equal(fast.reason, "speed:fast");

  const unknown = priceBilled(billed({ by_model: { "claude-opus-9": { output: 1 } } }), "2026-08-19T00:00:00Z");
  assert.equal(unknown.usd, null);
  assert.equal(unknown.reason, "unknown_model:claude-opus-9");

  const undated = priceBilled(billed(), null);
  assert.equal(undated.usd, null);
  assert.equal(undated.reason, "no_start_date");

  assert.equal(priceBilled(null, "2026-08-19T00:00:00Z").usd, null);
});

test("dollars render at cent precision once they reach a cent, and never as zero for a real figure", () => {
  assert.equal(formatUsd(7.384), "$7.38");
  assert.equal(formatUsd(0.0721), "$0.07");
  assert.equal(formatUsd(0.0061), "$0.0061");
  assert.equal(formatUsd(0.00001), "<$0.0001");
  assert.equal(formatUsd(0), "$0.0000");
  assert.equal(formatUsd(null), "—");
});

// ---------------------------------------------------------------------------------------------
// The column
// ---------------------------------------------------------------------------------------------

/** A throwaway project root holding one metrics log, and an empty Claude config so nothing is reconciled from disk. */
function projectWith(ticket, records) {
  const dir = mkdtempSync(join(tmpdir(), "metrics-pricing-"));
  writeFileSync(join(dir, ".git"), "gitdir: irrelevant\n", "utf8");
  mkdirSync(join(dir, ".workflow", "metrics"), { recursive: true });
  writeFileSync(
    join(dir, ".workflow", "metrics", `${ticket}.jsonl`),
    records.map((r) => JSON.stringify(r)).join("\n") + "\n",
    "utf8",
  );
  const config = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(config, "projects"), { recursive: true });
  return { dir, config };
}

const row = (over = {}) => ({
  seq: 1,
  ticket: "SCRUM-900",
  agent: "qa-scenario-generator",
  status: "completed",
  model: "claude-opus-5",
  started_at: "2026-08-19T00:00:00Z",
  finished_at: "2026-08-19T00:02:00Z",
  duration_ms: 120_000,
  tool_uses: 20,
  billed: billed({
    output: 1_000_000,
    total: 1_000_000,
    by_model: { "claude-opus-5": { output: 1_000_000 } },
  }),
  ...over,
});

function runReport({ dir, config }, ...args) {
  const result = spawnSync(process.execPath, [report, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: config },
  });
  assert.equal(result.error, undefined, `failed to spawn: ${result.error?.message}`);
  return result;
}

test("the table carries the Cost column, and its header and separator agree in both widths", () => {
  const p = projectWith("SCRUM-900", [row()]);
  for (const flags of [[], ["--detail"]]) {
    const { status, stdout } = runReport(p, "SCRUM-900", "--no-reconcile", ...flags);
    assert.equal(status, 0, stdout);
    const lines = stdout.split("\n").filter((l) => l.startsWith("|"));
    assert.ok(lines[0].endsWith("| Cost |") || lines[0].includes("| Cost | Prompt chars |"), lines[0]);
    // A column added to the header and not to the separator renders as unformatted text in every
    // markdown viewer, which is exactly the kind of break nobody notices in a terminal.
    const cells = (l) => l.split("|").length;
    assert.equal(cells(lines[1]), cells(lines[0]), "separator width");
    for (const l of lines.slice(2)) assert.equal(cells(l), cells(lines[0]), `row width: ${l}`);
    assert.ok(stdout.includes("$25.00"), stdout); // 1M output tokens on Opus 5
  }
});

test("the footnote says the column is the run's bill and dates its rates", () => {
  const p = projectWith("SCRUM-900", [row()]);
  const { stdout } = runReport(p, "SCRUM-900", "--no-reconcile");
  assert.match(stdout, /Tokens and Cost are the run's bill/);
  assert.ok(stdout.includes(`list rates as of ${RATES_AS_OF}`), "the footnote dates its rates");
  assert.ok(!stdout.includes("not what the run cost"), "the old disclaimer has nothing left to disclaim");
});

test("an unpriceable row shows a dash and is counted, not silently dropped from the total", () => {
  const p = projectWith("SCRUM-900", [
    row(),
    row({
      seq: 2,
      agent: "qa-scenario-reviewer",
      billed: billed({ model: "claude-unknown-9", by_model: { "claude-unknown-9": { output: 5 } }, total: 5 }),
    }),
  ]);
  const { stdout } = runReport(p, "SCRUM-900", "--no-reconcile");
  assert.match(stdout, /1 run\(s\) carry token counts but no price \(unknown_model:claude-unknown-9\)/);
  // The Σ prices only what could be priced — and the sentence above is what stops that reading as all.
  assert.ok(stdout.includes("**$25.00**"), stdout);
});

test("a background row with no bill has no price to show", () => {
  const p = projectWith("SCRUM-900", [
    { seq: 1, ticket: "SCRUM-900", agent: "a", status: "background", model: "claude-opus-5", billed: null, prompt_chars: 900 },
  ]);
  const { stdout } = runReport(p, "SCRUM-900", "--no-reconcile");
  assert.ok(!/\$\d/.test(stdout), stdout);
  assert.ok(!stdout.includes("carry token counts but no price"), stdout);
});

test("--json carries the per-record price and the pricing block that qualifies it", () => {
  const p = projectWith("SCRUM-900", [
    row(),
    row({ seq: 2, billed: billed({ model: "claude-unknown-9", by_model: { "claude-unknown-9": { output: 5 } }, total: 5 }) }),
  ]);
  const { status, stdout } = runReport(p, "SCRUM-900", "--no-reconcile", "--json");
  assert.equal(status, 0, stdout);
  const payload = JSON.parse(stdout);
  close(payload.total_usd, 25, "json total");
  assert.equal(payload.pricing.priced_rows, 1);
  assert.equal(payload.pricing.unpriced_rows_with_tokens, 1);
  assert.equal(payload.pricing.scope, "run_list_price");
  assert.equal(payload.pricing.rates_as_of, RATES_AS_OF);
  close(payload.records[0].cost_usd, 25, "json record");
  assert.equal(payload.records[1].cost_usd, null);
  assert.equal(payload.records[1].cost_unpriced_reason, "unknown_model:claude-unknown-9");
});

test("a log with nothing priceable reports no total rather than a total of zero", () => {
  const p = projectWith("SCRUM-900", [
    row({ billed: billed({ model: "claude-unknown-9", by_model: { "claude-unknown-9": { output: 5 } }, total: 5 }) }),
  ]);
  const { stdout } = runReport(p, "SCRUM-900", "--no-reconcile", "--json");
  assert.equal(JSON.parse(stdout).total_usd, null);
});
