/**
 * Tests for scripts/workflow-state.mjs.
 *
 * Same shape as the test-design lint suite: the subject is a CLI, so every case spawns it and
 * asserts on the exit code and the `WS-E<nn>` / `WS-W<nn>` codes it printed.
 *
 *   node --test scripts/__tests__/            (or: npm run test:lint)
 *
 * Two fixtures are checked in — `state-clean.yaml`, the document every other case is derived from,
 * and `state-duplicate-key.yaml`, a reduction of the real SCRUM-132 defect. The single-token defects
 * are introduced by transforming a scratch copy of the clean fixture instead, so the thing under
 * test is visible in the test rather than buried in a near-identical ninety-line file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const script = join(repoRoot, "scripts", "workflow-state.mjs");
const fixture = (name) => join(repoRoot, "scripts", "__fixtures__", name);

function run(...args) {
  const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", cwd: repoRoot });
  assert.equal(result.error, undefined, `failed to spawn: ${result.error?.message}`);
  return result;
}

const validate = (path, ...flags) => run("validate", path, ...flags);

/** A writable copy of the clean fixture with one defect introduced. */
function scratch(transform = (text) => text, name = "state-clean.yaml") {
  const dir = mkdtempSync(join(tmpdir(), "workflow-state-"));
  const path = join(dir, name);
  writeFileSync(path, transform(readFileSync(fixture(name), "utf8")), "utf8");
  return path;
}

/** The distinct codes one run reported. */
function codes(stdout) {
  return [...new Set([...stdout.matchAll(/\[(WS-[EW]\d+)\]/g)].map((m) => m[1]))].sort();
}

test("every fixture is LF — a CRLF checkout makes these cases pass while testing nothing", () => {
  // Not a check about the scripts. Almost every case here introduces its defect with a `\n`-anchored
  // regex over a scratch copy, so a fixture that arrives with CRLF endings makes the transform match
  // nothing and the case assert against the clean document it meant to break. Six of them did exactly
  // that on a Windows checkout, silently, until the whole class was pinned in `.gitattributes` —
  // which only governs a fresh checkout, so this is the part that fails loudly if one drifts back.
  // Recursive since the spec-lint fixtures arrived: they live in `spec-lint/<tree>/tests/api/…`,
  // shaped like the repository, because the rules they exercise are scoped by path prefix.
  const root = join(repoRoot, "scripts", "__fixtures__");
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory() ? walk(join(dir, entry.name)) : [join(dir, entry.name)],
    );
  const crlf = walk(root)
    .filter((path) => readFileSync(path, "utf8").includes("\r\n"))
    .map((path) => path.slice(root.length + 1));
  assert.deepEqual(crlf, [], "fixtures with CRLF endings — convert them to LF");
});

test("a state file that satisfies the schema is clean, even under --strict", () => {
  const { status, stdout } = validate(fixture("state-clean.yaml"), "--strict");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("a duplicate key fails WS-E01 and names both lines", () => {
  const { status, stdout } = validate(fixture("state-duplicate-key.yaml"));
  assert.equal(status, 1, stdout);
  assert.ok(stdout.includes("[WS-E01]"), stdout);
  assert.match(stdout, /test_design\.last_findings: duplicate key — defined at line 40, again at line 43/);
  // One violation for the key, not one per occurrence.
  assert.equal([...stdout.matchAll(/\[WS-E01\]/g)].length, 1, stdout);
});

test("a long multi-line findings block survives `get` byte for byte", () => {
  const { status, stdout } = run("get", fixture("state-clean.yaml"), "test_design.last_findings");
  assert.equal(status, 0, stdout);
  const source = readFileSync(fixture("state-clean.yaml"), "utf8");
  const expected = source
    .slice(source.indexOf("  last_findings: |-\n") + "  last_findings: |-\n".length)
    .split("\n")
    .slice(0, 5)
    .map((line) => line.slice(4))
    .join("\n");
  assert.equal(stdout.replace(/\r?\n$/, ""), expected);
  // The value carries a `#`, both quote marks, a colon and a leading `-`; none of them is eaten.
  assert.ok(stdout.includes('claims "no merges"'), stdout);
  assert.ok(stdout.includes("'unknown: duplicate-email status code'"), stdout);
  assert.ok(stdout.includes("#2 of a capped loop."), stdout);
  assert.ok(stdout.includes("\n- SCN-004 cites"), stdout);
});

test("an unknown enum value fails WS-E21 and lists the permitted ones", () => {
  const path = scratch((text) => text.replace("phase: test_automation", "phase: shipp"));
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /phase: "shipp" is not a permitted value\. One of: test_design, test_automation, ship, done/);
});

test("not_applicable without a reason fails WS-E30", () => {
  const path = scratch((text) =>
    text.replace(
      '    not_applicable_reason: "no scenario was assigned E2E UI at Checkpoint B"',
      "    not_applicable_reason: null",
    ),
  );
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /automation\.ui: status is not_applicable with no not_applicable_reason/);
});

test("a declined run with an unfilled decline block fails WS-E31, once per missing field", () => {
  const path = scratch((text) => text.replace("status: in_progress", "status: declined"));
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.equal([...stdout.matchAll(/\[WS-E31\]/g)].length, 3, stdout);
  for (const field of ["at_step", "question", "reason"]) {
    assert.ok(stdout.includes(`declined.${field}:`), stdout);
  }
});

test("spending more review rounds than the cap fails WS-E33; reaching it does not", () => {
  // The code streams are capped by `max_review_iterations` (2 in the fixture).
  const atCap = scratch((text) => text.replace("  api: 0", "  api: 2"));
  assert.equal(validate(atCap).status, 0);

  const overCap = scratch((text) => text.replace("  api: 0", "  api: 3"));
  const { status, stdout } = validate(overCap);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /iterations\.api: 3 review rounds spent against a cap of 2/);
});

test("the design counter is capped by max_design_iterations, not by the code streams' cap", () => {
  // Two loops, two caps: a code review's findings are answered by editing the file it names, while
  // a design review's are answered by regenerating a document whose next version invites new
  // findings. The fixture caps design at 1 and the code streams at 2, so a second design round is
  // over its cap while a second API round is not.
  const secondDesignRound = scratch((text) => text.replace("  design: 1", "  design: 2"));
  const { status, stdout } = validate(secondDesignRound);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /iterations\.design: 2 review rounds spent against a cap of 1/);
});

test("a document predating max_design_iterations falls back to the shared cap, not to zero", () => {
  // `Number(null)` is 0. Coercing an absent key would report a cap of zero and fail every document
  // written before this setting existed on its first review round.
  const legacy = scratch((text) => text.replace(/^  max_design_iterations: 1\n/m, ""));
  assert.ok(!readFileSync(legacy, "utf8").includes("max_design_iterations"));
  assert.equal(validate(legacy).status, 0, validate(legacy).stdout);

  const overSharedCap = scratch((text) =>
    text.replace(/^  max_design_iterations: 1\n/m, "").replace("  design: 1", "  design: 3"),
  );
  assert.match(validate(overSharedCap).stdout, /iterations\.design: 3 review rounds spent against a cap of 2/);
});

test("approved_with_open_findings is a design status the schema accepts", () => {
  // Reaching the design cap with Majors still open produces a design that ships and a review that
  // did not converge. A reader who cannot tell it from `approved` cannot tell a design nobody
  // criticised from one whose criticism nobody answered.
  const capped = scratch((text) => text.replace("  status: approved", "  status: approved_with_open_findings"));
  const { status, stdout } = validate(capped, "--strict");
  assert.equal(status, 0, stdout);
});

test("a pull request recorded before the ship phase fails WS-E34", () => {
  const path = scratch((text) =>
    text.replace("pull_request: null", "pull_request: https://github.com/o/r/pull/7"),
  );
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /pull_request: a pull request is recorded while phase is "test_automation"/);
});

test("a finished run with an unresolved hand-back fails WS-E32", () => {
  const path = scratch((text) => text.replace("phase: test_automation", "phase: done"));
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /jira\.handback_status: the run is done but the hand-back never resolved/);
});

test("a missing required key fails WS-E10", () => {
  const path = scratch((text) => text.replace(/^final_decision: pending\n/m, ""));
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /final_decision: required key is missing/);
});

test("an unknown key is a warning, and --strict promotes it", () => {
  const path = scratch((text) =>
    text.replace("  blocked_scenarios: [SCN-007]", "  blocked_scenarios: [SCN-007]\n  scenario_count: 14"),
  );
  const lenient = validate(path);
  assert.equal(lenient.status, 0, lenient.stdout);
  assert.match(lenient.stdout, /test_design\.scenario_count: key is not in the schema/);
  assert.match(lenient.stdout, /test_design\.notes\.scenario_count/);

  assert.equal(validate(path, "--strict").status, 1);
});

test("a key under notes is never unknown — it is the designated home for one", () => {
  const path = scratch((text) =>
    text.replace(
      "  blocked_scenarios: [SCN-007]",
      "  notes:\n    scenario_count: 14\n    e2e_kept: [SCN-001, SCN-002]\n  blocked_scenarios: [SCN-007]",
    ),
  );
  const { status, stdout } = validate(path, "--strict");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("a cost figure with no metrics record behind it warns WS-W20", () => {
  const path = scratch((text) =>
    text.replace(
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      note: "4 FR, 1 AC" }',
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      tokens: 48706, duration_s: 104.9, note: "4 FR, 1 AC" }',
    ),
  );
  const { status, stdout } = validate(path);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /qa-requirements-collector: history entry carries a cost figure/);
});

test("a cost figure naming the metrics row it came from does not warn", () => {
  const path = scratch((text) =>
    text.replace(
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      note: "4 FR, 1 AC" }',
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      tokens: 48706, duration_s: 104.9, metrics_seq: 1, note: "4 FR, 1 AC" }',
    ),
  );
  const metrics = join(dirname(path), "measured.jsonl");
  writeFileSync(
    metrics,
    `${JSON.stringify({ seq: 1, agent: "qa-requirements-collector", billed: { total: 48706 } })}\n`,
    "utf8",
  );
  const { status, stdout } = validate(path, "--metrics", metrics);
  assert.equal(status, 0, stdout);
  assert.ok(!stdout.includes("WS-W20"), stdout);
});

test("a metrics_seq pointing at another agent's row, or at no row, warns WS-W20", () => {
  const path = scratch((text) =>
    text.replace(
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      note: "4 FR, 1 AC" }',
      '  - { step: "1.1", agent: qa-requirements-collector, result: OK, at: 2026-08-09,\n      duration_s: 104.9, metrics_seq: 2, note: "4 FR, 1 AC" }',
    ),
  );
  const metrics = join(dirname(path), "measured.jsonl");
  // Row 2 belongs to a different agent: the per-agent-count check would have accepted this, because
  // the collector had "a row". Provenance is a pointer, not a tally.
  writeFileSync(
    metrics,
    `${JSON.stringify({ seq: 1, agent: "qa-requirements-collector" })}\n${JSON.stringify({ seq: 2, agent: "qa-scenario-generator" })}\n`,
    "utf8",
  );
  const wrongAgent = validate(path, "--metrics", metrics);
  assert.match(wrongAgent.stdout, /metrics_seq 2, but row 2 is a qa-scenario-generator run/);

  writeFileSync(metrics, `${JSON.stringify({ seq: 1, agent: "qa-requirements-collector" })}\n`, "utf8");
  const noRow = validate(path, "--metrics", metrics);
  assert.match(noRow.stdout, /metrics_seq 2, and the metrics log has no row 2/);
});

test("a real state file from an earlier run reports drift as warnings, never a crash", () => {
  const { status, stdout } = validate(fixture("state-legacy-115.yaml"));
  assert.equal(status, 0, stdout);
  assert.deepEqual(
    codes(stdout).filter((c) => c.startsWith("WS-E")),
    [],
  );
  // Folded `>-` prose is read, not refused — the escalation reason is a real value in that file.
  assert.match(stdout, /test_design\.escalation_reason: key is not in the schema/);
});

test("--json carries the violations and names the keys worth promoting", () => {
  const { status, stdout } = validate(fixture("state-duplicate-key.yaml"), "--json");
  assert.equal(status, 1, stdout);
  const report = JSON.parse(stdout);
  assert.equal(report.errors, 1);
  assert.equal(report.violations[0].code, "WS-E01");
  assert.equal(report.violations[0].subject, "test_design.last_findings");
  assert.ok(Array.isArray(report.promote_candidates));
});

test("a construct the parser will not guess at exits 3 rather than reporting a wrong answer", () => {
  const path = scratch((text) => text.replace("current_step: \"2.1a\"", "current_step: &anchor\n\t- tabbed"));
  const { status, stderr } = validate(path);
  assert.equal(status, 3, stderr);
  assert.match(stderr, /WS-E90/);
});

test("a missing state file exits 3", () => {
  const { status, stderr } = validate(join(tmpdir(), "no-such-state-file.yaml"));
  assert.equal(status, 3, stderr);
  assert.match(stderr, /no state file at/);
});

test("print-schema is the schema, in both renderings", () => {
  const markdown = run("print-schema");
  assert.equal(markdown.status, 0, markdown.stderr);
  assert.match(markdown.stdout, /^\| `test_design\.last_findings` \| scalar \| — \|/m);
  assert.match(markdown.stdout, /`automation\.api\.status` \| enum\(pending \| not_applicable/);

  const json = run("print-schema", "--json");
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.ok(rows.some((r) => r.path === "iterations.design" && r.required));
});

test("an unknown command is a usage error", () => {
  const { status, stderr } = run("rewrite", "SCRUM-900");
  assert.equal(status, 2, stderr);
  assert.match(stderr, /usage:/);
});

// ---------------------------------------------------------------------------------------------
// The write path.
//
// `validate` stops a bad file surviving to the next delegation; these commands stop one being
// written. Every case below is about that difference: what reaches disk, what deliberately does
// not, and what a second identical command does.
// ---------------------------------------------------------------------------------------------

/** An empty scratch directory, and the path a state file would take inside it. */
function scratchDir(name = "SCRUM-900.yaml") {
  return join(mkdtempSync(join(tmpdir(), "workflow-state-")), name);
}

test("init writes a document that validates under --strict; a second init changes nothing", () => {
  const path = scratchDir();
  const first = run("init", path);
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^created /);
  assert.equal(validate(path, "--strict").status, 0);

  const before = statSync(path);
  const second = run("init", path);
  assert.equal(second.status, 0, second.stderr);
  // `EXISTS` on purpose — the vocabulary the orchestrator already normalizes as `already_done`.
  assert.match(second.stdout, /^EXISTS /);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
  assert.equal(readFileSync(path, "utf8"), readFileSync(path, "utf8"));
});

test("init --set applies overrides, and the ticket id follows the file name", () => {
  const path = scratchDir("SCRUM-901.yaml");
  const { status, stderr } = run("init", path, "--set", "mode=auto", "--set", "configuration.max_review_iterations=3");
  assert.equal(status, 0, stderr);
  assert.equal(run("get", path, "mode").stdout.trim(), "auto");
  assert.equal(run("get", path, "configuration.max_review_iterations").stdout.trim(), "3");
  assert.equal(run("get", path, "ticket_id").stdout.trim(), "SCRUM-901");
});

test("a set that writes what is already there prints unchanged and leaves mtime alone", () => {
  // Not `phase=ship`: WS-E35 makes that a value with a precondition — the fixture's API stream is
  // still `implemented`, so the write would be refused, and this case is about idempotency.
  const path = scratch();
  const first = run("set", path, "status=paused", "current_step=3");
  assert.equal(first.status, 0, first.stderr);
  assert.match(first.stdout, /^set /);

  const before = statSync(path);
  const second = run("set", path, "status=paused", "current_step=3");
  assert.equal(second.status, 0, second.stderr);
  assert.match(second.stdout, /^unchanged /);
  assert.equal(statSync(path).mtimeMs, before.mtimeMs);
});

test("a set leaves every field it did not name byte-identical", () => {
  const path = scratch();
  const before = readFileSync(path, "utf8");
  assert.equal(run("set", path, "current_step=2.2a").status, 0);
  const after = readFileSync(path, "utf8");
  const diff = before.split("\n").filter((line, i) => line !== after.split("\n")[i]);
  assert.deepEqual(diff, ['current_step: "2.1a"']);
});

test("a set whose result would not validate is refused before it reaches disk", () => {
  const path = scratch();
  const before = readFileSync(path, "utf8");
  const { status, stderr } = run("set", path, "phase=shipp");
  assert.equal(status, 1, stderr);
  assert.match(stderr, /\[WS-E21\]/);
  assert.match(stderr, /refusing to write/);
  assert.equal(readFileSync(path, "utf8"), before);

  // --force is the escape hatch for a genuinely intermediate state, and it says so by being asked for.
  assert.equal(run("set", path, "phase=shipp", "--force").status, 0);
  assert.equal(validate(path).status, 1);
});

test("a set outside the schema is refused, and the refusal names notes as the home", () => {
  const path = scratch();
  const { status, stderr } = run("set", path, "test_design.scenario_count=14");
  assert.equal(status, 2, stderr);
  assert.match(stderr, /test_design\.notes\.scenario_count/);

  assert.equal(run("set", path, "test_design.scenario_count=14", "--allow-unknown").status, 0);
  assert.equal(run("set", path, "test_design.notes.scenario_count=14").status, 0);
});

test("set-block round-trips a 2,000-character value byte for byte", () => {
  const path = scratch();
  const blockFile = join(dirname(path), "findings.txt");
  let body =
    'Iteration 1 verdict: Needs Revision. Resolved 4 of 6.\n' +
    'Outstanding: [DESIGN-M2] the decision table claims "no merges".\n' +
    "- SCN-004 cites DT-01/R3 while asserting nothing; count it traced-only.\n" +
    "- SCN-007's Expected: still reads 'unknown: duplicate-email status code'.\n" +
    "Routed: generator gets M2. #2 of a capped loop.\n";
  while (body.length < 2000) body += "padding: with # a hash, \"double\" and 'single' quotes - and a dash\n";
  writeFileSync(blockFile, body, "utf8");

  const written = run("set-block", path, "automation.api.last_findings", "--from-file", blockFile);
  assert.equal(written.status, 0, written.stderr);

  const read = run("get", path, "automation.api.last_findings");
  assert.equal(read.status, 0, read.stderr);
  // One trailing newline is the file's, not the value's; everything else survives.
  assert.equal(read.stdout.replace(/\r\n/g, "\n").replace(/\n$/, ""), body.replace(/\n$/, ""));
  assert.match(readFileSync(path, "utf8"), /last_findings: \|-/);
  assert.equal(validate(path, "--strict").status, 0);
});

test("append adds one entry; --dedupe suppresses a row identical to the last one", () => {
  const path = scratch();
  const entry = JSON.stringify({ step: "1.1", agent: "qa-requirements-collector", result: "OK" });
  assert.match(run("append", path, "history", "--json", entry).stdout, /^append /);
  assert.match(run("append", path, "history", "--json", entry, "--dedupe").stdout, /^unchanged /);
  assert.match(run("append", path, "history", "--json", entry).stdout, /^append /);

  const text = readFileSync(path, "utf8");
  // JSON carries types, so the string "1.1" is written quoted rather than as the float 1.1.
  const written = /\{ step: "1\.1", agent: qa-requirements-collector, result: OK \}/g;
  assert.equal([...text.matchAll(written)].length, 2, text);
});

test("append materialises an empty sequence, and refuses a path that is not one", () => {
  const path = scratch();
  const entry = JSON.stringify({ step: "2.1b", agent: "aqa-ui-test-creator", at: "2026-08-09T09:12:04Z" });
  assert.equal(run("append", path, "in_flight", "--json", entry).status, 0);
  assert.match(readFileSync(path, "utf8"), /^in_flight:\n {2}- \{ step: 2\.1b, agent: aqa-ui-test-creator/m);

  const { status, stderr } = run("append", path, "phase", "--json", entry);
  assert.equal(status, 2, stderr);
  assert.match(stderr, /append only writes to a sequence/);
});

test("a parallel pair goes in as two entries in one write", () => {
  const path = scratch();
  const { status, stderr } = run(
    "append",
    path,
    "in_flight",
    "--json",
    JSON.stringify({ step: "2.1a", agent: "aqa-api-test-creator" }),
    "--json",
    JSON.stringify({ step: "2.1b", agent: "aqa-ui-test-creator" }),
  );
  assert.equal(status, 0, stderr);
  const text = readFileSync(path, "utf8");
  assert.match(text, /^in_flight:\n {2}- \{ step: 2\.1a[^\n]*\n {2}- \{ step: 2\.1b/m, text);
});

test("clear-in-flight removes the entry it names and nothing else", () => {
  const path = scratch();
  for (const [step, agent] of [
    ["2.1a", "aqa-api-test-creator"],
    ["2.1b", "aqa-ui-test-creator"],
  ]) {
    assert.equal(run("append", path, "in_flight", "--json", JSON.stringify({ step, agent })).status, 0);
  }
  assert.match(run("clear-in-flight", path, "--agent", "aqa-api-test-creator").stdout, /^clear-in-flight /);
  const text = readFileSync(path, "utf8");
  assert.ok(!text.includes("aqa-api-test-creator"), text);
  assert.ok(text.includes("aqa-ui-test-creator"), text);

  // Clearing an entry that is already gone is a no-op, not an error — a resume runs this blind.
  assert.match(run("clear-in-flight", path, "--agent", "aqa-api-test-creator").stdout, /^unchanged /);
  assert.match(run("clear-in-flight", path, "--step", "2.1b").stdout, /^clear-in-flight /);
  assert.match(readFileSync(path, "utf8"), /^in_flight: \[\]$/m);

  // It never empties the list wholesale; that would be an interrupted delegation losing its witness.
  const { status, stderr } = run("clear-in-flight", path);
  assert.equal(status, 2, stderr);
  assert.match(stderr, /--agent <name> or --step <id>/);
});

test("normalize is a no-op on a document already in canonical form, and idempotent otherwise", () => {
  const clean = scratch();
  assert.match(run("normalize", clean).stdout, /^unchanged /);

  // The legacy file uses folded scalars and a wrapped flow entry: the first pass rewrites, the
  // second must not. Anything else means the emitter and the parser disagree about the same bytes.
  // `/m`: the legacy document also predates five configuration keys, so the receipt reports those
  // back-fills above the line that says what the command did.
  const legacy = scratch((text) => text, "state-legacy-115.yaml");
  assert.match(run("normalize", legacy).stdout, /^normalized /m);
  const once = readFileSync(legacy, "utf8");
  assert.match(run("normalize", legacy).stdout, /^unchanged /);
  assert.equal(readFileSync(legacy, "utf8"), once);
});

// ---------------------------------------------------------------------------------------------
// normalize — writing in the settings a document predates
//
// A configuration key the schema defines and a file lacks is not a neutral absence. The banner
// resolves it as `default` and prints it as a value nobody chose, so a resumed run reports the
// template's answer instead of the one somebody typed. `init` writes every key for that reason;
// this is the same rule applied to the documents written before the key existed.
// ---------------------------------------------------------------------------------------------

test("normalize back-fills a configuration key the document predates, at the init default", () => {
  const path = scratch((text) =>
    text
      .replace(/^  on_blocked_alternative_flow: escalate\n/m, "")
      .replace(/^  on_missing_api_surface: escalate\n/m, ""),
  );
  const before = readFileSync(path, "utf8");
  assert.ok(!before.includes("on_missing_api_surface"), "the fixture transform did not drop the keys");

  const { status, stdout } = run("normalize", path);
  assert.equal(status, 0, stdout);
  // One line per key, naming the value and where it came from.
  assert.match(stdout, /^added +configuration\.on_blocked_alternative_flow: escalate {2}\(the value init would have written\)$/m);
  assert.match(stdout, /^added +configuration\.on_missing_api_surface: escalate {2}\(the value init would have written\)$/m);

  // Nothing else moved: the two lines are the whole diff, and the document still validates.
  const after = readFileSync(path, "utf8");
  const addedLines = after.split("\n").filter((line) => !before.split("\n").includes(line));
  assert.deepEqual(addedLines, [
    "  on_blocked_alternative_flow: escalate",
    "  on_missing_api_surface: escalate",
  ]);
  assert.equal(validate(path, "--strict").status, 0);

  assert.match(run("normalize", path).stdout, /^unchanged /);
});

test("normalize never overwrites a setting somebody chose", () => {
  // The whole point is a value nobody chose being reported as a decision. Replacing one that was
  // chosen would be the same defect with the sign flipped.
  const path = scratch((text) => text.replace(/^  max_review_iterations: 2$/m, "  max_review_iterations: 1"));
  assert.equal(run("normalize", path).status, 0);
  assert.equal(run("get", path, "configuration.max_review_iterations").stdout.trim(), "1");
});

test("normalize never back-fills the design cap — a tighter cap would invalidate a run in flight", () => {
  // `state-legacy-115.yaml` predates the key and has already spent 2 design rounds. Writing the
  // template's `1` into it would make it fail WS-E33, normalize would then refuse to write it, and
  // a command that promises to change nothing about the run would have bricked one. The validator's
  // fallback to `max_review_iterations` is the defined answer instead.
  const legacy = scratch((text) => text, "state-legacy-115.yaml");
  const { status, stdout } = run("normalize", legacy);
  assert.equal(status, 0, stdout);
  assert.doesNotMatch(stdout, /max_design_iterations/);
  assert.ok(!readFileSync(legacy, "utf8").includes("max_design_iterations"));
  assert.equal(validate(legacy).status, 0);
});

test("normalize back-fills configuration and nothing else — it is not a migration of the run", () => {
  // A back-fill that also moved a phase, a counter or a history entry would be a command nobody
  // could safely run on a live document.
  const path = scratch((text) => text.replace(/^  batch_size: 10\n/m, ""));
  const before = readFileSync(path, "utf8");
  assert.equal(run("normalize", path).status, 0);
  const after = readFileSync(path, "utf8");

  for (const dotted of ["phase", "status", "current_step", "iterations.design", "final_decision"]) {
    assert.equal(
      run("get", path, dotted).stdout,
      run("get", fixture("state-clean.yaml"), dotted).stdout,
      `${dotted} changed`,
    );
  }
  assert.equal(after.replace("  batch_size: 10\n", ""), before);
});

test("a write over a duplicated document is refused; normalize is what resolves it", () => {
  const path = scratch((text) => text, "state-duplicate-key.yaml");
  const refused = run("set", path, "current_step=1.5");
  assert.equal(refused.status, 1, refused.stderr);
  assert.match(refused.stderr, /\[WS-E01\] test_design\.last_findings/);
  assert.match(refused.stderr, /run `normalize`/);

  const fixed = run("normalize", path);
  assert.equal(fixed.status, 0, fixed.stderr);
  assert.match(fixed.stdout, /collapsed 1 duplicate key, keeping the last value/);
  assert.equal(validate(path).status, 0);
  assert.equal(run("set", path, "current_step=1.5").status, 0);
});

test("the generated reference is the schema — the table has not drifted from print-schema", () => {
  // F5: the field table in the reference is generated, but the file wraps it in hand-written prose,
  // so byte-equality of the whole file cannot be the check. The `## Fields` section is.
  const reference = readFileSync(
    join(repoRoot, ".claude", "skills", "qa-workflow", "references", "state-schema.md"),
    "utf8",
  );
  const section = reference.split(/^## Fields$/m)[1]?.split(/^## /m)[0];
  assert.ok(section, "references/state-schema.md has no ## Fields section");
  const generated = run("print-schema");
  assert.equal(generated.status, 0, generated.stderr);
  assert.equal(
    section.replace(/\r\n/g, "\n").trim(),
    generated.stdout.replace(/\r\n/g, "\n").trim(),
    "regenerate with: node scripts/workflow-state.mjs print-schema",
  );
});

// ---------------------------------------------------------------------------------------------
// check-artifacts — F8. The state file is a record of what happened, not of what still exists.
// ---------------------------------------------------------------------------------------------

/** A scratch repository root holding the files a state document names, minus the ones dropped. */
function fakeRoot(paths, dropped = []) {
  const root = mkdtempSync(join(tmpdir(), "workflow-artifacts-"));
  for (const rel of paths) {
    if (dropped.includes(rel)) continue;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, "x", "utf8");
  }
  return root;
}

/** Every path `state-clean.yaml` names, in the order check-artifacts reports them. */
const CLEAN_ARTIFACTS = [
  "requirements/SCRUM-900-requirements.md",
  "test-design/SCRUM-900-test-design.md",
  ".workflow/reports/SCRUM-900-api-implementation.md",
  "tests/api/admin-users.spec.ts",
  ".workflow/reports/SCRUM-900-ui-implementation.md",
];

test("check-artifacts is clean when every recorded path is on disk", () => {
  const root = fakeRoot(CLEAN_ARTIFACTS);
  const { status, stdout } = run("check-artifacts", fixture("state-clean.yaml"), "--root", root);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /SCRUM-900: 5 recorded artifact\(s\), all present/);
  assert.ok(!stdout.includes("MISSING"), stdout);
});

test("a deleted artifact exits 4 — the F8 defect, on a document that validates clean", () => {
  // The 2026-08-17 resume: the file was internally consistent and `validate` said so, while the
  // spec carrying every implemented scenario was gone. Validation cannot see this; stat can.
  const root = fakeRoot(CLEAN_ARTIFACTS, ["tests/api/admin-users.spec.ts"]);
  const { status, stdout } = run("check-artifacts", fixture("state-clean.yaml"), "--root", root);
  assert.equal(status, 4, stdout);
  assert.match(stdout, /MISSING {2}automation\.api\.created_tests\[0\] +tests\/api\/admin-users\.spec\.ts/);
  assert.match(stdout, /1 of 5 recorded artifact\(s\) missing from disk/);
  // Exit 4 and not 1: the document is fine, so this is not a file to repair before the next command.
  assert.equal(validate(fixture("state-clean.yaml"), "--strict").status, 0);
});

test("check-artifacts rules on nothing — a not_applicable stream's absence is reported, with its status", () => {
  const root = fakeRoot(CLEAN_ARTIFACTS, [".workflow/reports/SCRUM-900-ui-implementation.md"]);
  const { status, stdout } = run("check-artifacts", fixture("state-clean.yaml"), "--root", root);
  assert.equal(status, 4, stdout);
  // The row carries the fact and the context the orchestrator routes on. It does not decide that a
  // not_applicable stream is allowed to be missing — that judgement is not the script's to make.
  assert.match(stdout, /MISSING {2}automation\.ui\.report .*\(ui stream: not_applicable\)/);
});

test("both sequence forms are read — a flow list and a block list", () => {
  const block = scratch((text) =>
    text.replace(
      "    created_tests: [tests/api/admin-users.spec.ts]",
      "    created_tests:\n      - tests/api/admin-users.spec.ts\n      - pages/admin-page.ts",
    ),
  );
  const root = fakeRoot([...CLEAN_ARTIFACTS, "pages/admin-page.ts"]);
  const { status, stdout } = run("check-artifacts", block, "--root", root);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /automation\.api\.created_tests\[1\] +pages\/admin-page\.ts/);
});

test("artifacts.metrics is not checked — the hook owns it, and its absence is not drift", () => {
  const root = fakeRoot(CLEAN_ARTIFACTS);
  const { status, stdout } = run("check-artifacts", fixture("state-clean.yaml"), "--root", root);
  assert.equal(status, 0, stdout);
  assert.ok(!stdout.includes("artifacts.metrics"), stdout);
  assert.ok(!stdout.includes("SCRUM-900.jsonl"), stdout);
});

test("a document naming no artifact yet is not drift", () => {
  const dir = mkdtempSync(join(tmpdir(), "workflow-state-"));
  const path = join(dir, "SCRUM-901.yaml");
  assert.equal(run("init", path).status, 0);
  const { status, stdout } = run("check-artifacts", path, "--root", dir);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /no artifact paths recorded yet/);
});

test("check-artifacts --json carries every row and the scope it rules on", () => {
  const root = fakeRoot(CLEAN_ARTIFACTS, ["test-design/SCRUM-900-test-design.md"]);
  const { status, stdout } = run("check-artifacts", fixture("state-clean.yaml"), "--root", root, "--json");
  assert.equal(status, 4, stdout);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ticket, "SCRUM-900");
  assert.equal(payload.recorded, 5);
  assert.equal(payload.missing, 1);
  assert.equal(payload.scope, "existence_only");
  assert.deepEqual(
    payload.artifacts.filter((a) => !a.exists).map((a) => a.field),
    ["artifacts.test_design"],
  );
});

test("check-artifacts on a missing state file exits 3, not 4", () => {
  // The two are different facts: no file at all is not a file whose artifacts drifted.
  const { status } = run("check-artifacts", join(tmpdir(), "no-such-state-file.yaml"));
  assert.equal(status, 3);
});

// ---------------------------------------------------------------------------------------------
// on_blocked_alternative_flow — the auto-mode gate that is a setting rather than a rule
//
// It only ever decides whether the run stops, so the failure it must not have is a value that
// parses. `escalate` and `continue` are opposite behaviours at the design gate, and anything else
// resolving to "not escalate" would widen a gate nobody chose to widen.
// ---------------------------------------------------------------------------------------------

test("on_blocked_alternative_flow accepts both permitted values", () => {
  for (const value of ["escalate", "continue"]) {
    const path = scratch((text) =>
      text.replace("on_blocked_alternative_flow: escalate", `on_blocked_alternative_flow: ${value}`),
    );
    const { status, stdout } = validate(path, "--strict");
    assert.equal(status, 0, stdout);
    assert.deepEqual(codes(stdout), []);
  }
});

test("a misspelled on_blocked_alternative_flow fails WS-E21 rather than reading as continue", () => {
  const path = scratch((text) =>
    text.replace("on_blocked_alternative_flow: escalate", "on_blocked_alternative_flow: proceed"),
  );
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.ok(stdout.includes("[WS-E21]"), stdout);
  assert.match(stdout, /on_blocked_alternative_flow: "proceed" is not a permitted value\. One of: escalate, continue/);
});

test("on_blocked_alternative_flow is optional — an older state file is not in violation", () => {
  // It was added after the first state files were written, and a resume must not fail on one that
  // predates it. Absent means the default applies, which is the stopping behaviour.
  const path = scratch((text) => text.replace(/^  on_blocked_alternative_flow: escalate\n/m, ""));
  const { status, stdout } = validate(path, "--strict");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("set writes on_blocked_alternative_flow and refuses a value outside the enum", () => {
  const path = scratch();
  const ok = run("set", path, "configuration.on_blocked_alternative_flow=continue");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readFileSync(path, "utf8"), /^  on_blocked_alternative_flow: continue$/m);

  const bad = run("set", path, "configuration.on_blocked_alternative_flow=maybe");
  assert.notEqual(bad.status, 0, "a write whose result would not validate must be refused");
  // Refused means refused: the previous value is still on disk.
  assert.match(readFileSync(path, "utf8"), /^  on_blocked_alternative_flow: continue$/m);
});

test("init writes the setting at its default, so a resume inherits it", () => {
  // A gate-relaxing setting that exists in the first session and not in the file is one the resume
  // silently loses — and the banner would go on reporting it as `state` on the strength of nothing.
  const path = scratchDir();
  const created = run("init", path);
  assert.equal(created.status, 0, created.stderr);
  assert.match(readFileSync(path, "utf8"), /^  on_blocked_alternative_flow: escalate$/m);
  assert.equal(validate(path, "--strict").status, 0);
});

// ---------------------------------------------------------------------------------------------
// on_missing_api_surface — the other auto-mode gate, and the one the schema was missing
//
// It has been a documented run parameter, printed in the banner and routed on at the automation
// gate, while `configuration.children` had no such key — so the only ways to record it were
// `--allow-unknown` or a `notes.` field the banner does not read, and a resume reported the
// default for a run somebody had set to `ignore`. The cases below are the same four the setting
// beside it carries, because the failure mode is identical: a value that parses and widens a gate
// nobody chose to widen.
// ---------------------------------------------------------------------------------------------

test("on_missing_api_surface accepts both permitted values", () => {
  for (const value of ["escalate", "ignore"]) {
    const path = scratch((text) =>
      text.replace("on_missing_api_surface: escalate", `on_missing_api_surface: ${value}`),
    );
    const { status, stdout } = validate(path, "--strict");
    assert.equal(status, 0, stdout);
    assert.deepEqual(codes(stdout), []);
  }
});

test("a misspelled on_missing_api_surface fails WS-E21 rather than reading as ignore", () => {
  const path = scratch((text) =>
    text.replace("on_missing_api_surface: escalate", "on_missing_api_surface: skip"),
  );
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.ok(stdout.includes("[WS-E21]"), stdout);
  assert.match(stdout, /on_missing_api_surface: "skip" is not a permitted value\. One of: escalate, ignore/);
});

test("on_missing_api_surface is optional — an older state file is not in violation", () => {
  const path = scratch((text) => text.replace(/^  on_missing_api_surface: escalate\n/m, ""));
  assert.ok(!readFileSync(path, "utf8").includes("on_missing_api_surface"), "the key was not dropped");
  const { status, stdout } = validate(path, "--strict");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("set writes on_missing_api_surface and refuses a value outside the enum", () => {
  const path = scratch();
  const ok = run("set", path, "configuration.on_missing_api_surface=ignore");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readFileSync(path, "utf8"), /^  on_missing_api_surface: ignore$/m);

  const bad = run("set", path, "configuration.on_missing_api_surface=maybe");
  assert.notEqual(bad.status, 0, "a write whose result would not validate must be refused");
  assert.match(readFileSync(path, "utf8"), /^  on_missing_api_surface: ignore$/m);
});

test("init writes on_missing_api_surface at its default, so a resume inherits it", () => {
  const path = scratchDir();
  const created = run("init", path);
  assert.equal(created.status, 0, created.stderr);
  assert.match(readFileSync(path, "utf8"), /^  on_missing_api_surface: escalate$/m);
  assert.equal(validate(path, "--strict").status, 0);
});

// ---------------------------------------------------------------------------------------------
// WS-E35 — a stream that never settled, in a document that says the run reached the ship phase
//
// The ship step reads an unknown stream verdict as "not passed" and stops, so this is the early
// half of a check that already exists, not the only one. The value is where it fires: on the
// document, before the ship delegation is made, rather than nine delegations into a run that was
// routed on a false premise.
//
// `passed` and `not_applicable` are the two shippable statuses. The cases below cover both sides of
// the message — a stream still in flight, and one whose review asked for changes nobody made — and
// the phases where the rule must stay silent, since a stream is `pending` for most of a normal run.
// ---------------------------------------------------------------------------------------------

/** The clean fixture moved to a phase, with one stream's status replaced. */
function atPhase(phase, streamStatus, stream = "api") {
  // The `assert.match` is not decoration: a transform that matches nothing leaves the case
  // asserting against the fixture's own values instead of the ones it names, and passes.
  return scratch((text) => {
    let out = text.replace(/^phase: test_automation$/m, `phase: ${phase}`);
    if (phase === "done") out = out.replace(/^  handback_status: pending$/m, "  handback_status: done");
    const block = new RegExp(`^  ${stream}:\\n    status: [a-z_]+$`, "m");
    assert.match(out, block, `the ${stream} stream block was not found in the fixture`);
    return out.replace(block, `  ${stream}:\n    status: ${streamStatus}`);
  });
}

test("a stream still in flight at the ship phase fails WS-E35", () => {
  for (const streamStatus of ["pending", "implemented", "review_in_progress"]) {
    const path = atPhase("ship", streamStatus);
    const { status, stdout } = validate(path);
    assert.equal(status, 1, stdout);
    assert.ok(stdout.includes("[WS-E35]"), stdout);
    assert.match(stdout, /the API stream at "(pending|implemented|review_in_progress)"/);
    assert.match(stdout, /never finished its review/);
  }
});

test("a stream whose review did not pass fails WS-E35 with the other reason", () => {
  for (const streamStatus of ["needs_revision", "blocked"]) {
    const path = atPhase("ship", streamStatus);
    const { status, stdout } = validate(path);
    assert.equal(status, 1, stdout);
    assert.ok(stdout.includes("[WS-E35]"), stdout);
    assert.match(stdout, /did not pass, so it is not shippable/);
  }
});

test("passed and not_applicable are the two statuses that ship", () => {
  // The clean fixture already carries `ui: not_applicable` with its reason, so moving the API
  // stream to passed makes the whole document shippable — which is the state this rule permits.
  const path = atPhase("ship", "passed");
  const { status, stdout } = validate(path, "--strict");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("WS-E35 fires at the done phase too — a finished run cannot hold an unsettled stream", () => {
  const path = atPhase("done", "pending");
  const { status, stdout } = validate(path);
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["WS-E35"]);
});

test("the rule is containment, not a report — set refuses to move the phase to ship", () => {
  // Validation runs on the emitted document before it reaches disk, so an orchestrator that moves
  // the phase ahead of a stream's verdict is stopped at the write rather than at the ship gate.
  const path = scratch();
  const refused = run("set", path, "phase=ship");
  assert.notEqual(refused.status, 0, "a write whose result would not validate must be refused");
  assert.match(refused.stderr + refused.stdout, /\[WS-E35\]/);
  assert.match(readFileSync(path, "utf8"), /^phase: test_automation$/m);

  // Settled first, in one command or two, and the same write goes through.
  const ok = run("set", path, "automation.api.status=passed", "phase=ship");
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(readFileSync(path, "utf8"), /^phase: ship$/m);
});

test("WS-E35 says nothing before the ship phase — a stream is pending for most of a run", () => {
  for (const phase of ["test_design", "test_automation"]) {
    const path = atPhase(phase, "pending");
    const { status, stdout } = validate(path, "--strict");
    assert.equal(status, 0, stdout);
    assert.deepEqual(codes(stdout), []);
  }
});

// ---------------------------------------------------------------------------------------------
// reset — the drop to the first stage
//
// The one command that moves a run backwards, and the only one that renames a file other than the
// state file. It exists because it was already happening at a shell prompt: `.workflow/
// SCRUM-132.yaml` carries a step-0 note describing exactly these three renames, done by hand, and
// calling itself the third occurrence.
//
// The cases below are about the two properties the command rests on. ARCHIVE, NEVER DELETE — every
// displaced file is under a name nothing else uses, which is what makes the absence of a rollback
// safe. THE STATE FILE MOVES SECOND TO LAST — so a failure part-way leaves an index that still
// describes the world, and re-running completes the job instead of compounding it.
// ---------------------------------------------------------------------------------------------

/** Every path `state-clean.yaml` names, minus the ones dropped, plus its state file. */
function resetRoot(transform = (text) => text, dropped = []) {
  const root = mkdtempSync(join(tmpdir(), "workflow-reset-"));
  const statePath = join(root, ".workflow", "SCRUM-900.yaml");
  mkdirSync(join(root, ".workflow"), { recursive: true });
  writeFileSync(statePath, transform(readFileSync(fixture("state-clean.yaml"), "utf8")), "utf8");
  for (const rel of CLEAN_ARTIFACTS) {
    if (dropped.includes(rel)) continue;
    const full = join(root, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `contents of ${rel}`, "utf8");
  }
  return { root, statePath };
}

const RESET_ARGS = ["--at", "2026-08-20", "--reason", "the design was written against the wrong ticket"];

/** Every file under `dir`, repo-relative and forward-slashed, sorted. */
function treeOf(dir, prefix = "") {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...treeOf(join(dir, entry.name), rel));
    else out.push(rel);
  }
  return out.sort();
}

test("reset archives the state file and every document a fresh run would refuse to rewrite", () => {
  const { root, statePath } = resetRoot();
  const before = readFileSync(statePath, "utf8");
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);

  // Archived, not deleted — and byte-identical, because a rename is all that happened.
  const archived = `${statePath}.bak-2026-08-20-reset`;
  assert.equal(readFileSync(archived, "utf8"), before);
  assert.deepEqual(treeOf(root), [
    ".workflow/SCRUM-900.yaml",
    ".workflow/SCRUM-900.yaml.bak-2026-08-20-reset",
    ".workflow/reports/old_do_not_use_SCRUM-900-api-implementation.md",
    ".workflow/reports/old_do_not_use_SCRUM-900-ui-implementation.md",
    "requirements/old_do_not_use_SCRUM-900-requirements.md",
    "test-design/old_do_not_use_SCRUM-900-test-design.md",
    "tests/api/admin-users.spec.ts",
  ]);
  assert.equal(validate(statePath, "--strict").status, 0);
});

test("both implementation reports are archived — a report on disk makes its creator return EXISTS", () => {
  // This is the criterion for the whole rename list, and the one that is easy to get wrong: a
  // report is not merely a record. The implementing step resolves its mode by globbing that exact
  // path, so leaving it in place produces a fresh run that already_dones its way straight back to
  // the phase it was reset out of.
  const { root, statePath } = resetRoot();
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  for (const stream of ["api", "ui"]) {
    assert.match(stdout, new RegExp(`archive.*SCRUM-900-${stream}-implementation\\.md`));
  }
});

test("created_tests are never renamed — a renamed spec still runs and still typechecks", () => {
  const { root, statePath } = resetRoot();
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.equal(
    readFileSync(join(root, "tests/api/admin-users.spec.ts"), "utf8"),
    "contents of tests/api/admin-users.spec.ts",
  );
  // Reported rather than moved: "nothing owns this file now" is the fact the rename reached for.
  assert.match(stdout, /kept .*tests\/api\/admin-users\.spec\.ts.*automation\.api\.created_tests\[0\]/);
  assert.match(stdout, /1 test file\(s\) were created by the archived run and are NOT renamed/);
});

test("the metrics log is named as kept and never touched — the hooks own it", () => {
  const { root, statePath } = resetRoot();
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /kept .*\.workflow\/metrics\/SCRUM-900\.jsonl.*the hooks own it/);
  // The fresh document still points at the same file, so the ticket's cost history is continuous.
  assert.match(readFileSync(statePath, "utf8"), /^ {2}metrics: \.workflow\/metrics\/SCRUM-900\.jsonl$/m);
});

test("reset carries mode and configuration forward, and resets everything else", () => {
  // `request > state > default` is the banner's precedence rule. A reset destroys the `state` tier,
  // so taking template defaults would have the banner report `max_review_iterations 2 default` for
  // a run somebody had deliberately capped at 1 — a value nobody chose, certified as a decision.
  const { root, statePath } = resetRoot((text) =>
    text
      .replace("max_review_iterations: 2", "max_review_iterations: 1")
      .replace("on_blocked_alternative_flow: escalate", "on_blocked_alternative_flow: continue"),
  );
  assert.equal(run("reset", statePath, "--root", root, ...RESET_ARGS).status, 0);
  const after = readFileSync(statePath, "utf8");

  assert.match(after, /^mode: auto$/m);
  assert.match(after, /^ {2}max_review_iterations: 1$/m);
  assert.match(after, /^ {2}on_blocked_alternative_flow: continue$/m);
  // Everything that is a claim about the ticket rather than about how the workflow is run.
  assert.match(after, /^phase: test_design$/m);
  assert.match(after, /^current_step: "0"$/m);
  assert.match(after, /^status: in_progress$/m);
  assert.match(after, /^final_decision: pending$/m);
  assert.match(after, /^ {2}requirements: null$/m);
  assert.match(after, /^ {2}test_design: null$/m);
  assert.match(after, /^ {2}design: 0$/m);
  assert.ok(!after.includes("SCN-007"), "no finding, unknown or blocked scenario survives a reset");
});

test("reset --fresh-config takes the template defaults instead", () => {
  const { root, statePath } = resetRoot((text) =>
    text.replace("max_review_iterations: 2", "max_review_iterations: 1"),
  );
  const { status, stdout } = run("reset", statePath, "--root", root, "--fresh-config", ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /carried .*nothing — --fresh-config/);
  const after = readFileSync(statePath, "utf8");
  assert.match(after, /^ {2}max_review_iterations: 2$/m);
  assert.match(after, /^mode: manual$/m);
});

test("reset seeds one history entry carrying the reason verbatim and no cost figure", () => {
  // Everything else a reader would want is derivable from the document and the clock. WS-W20 is why
  // there is no duration and no token count: a cost figure with no metrics record behind it is a
  // number nobody can tell apart from an invented one.
  const reason = 'the "API Surface" was mapped against the wrong port: 9000 is the SPA, not the API';
  const { root, statePath } = resetRoot();
  assert.equal(run("reset", statePath, "--root", root, "--at", "2026-08-20", "--reason", reason).status, 0);

  const entries = readFileSync(statePath, "utf8").split("history:")[1].trim().split("\n");
  assert.equal(entries.length, 1, "exactly one seeded entry");
  assert.match(entries[0], /step: "0"/);
  assert.match(entries[0], /result: reset/);
  assert.match(entries[0], /at: 2026-08-20/);
  assert.ok(entries[0].includes(JSON.stringify(reason)), entries[0]);
  assert.ok(!/duration_s|tokens/.test(entries[0]), "a reset spends no agent, so it claims no cost");
  // The quoting survives, and --strict is clean: no WS-W20, no unknown key.
  assert.equal(validate(statePath, "--strict").status, 0);
});

test("reset without a reason is a usage error and moves nothing", () => {
  const { root, statePath } = resetRoot();
  const before = treeOf(root);
  const mtime = statSync(statePath).mtimeMs;
  const { status, stderr } = run("reset", statePath, "--root", root);
  assert.equal(status, 2, stderr);
  assert.match(stderr, /--reason/);
  assert.deepEqual(treeOf(root), before);
  assert.equal(statSync(statePath).mtimeMs, mtime);
});

test("reset --dry-run prints the whole move list and touches nothing", () => {
  const { root, statePath } = resetRoot();
  const before = treeOf(root);
  const mtimes = before.map((rel) => statSync(join(root, rel)).mtimeMs);
  const { status, stdout } = run("reset", statePath, "--root", root, "--dry-run", ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /^would reset {2}SCRUM-900 {2}2026-08-20$/m);
  assert.match(stdout, /dry-run {2}nothing was moved and nothing was written/);
  assert.deepEqual(treeOf(root), before);
  assert.deepEqual(before.map((rel) => statSync(join(root, rel)).mtimeMs), mtimes);
});

test("the dry-run plan and the real run agree — the orchestrator confirms against the first", () => {
  // The confirmation the skill asks is a question about this list. If the two could differ, the
  // answer would be to a plan that never ran.
  const { root, statePath } = resetRoot();
  const preview = run("reset", statePath, "--root", root, "--dry-run", ...RESET_ARGS).stdout;
  const real = run("reset", statePath, "--root", root, ...RESET_ARGS).stdout;
  const moves = (text) =>
    text
      .split("\n")
      .filter((line) => / -> /.test(line))
      .map((line) => line.slice(line.indexOf("  ", 2)).trim());
  assert.deepEqual(moves(real), moves(preview));
});

test("an existing archive is never overwritten — the second reset of a day takes the next name", () => {
  // All three of this repository's hand resets used these names, on the same ticket. The third left
  // an `old_do_not_use_` file sitting next to a freshly generated one, so a fourth would have
  // collided on its very first move.
  const { root, statePath } = resetRoot();
  const takenState = `${statePath}.bak-2026-08-20-reset`;
  const takenDoc = join(root, "requirements", "old_do_not_use_SCRUM-900-requirements.md");
  writeFileSync(takenState, "an earlier reset today", "utf8");
  writeFileSync(takenDoc, "an earlier archive", "utf8");

  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /-> \.workflow\/SCRUM-900\.yaml\.bak-2026-08-20-reset\.2$/m);
  assert.match(stdout, /-> requirements\/old_do_not_use_2_SCRUM-900-requirements\.md$/m);
  // An archive that clobbers an archive is not an archive.
  assert.equal(readFileSync(takenState, "utf8"), "an earlier reset today");
  assert.equal(readFileSync(takenDoc, "utf8"), "an earlier archive");
});

test("a recorded artifact already gone from disk is absent, not a refusal", () => {
  // Drift is the commonest reason somebody wants a reset, so a reset must not refuse on it.
  const { root, statePath } = resetRoot((text) => text, ["test-design/SCRUM-900-test-design.md"]);
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /absent .*test-design\/SCRUM-900-test-design\.md.*already gone/);
});

test("reset over a document with a duplicate key is refused before the first rename", () => {
  // Configuration is carried forward out of this document. Reading a value two lines claim is
  // exactly the WS-E01 harm, so the remedy is the documented one — `normalize`, then reset.
  const root = mkdtempSync(join(tmpdir(), "workflow-reset-"));
  const statePath = join(root, ".workflow", "SCRUM-900.yaml");
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, readFileSync(fixture("state-duplicate-key.yaml"), "utf8"), "utf8");
  const { status, stderr } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 1, stderr);
  assert.match(stderr, /\[WS-E01\]/);
  assert.match(stderr, /normalize/);
  assert.deepEqual(treeOf(root), [".workflow/SCRUM-900.yaml"], "nothing was renamed");
});

test("a reset re-run after a partial archive completes the remaining moves", () => {
  // The documented recovery from WS-E41, and the reason there is no rollback: every move already
  // made reports as `absent` on the next plan and is skipped rather than repeated.
  const { root, statePath } = resetRoot((text) => text, ["requirements/SCRUM-900-requirements.md"]);
  const first = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(first.status, 0, first.stdout);
  assert.match(first.stdout, /absent .*requirements\/SCRUM-900-requirements\.md/);
  assert.match(first.stdout, /archive .*test-design\/SCRUM-900-test-design\.md/);
  assert.equal(validate(statePath, "--strict").status, 0);
});

test("reset on a missing state file exits 3 and creates nothing", () => {
  const { status, stderr } = run("reset", join(tmpdir(), "no-such-state-file.yaml"), "--reason", "x");
  assert.equal(status, 3, stderr);
  assert.match(stderr, /no state file at/);
});

test("reset --json prints the plan, and only alongside --dry-run", () => {
  const { root, statePath } = resetRoot();
  const bad = run("reset", statePath, "--root", root, "--json", ...RESET_ARGS);
  assert.equal(bad.status, 2, bad.stderr);
  assert.match(bad.stderr, /--dry-run/);

  const { status, stdout } = run("reset", statePath, "--root", root, "--dry-run", "--json", ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  const payload = JSON.parse(stdout);
  assert.equal(payload.ticket, "SCRUM-900");
  assert.equal(payload.dry_run, true);
  assert.equal(payload.scope, "archive_and_reinitialise");
  assert.equal(payload.state.to, ".workflow/SCRUM-900.yaml.bak-2026-08-20-reset");
  assert.deepEqual(
    payload.moves.filter((move) => move.action === "rename").map((move) => move.field),
    ["artifacts.requirements", "artifacts.test_design", "automation.api.report", "automation.ui.report"],
  );
  assert.deepEqual(payload.kept.map((entry) => entry.field), [
    "automation.api.created_tests[0]",
    "artifacts.metrics",
  ]);
});

test("the reset receipt ends in the word init prints, so the orchestrator's vocabulary is unchanged", () => {
  const { root, statePath } = resetRoot();
  const { status, stdout } = run("reset", statePath, "--root", root, ...RESET_ARGS);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /^created {2}/m);
});

test("reset introduced no schema change — the generated table needed no regenerating", () => {
  // The `## Fields` guard above compares the table to this command's output. This case states the
  // intent behind its continuing to pass untouched: a reset writes a history entry and existing
  // configuration keys, and defines no field of its own.
  const printed = run("print-schema").stdout;
  assert.ok(printed.includes("| `history` |"), printed.slice(0, 200));
  assert.ok(!printed.includes("reset"), "no schema field is named for this command");
});

// ---------------------------------------------------------------------------------------------
// check-streams — the state file's two stream decisions, read against the classified design
//
// `validate` rules on the document alone; `check-artifacts` on what is still on disk. Neither can
// see a stream settled one way while the design says the other — and a stream marked
// `not_applicable` with scenarios waiting for it is the one defect nothing downstream re-derives:
// the work is never launched, and the ship gate cannot tell a stream nobody needed from one nobody
// ran. Exit 5 is that disagreement, kept distinct from 1 (invalid document) and 4 (artifact gone).
// ---------------------------------------------------------------------------------------------

const design = (name) => join(repoRoot, "scripts", "__fixtures__", name);

/** A scratch state file with each stream's status set. `classified-clean.md` has one at each level. */
function streamState({ api = "implemented", ui = "implemented" } = {}) {
  return scratch((text) =>
    text
      .replace(/^ {2}api:\n {4}status: [a-z_]+$/m, `  api:\n    status: ${api}`)
      .replace(/^ {2}ui:\n {4}status: [a-z_]+$/m, `  ui:\n    status: ${ui}`)
      // The clean fixture's UI stream is not_applicable and carries the reason WS-E30 demands;
      // a stream that is no longer not_applicable must not keep it.
      .replace(/^ {4}not_applicable_reason: "no scenario was assigned E2E UI at Checkpoint B"$/m, "    not_applicable_reason: null"),
  );
}

test("check-streams passes when both streams match the design", () => {
  const path = streamState();
  const { status, stdout } = run("check-streams", path, "--design", design("classified-clean.md"));
  assert.equal(status, 0, stdout);
  assert.match(stdout, /streams agree with the design \(E2E API 1 -> implemented; E2E UI 1 -> implemented\)/);
});

test("check-streams catches a stream settled not_applicable while the design assigns it work", () => {
  // The reviewer's case: a stream nobody launched, which nothing downstream re-derives.
  const path = streamState({ ui: "not_applicable" });
  const { status, stdout } = run("check-streams", path, "--design", design("classified-clean.md"));
  assert.equal(status, 5, stdout);
  assert.match(stdout, /automation\.ui\.status {2}\[CS-E02\]/);
  assert.match(stdout, /assigns 1 scenario\(s\) to E2E UI \(SCN-003\)/);
});

test("check-streams catches a stream worked though the design assigns it nothing", () => {
  // The inverse, and the cheaper failure: work the design never asked for. `gap-suggested-level.md`
  // assigns no scenario to E2E UI.
  const path = streamState({ ui: "passed" });
  const { status, stdout } = run("check-streams", path, "--design", design("gap-suggested-level.md"));
  assert.equal(status, 5, stdout);
  assert.match(stdout, /automation\.ui\.status {2}\[CS-E03\]/);
  assert.match(stdout, /settled as not_applicable with a reason, never worked/);
});

test("check-streams says nothing about a stream still pending", () => {
  // `pending` is every stream for most of a run, including one the gate has not reached yet.
  const path = streamState({ api: "pending", ui: "pending" });
  const { status, stdout } = run("check-streams", path, "--design", design("gap-suggested-level.md"));
  assert.equal(status, 0, stdout);
});

test("check-streams refuses an unclassified design rather than reading it as zero", () => {
  // An unclassified design reports zero at every level, which is a true statement about the
  // document and the exact opposite of what this check would conclude from it.
  const path = streamState({ ui: "not_applicable" });
  const dir = mkdtempSync(join(tmpdir(), "workflow-streams-"));
  const unclassified = join(dir, "unclassified.md");
  writeFileSync(
    unclassified,
    readFileSync(design("classified-clean.md"), "utf8").replace(/^Assigned Level: .*\n/gm, "").replace(/^Level Rationale: .*\n/gm, ""),
    "utf8",
  );
  const { status, stdout } = run("check-streams", path, "--design", unclassified);
  assert.equal(status, 5, stdout);
  assert.match(stdout, /\[CS-E01\]/);
  assert.match(stdout, /not classified/);
  // And it does not also report the streams as disagreeing, which would be a conclusion drawn from
  // the zero it just refused to read.
  assert.ok(!stdout.includes("CS-E02"), stdout);
});

test("check-streams --json carries the per-stream rows and its scope", () => {
  const path = streamState({ ui: "not_applicable" });
  const { status, stdout } = run("check-streams", path, "--design", design("classified-clean.md"), "--json");
  assert.equal(status, 5, stdout);
  const payload = JSON.parse(stdout);
  assert.equal(payload.scope, "stream_scope_only");
  assert.equal(payload.classified, true);
  assert.deepEqual(
    payload.streams.map((s) => [s.stream, s.scenarios.length, s.status]),
    [
      ["api", 1, "implemented"],
      ["ui", 1, "not_applicable"],
    ],
  );
  assert.deepEqual(payload.violations.map((v) => v.code), ["CS-E02"]);
});

test("check-streams falls back to the design the state file records, and reports a missing one", () => {
  const path = streamState();
  const { status, stderr } = run("check-streams", path);
  // `state-clean.yaml` records a design path for a ticket that does not exist on disk here.
  assert.equal(status, 3, stderr);
  assert.match(stderr, /no test design at /);
});
