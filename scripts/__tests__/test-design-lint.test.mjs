/**
 * Tests for scripts/test-design-lint.mjs.
 *
 * The subject is a CLI, so every case runs it as one: spawn it over a fixture in
 * scripts/__fixtures__/ and assert on the exit code and the `TD-E<nn>` codes it printed. Nothing here
 * imports the script — it exits the process on every path, and its behaviour *is* the exit code.
 *
 *   node --test scripts/__tests__/            (or: npm run test:lint)
 *
 * The fixtures deliberately satisfy the whole document contract apart from the one defect each is
 * named for, so a violation that is not the expected one is a regression in some unrelated check.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const lintScript = join(repoRoot, "scripts", "test-design-lint.mjs");
const fixture = (name) => join(repoRoot, "scripts", "__fixtures__", name);

/** Run the linter over one fixture. `{ status, stdout, stderr }`. */
function lint(name, ...args) {
  return lintPath(fixture(name), ...args);
}

/** Run the linter over an absolute path — the apply modes write, so they never touch a fixture. */
function lintPath(path, ...args) {
  const result = spawnSync(process.execPath, [lintScript, path, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(result.error, undefined, `failed to spawn the linter: ${result.error?.message}`);
  return result;
}

/** A writable copy of a fixture, so an --apply-* run has something of its own to rewrite. */
function scratchCopy(name, transform = (text) => text) {
  const dir = mkdtempSync(join(tmpdir(), "test-design-lint-"));
  const path = join(dir, name);
  writeFileSync(path, transform(readFileSync(fixture(name), "utf8")), "utf8");
  return path;
}

/** The distinct `TD-E<nn>` / `TD-W<nn>` codes one run reported. */
function codes(stdout) {
  return [...new Set([...stdout.matchAll(/\[(TD-[EW]\d+)\]/g)].map((m) => m[1]))].sort();
}

test("a classified design with no requirement gaps is clean", () => {
  const { status, stdout } = lint("classified-clean.md");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("Manual only at Component passes — automation readiness is not level evidence", () => {
  const { status, stdout } = lint("manual-component.md");
  assert.equal(status, 0, stdout);
  // The retired check. Its code is never reused, so seeing it at all is the regression.
  assert.ok(!stdout.includes("TD-E10"), "TD-E10 is retired and must not fire");
});

test("Manual only on a Requirement Gap passes", () => {
  const { status, stdout } = lint("manual-requirement-gap.md");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout).filter((c) => c.startsWith("TD-E")), []);
});

test("Requirement Gap mixed with a test level fails TD-E04, in both orders", () => {
  const { status, stdout } = lint("mixed-level.md");
  assert.equal(status, 1, stdout);
  assert.ok(stdout.includes('SCN-001  [TD-E04]  Assigned Level: "Component, Requirement Gap" mixes'), stdout);
  assert.ok(stdout.includes('SCN-002  [TD-E04]  Assigned Level: "Requirement Gap, E2E UI" mixes'), stdout);
  // One violation per block, not one per level in the value.
  assert.equal([...stdout.matchAll(/\[TD-E04\]/g)].length, 2, stdout);
});

test("Requirement Gap is not a Suggested Level", () => {
  const { status, stdout } = lint("gap-suggested-level.md");
  assert.equal(status, 1, stdout);
  assert.ok(stdout.includes('Suggested Level: "Requirement Gap" is not a permitted level'), stdout);
});

test("a design carrying gaps beside E2E work is clean and separates the two", () => {
  const { status, stdout } = lint("requirement-gap-e2e.md");
  assert.equal(status, 0, stdout);
});

test("--emit-levels counts Requirement Gap in its own row and blocks it separately", () => {
  const { status, stdout } = lint("requirement-gap-e2e.md", "--emit-levels");
  assert.equal(status, 0, stdout);

  const [levelsLine] = stdout.split("\n");
  assert.equal(levelsLine, "Levels: Unit 1, E2E API 1, E2E UI 1, Requirement Gap 1");
  assert.match(stdout, /^\| Requirement Gap \| 1 \| SCN-004 \|$/m);

  const handedOff = stdout.slice(
    stdout.indexOf("## Handed Off As Follow-Up Work"),
    stdout.indexOf("## Blocked / Requirement Gaps"),
  );
  const blocked = stdout.slice(stdout.indexOf("## Blocked / Requirement Gaps"));
  assert.ok(handedOff.length > 0 && blocked.length > 0, stdout);

  // The gap scenario is blocked work, never automation handoff; the Unit scenario is the reverse.
  assert.ok(handedOff.includes("SCN-003"), handedOff);
  assert.ok(!handedOff.includes("SCN-004"), handedOff);
  assert.ok(blocked.includes("SCN-004"), blocked);
  assert.ok(!blocked.includes("SCN-003"), blocked);

  // The E2E figures are taken over the executable scenarios only.
  assert.match(stdout, /Executable coverage: 3 scenario\(s\) at a testing level; 1 recorded as Requirement Gap/);
});

test("--emit-levels on a gap-free design prints no pseudo-level row and no blocked subsection", () => {
  const { status, stdout } = lint("classified-clean.md", "--emit-levels");
  assert.equal(status, 0, stdout);
  assert.equal(stdout.split("\n")[0], "Levels: Component 1, E2E API 1, E2E UI 1");
  assert.ok(!stdout.includes("Requirement Gap"), stdout);
  assert.ok(!stdout.includes("Blocked /"), stdout);
  assert.ok(!stdout.includes("Executable coverage:"), stdout);
});

test("--implemented-levels rejects the pseudo-level", () => {
  const { status, stderr } = lint("classified-clean.md", "--implemented-levels", "Requirement Gap");
  assert.equal(status, 2, stderr);
  assert.match(stderr, /"Requirement Gap" is not a permitted level/);
});

test("a coverage item cited only by a gap-blocked scenario is traced, not exercised", () => {
  const { status, stdout } = lint("traced-only.md");
  assert.equal(status, 0, stdout);
  assert.deepEqual(
    codes(stdout).filter((c) => c.startsWith("TD-E")),
    [],
  );
});

test("the recount separates exercised, traced-only and uncovered", () => {
  const { status, stdout } = lint("traced-only.md", "--emit-summary");
  assert.equal(status, 0, stdout);
  // EP-2 is cited by a gap-blocked block and an ordinary one, so it is exercised; EP-1 only by the
  // gap-blocked one; EP-4 by nobody at all.
  assert.match(stdout, /^\| Equivalence Partitioning \| 4 \| 2 \| 1 \| 50% \| EP-4 \|$/m);
  assert.match(stdout, /^Techniques: EP 2\/4 \(1 traced-only\), BVA n\/a, DT n\/a, ST n\/a$/m);
});

test("a five-column technique matrix fails TD-E15", () => {
  const path = scratchCopy("traced-only.md", (text) =>
    text
      .replace("| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |", "| Technique | Coverage items | Exercised | Coverage | Uncovered |")
      .replace("|---|---|---|---|---|---|", "|---|---|---|---|---|")
      .replace("| Equivalence Partitioning | 4 | 2 | 1 | 50% | EP-4 |", "| Equivalence Partitioning | 4 | 3 | 75% | EP-4 |")
      .replace(/^\| (Boundary Value Analysis|Decision Table Testing|State Transition Testing) \| 0 \| 0 \| 0 \| — \| — \|$/gm, "| $1 | 0 | 0 | — | — |"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /row has 5 columns; the matrix takes six/);
});

test("a traced-only item with no # Coverage Gaps entry fails TD-E15", () => {
  const path = scratchCopy("traced-only.md", (text) =>
    text.replace(/^- EP-1 is cited only by SCN-001.*$/m, "- (the partition's gap entry, deliberately removed)"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /EP-1\s+\[TD-E15\]\s+coverage item cited only by scenarios that assert nothing/);
});

test("--apply-summary rewrites the counted sections and is idempotent", () => {
  const path = scratchCopy("traced-only.md", (text) =>
    text.replace("Techniques: EP 2/4 (1 traced-only)", "Techniques: EP 4/4"),
  );
  const before = readFileSync(path, "utf8");

  const first = lintPath(path, "--apply-summary");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(first.stdout, /APPLY: rewrote # Summary/);

  const after = readFileSync(path, "utf8");
  assert.notEqual(after, before);
  assert.match(after, /^Techniques: EP 2\/4 \(1 traced-only\), BVA n\/a, DT n\/a, ST n\/a$/m);
  // Only the counted sections move: a scenario block is never this script's to rewrite.
  assert.ok(after.includes("## SCN-001: The panel after a delete that the server refuses"), after);
  assert.equal(lintPath(path).status, 0);

  const second = lintPath(path, "--apply-summary");
  assert.equal(second.status, 0, second.stdout);
  assert.match(second.stdout, /APPLY: no change/);
  assert.equal(readFileSync(path, "utf8"), after);
});

test("--apply-summary keeps the judgement lines it did not compute", () => {
  const path = scratchCopy("manual-requirement-gap.md");
  const { status } = lintPath(path, "--apply-summary");
  assert.equal(status, 0);
  const after = readFileSync(path, "utf8");
  // `Levels:` belongs to the classification step and the blocked-by list is a judgement call about
  // which unknowns matter most. Neither is arithmetic, so neither is this mode's to drop.
  assert.match(after, /^Levels: E2E UI 1, Requirement Gap 1$/m);
});

test("--apply-levels writes the level arithmetic, and skips a design that has none", () => {
  const applied = scratchCopy("manual-requirement-gap.md", (text) =>
    text.replace("Levels: E2E UI 1, Requirement Gap 1", "Levels: E2E UI 2"),
  );
  const first = lintPath(applied, "--apply-levels");
  assert.equal(first.status, 0, first.stdout + first.stderr);
  assert.match(readFileSync(applied, "utf8"), /^Levels: E2E UI 1, Requirement Gap 1$/m);
  assert.match(lintPath(applied, "--apply-levels").stdout, /APPLY: no change/);

  // An unclassified design: arithmetic nobody has done is not arithmetic to write down.
  const unclassified = scratchCopy("traced-only.md");
  const before = readFileSync(unclassified, "utf8");
  const { status, stdout } = lintPath(unclassified, "--apply-levels");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /APPLY: nothing to write/);
  assert.equal(readFileSync(unclassified, "utf8"), before);
});

test("the emit and apply modes are mutually exclusive", () => {
  const { status, stderr } = lint("traced-only.md", "--emit-summary", "--apply-summary");
  assert.equal(status, 2, stderr);
  assert.match(stderr, /mutually exclusive/);
});

test("--apply-summary refuses when it has no source for the requirement ids", () => {
  // Empty traceability matrix and no --requirements: `FR 0/0` would be a full-coverage claim over
  // nothing, so the run refuses rather than writing one.
  const path = scratchCopy("traced-only.md", (text) =>
    text.replace(/# Traceability Matrix\n[\s\S]*?\n# Coverage Matrix/, "# Traceability Matrix\n\n# Coverage Matrix"),
  );
  const before = readFileSync(path, "utf8");
  const { status, stderr } = lintPath(path, "--apply-summary");
  assert.equal(status, 3, stderr);
  assert.match(stderr, /nothing to take the requirement ids from/);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("an apply run over an unparseable document writes nothing", () => {
  const path = scratchCopy("traced-only.md", () => "# Not a test design\n\nnothing here.\n");
  const before = readFileSync(path, "utf8");
  const { status } = lintPath(path, "--apply-summary");
  assert.equal(status, 3);
  assert.equal(readFileSync(path, "utf8"), before);
});

test("--json carries the mixing violation", () => {
  const { status, stdout } = lint("mixed-level.md", "--json");
  assert.equal(status, 1, stdout);
  const report = JSON.parse(stdout);
  const mixing = report.violations.filter((v) => v.code === "TD-E04" && v.message.includes("mixes"));
  assert.equal(mixing.length, 2, stdout);
  assert.deepEqual(mixing.map((v) => v.subject), ["SCN-001", "SCN-002"]);
});

// ---------------------------------------------------------------------------------------------
// --emit-manifest — the design as data
// ---------------------------------------------------------------------------------------------

const manifest = (name, ...args) => JSON.parse(lint(name, "--emit-manifest", ...args).stdout);

test("--emit-manifest carries every scenario with its level, technique and coverage items", () => {
  const { status, stdout } = lint("classified-clean.md", "--emit-manifest");
  assert.equal(status, 0, stdout);
  const m = JSON.parse(stdout);

  assert.equal(m.counts.scenarios, 3);
  assert.equal(m.classified, true);
  assert.deepEqual(m.scenarios_by_level["E2E API"], ["SCN-002"]);
  assert.deepEqual(m.scenarios_by_level["E2E UI"], ["SCN-003"]);
  assert.deepEqual(m.scenarios_by_level["Requirement Gap"], []);

  const first = m.scenarios[0];
  assert.equal(first.id, "SCN-001");
  assert.deepEqual(first.requirements, ["FR-1.1"]);
  assert.deepEqual(first.assigned_levels, ["Component"]);
  assert.deepEqual(first.coverage_items, ["EP-1"]);
  assert.equal(first.requirement_gap, false);
  assert.ok(first.line > 0, "a consumer needs somewhere to cite");
});

test("--emit-manifest writes nothing and stays a recount", () => {
  const before = readFileSync(fixture("classified-clean.md"), "utf8");
  const m = manifest("classified-clean.md");
  assert.equal(readFileSync(fixture("classified-clean.md"), "utf8"), before);
  // The four judgement lines this script refuses to recompute are not in here under any name.
  assert.equal(m.scope, "structure_and_arithmetic_only");
  const flat = JSON.stringify(m);
  for (const judgement of ["E2E journeys", "Demoted by", "Blocked by (top unknowns)"]) {
    assert.ok(!flat.includes(judgement), `${judgement} is a judgement, not a recount`);
  }
});

test("an unclassified design reports no levels and says why", () => {
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(/^(Assigned Level|Level Rationale):.*$\n/gm, ""),
  );
  const m = JSON.parse(lintPath(path, "--emit-manifest").stdout);
  // Zero at every level, because nobody has classified it — not because there is no E2E work. A
  // consumer settling a stream on this must read `classified`, not the empty list.
  assert.equal(m.classified, false);
  assert.equal(m.counts.unassigned, 3);
  assert.deepEqual(m.scenarios_by_level["E2E API"], []);
});

test("a gap-blocked scenario is marked, with its unknowns and its traced-only items", () => {
  const m = manifest("traced-only.md");
  assert.equal(m.counts.gap_blocked, 1);

  const blocked = m.scenarios.filter((s) => s.gap_blocked);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, "SCN-001");
  assert.equal(blocked[0].automation_suitability, "Manual only");
  assert.equal(blocked[0].unknown_markers.length, 1);

  // Cited but never asserted — the distinction that stops a design claiming 100% technique coverage
  // on the strength of scenarios that assert nothing.
  const ep = m.techniques.find((t) => t.prefix === "EP");
  assert.deepEqual(ep.traced_only_ids, ["EP-1"]);
  assert.deepEqual(ep.uncovered, ["EP-4"]);
});

test("a requirement-gap scenario is never counted as executable coverage", () => {
  const m = manifest("requirement-gap-e2e.md");
  const gaps = m.scenarios.filter((s) => s.requirement_gap);
  assert.ok(gaps.length > 0, "the fixture is named for carrying one");
  assert.equal(m.counts.executable, m.counts.assigned - m.counts.requirement_gaps);
  for (const g of gaps) {
    assert.ok(!m.scenarios_by_level["E2E API"].includes(g.id));
    assert.ok(!m.scenarios_by_level["E2E UI"].includes(g.id));
  }
});

test("--emit-manifest emits a broken document's shape but still fails on it", () => {
  const path = scratchCopy("classified-clean.md", (text) => text.replace(/^Priority: High$/m, "Priority: Urgent"));
  const { status, stdout } = lintPath(path, "--emit-manifest");
  // A consumer needs to see the shape of a broken design to know what is broken; the exit code is
  // still the truth about it.
  assert.equal(status, 1);
  const m = JSON.parse(stdout);
  assert.equal(m.counts.scenarios, 3);
  assert.ok(m.violations.some((v) => v.code === "TD-E04"));
});

test("--emit-manifest is mutually exclusive with every other mode", () => {
  for (const other of ["--emit-summary", "--emit-levels", "--apply-summary", "--apply-levels"]) {
    const { status, stderr } = lint("classified-clean.md", "--emit-manifest", other);
    assert.equal(status, 2, `${other} should be refused alongside --emit-manifest`);
    assert.match(stderr, /mutually exclusive/);
  }
});

// ---------------------------------------------------------------------------------------------
// TD-E21 — Folds Into: which test executes a scenario
//
// A folded scenario has no test of its own: its `Expected:` is asserted inside the covering
// scenario's test or nowhere at all. So every way a fold can point at nothing is a way to delete a
// scenario from the run silently, and each gets a case here.
// ---------------------------------------------------------------------------------------------

/** `folded-e2e.md` with the fold line rewritten to whatever this case is about. */
const refold = (value) =>
  scratchCopy("folded-e2e.md", (text) => text.replace(/^Folds Into: SCN-003$/m, `Folds Into: ${value}`));

test("a design folding one E2E scenario into another on the same journey is clean", () => {
  const { status, stdout } = lint("folded-e2e.md");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("a fold keeps the folded scenario's level and only reduces the test count", () => {
  const { status, stdout } = lint("folded-e2e.md", "--emit-levels");
  assert.equal(status, 0, stdout);
  // Two scenarios still carry E2E UI — folding is about which test runs them, not about where their
  // oracle is truthful.
  assert.match(stdout, /^\| E2E UI \| 2 \| SCN-001, SCN-003 \|$/m);
  assert.match(stdout, /^E2E tests implied: E2E API 1, E2E UI 1 \(1 scenario\(s\) folded/m);
});

test("a fold naming a scenario that does not exist is caught", () => {
  const { status, stdout } = lintPath(refold("SCN-404"));
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["TD-E21"]);
  assert.match(stdout, /SCN-404 is not a scenario in this document/);
});

test("a fold across the two streams is caught — an API journey never covers a UI one", () => {
  const { status, stdout } = lintPath(refold("SCN-002"));
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["TD-E21"]);
  assert.match(stdout, /carries E2E API, which does not include this scenario's E2E UI/);
});

test("a fold onto itself is caught", () => {
  const { status, stdout } = lintPath(refold("SCN-001"));
  assert.equal(status, 1, stdout);
  assert.match(stdout, /names this scenario itself/);
});

test("a fold chain is caught — the target has no test of its own to fold into", () => {
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace(
      /^Level Rationale: A journey across routes with a real session — factor 3, no stub reproduces it\.$/m,
      "Level Rationale: A journey across routes with a real session — factor 3, no stub reproduces it.\nFolds Into: SCN-002",
    ),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /SCN-003 is itself folded into SCN-002 — a fold is one hop, never a chain/);
});

test("a fold on a below-E2E scenario is caught — folding is an E2E-only outcome", () => {
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace(/^Assigned Level: E2E UI\nLevel Rationale: The row renders/m, "Assigned Level: Component\nLevel Rationale: The row renders"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /Folds Into: on a scenario assigned Component/);
});

test("a fold on a Requirement Gap scenario is caught — no oracle, so no test runs it", () => {
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace(/^Assigned Level: E2E UI\nLevel Rationale: The row renders/m, "Assigned Level: Requirement Gap\nLevel Rationale: The row renders"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /on a Requirement Gap scenario/);
});

test("a fold line out of position is caught — the three classification lines are contiguous", () => {
  // Moved one line down, inside its own block: the three classification lines are no longer
  // contiguous. Anchored on the line that follows it rather than on "the first bare `Notes:`",
  // which moved the fold into a different scenario as soon as another block's Notes changed.
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace("Folds Into: SCN-003\nAutomation Suitability: High", "Automation Suitability: High\nFolds Into: SCN-003"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /must sit directly after `Level Rationale:`/);
});

test("an E2E tests implied figure that disagrees with the fold lines is caught", () => {
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace(/^E2E tests implied: E2E API 1, E2E UI 1/m, "E2E tests implied: E2E API 1, E2E UI 2"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["TD-E19"]);
  assert.match(stdout, /claims 2 for "E2E UI"; 1 scenario\(s\) carry that level without a `Folds Into:` line/);
});

test("a level summary missing the fold judgement line is caught", () => {
  const path = scratchCopy("folded-e2e.md", (text) =>
    text.replace(/^Folded by the minimum-set pass:.*$\n/m, ""),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.match(stdout, /no `Folded by the minimum-set pass:` line/);
});

test("--emit-manifest carries the fold from both sides and counts the tests it implies", () => {
  const m = manifest("folded-e2e.md");
  assert.equal(m.counts.folded, 1);
  assert.deepEqual(m.e2e_tests_implied, { "E2E API": 1, "E2E UI": 1 });

  const folded = m.scenarios.find((s) => s.id === "SCN-001");
  const covering = m.scenarios.find((s) => s.id === "SCN-003");
  assert.equal(folded.folds_into, "SCN-003");
  assert.deepEqual(folded.folds, []);
  assert.equal(covering.folds_into, null);
  // The same fact from the covering side, so an implementing step reading one scenario does not
  // have to scan the document for who points at it.
  assert.deepEqual(covering.folds, ["SCN-001"]);
  // Still E2E UI. A fold says which test runs it, never where its oracle is truthful.
  assert.deepEqual(folded.assigned_levels, ["E2E UI"]);
  assert.ok(m.scenarios_by_level["E2E UI"].includes("SCN-001"));

  // The judgement half stays out of the manifest, exactly like the other four carried lines.
  assert.ok(!JSON.stringify(m).includes("Folded by the minimum-set pass"));
});

test("an unfolded design reports no folds and one test per E2E scenario", () => {
  const m = manifest("classified-clean.md");
  assert.equal(m.counts.folded, 0);
  assert.deepEqual(m.e2e_tests_implied, { "E2E API": 1, "E2E UI": 1 });
  for (const s of m.scenarios) {
    assert.equal(s.folds_into, null);
    assert.deepEqual(s.folds, []);
  }
});

test("TD-E19 reads the blocked table's Scenario column, not its Expected prose", () => {
  // A gap scenario's `Expected:` is copied verbatim into the blocked table, and a scenario may
  // legitimately cross-reference another one there ("see SCN-002"). Scanning the whole subsection
  // read that mention as a claimed row and reported a scenario nobody had listed — TD-E19 fired on
  // SCRUM-115's design for exactly this, against a document that was correct.
  const path = scratchCopy("requirement-gap-e2e.md", (text) =>
    text.replaceAll(
      "Not assertable — the requirements do not state what the panel shows once a delete is refused.",
      "Not assertable — the requirements do not state what the panel shows once a delete is refused (the refusal itself is covered by SCN-002).",
    ),
  );

  const { status, stdout } = lintPath(path);
  assert.equal(status, 0, stdout);
  assert.ok(!codes(stdout).includes("TD-E19"), `a prose cross-reference is not a listed row: ${stdout}`);
});

test("TD-E19 still catches a blocked table that lists a scenario which is not a requirement gap", () => {
  // The companion to the case above: narrowing what counts as a row must not stop the check
  // ruling on the rows themselves, in either direction.
  const path = scratchCopy("requirement-gap-e2e.md", (text) =>
    text.replace("| SCN-004 | FR-1.4 | Not assertable", "| SCN-001 | FR-1.4 | Not assertable"),
  );

  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E19"), stdout);
  assert.match(stdout, /omits SCN-004/);
  assert.match(stdout, /lists SCN-001, which do not belong there/);
});

// ---------------------------------------------------------------------------------------------
// TD-E22 — the API coverage decision on a backend-backed UI scenario
//
// A UI scenario whose behaviour runs through the server either has an API scenario carrying the
// contract, or a stated reason why the backend half needs none. What it may not be is silent: a
// reader downstream cannot tell "the contract is covered elsewhere" from "nobody considered it",
// and the two lead to opposite decisions about what to automate.
//
// The scenario the cases below edit is `classified-clean.md`'s SCN-003 — an E2E UI journey that
// signs in, which is what makes it backend-backed.
// ---------------------------------------------------------------------------------------------

const API_COVERAGE_NOTE =
  "Notes: API coverage: not needed — sign-in and the panel fetch are session mechanics for this journey; the admin-list authorization contract is covered by SCN-002.";

test("TD-E22 catches a backend-backed UI scenario with no API coverage decision", () => {
  const path = scratchCopy("classified-clean.md", (text) => text.replace(API_COVERAGE_NOTE, "Notes: —"));
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["TD-E22"]);
  assert.match(stdout, /SCN-003 {2}\[TD-E22\] {2}backend-backed UI scenario has no `API coverage:` decision/);
});

test("TD-E22 accepts a link to an E2E API scenario", () => {
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(API_COVERAGE_NOTE, "Notes: API coverage: linked SCN-002 — the authorization contract is asserted there."),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("TD-E22 catches a link to a scenario the document does not carry", () => {
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(API_COVERAGE_NOTE, "Notes: API coverage: linked SCN-099 — asserted there."),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E22"), stdout);
  assert.match(stdout, /links SCN-099, which is not a scenario in this document/);
});

test("TD-E22 catches a link to a scenario that is not E2E API", () => {
  // The link is the claim "the contract is asserted over there". A scenario at another level does
  // not assert it, so a link to one is the same silence the rule exists to stop, wearing an id.
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(API_COVERAGE_NOTE, "Notes: API coverage: linked SCN-001 — asserted there."),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E22"), stdout);
  assert.match(stdout, /links SCN-001, which is not an E2E API scenario/);
});

test("TD-E22 requires a reason on a not-needed exemption", () => {
  // `not needed` with nothing after it is a decision nobody can review.
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(API_COVERAGE_NOTE, "Notes: API coverage: not needed"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E22"), stdout);
  assert.match(stdout, /must include the exemption reason after a dash/);
});

test("TD-E22 says nothing about an E2E API scenario, whatever its Notes say", () => {
  // The rule is about a UI scenario leaning on the backend. A scenario that *is* the API test
  // carries its own contract, so asking it to name another one would be circular.
  const { status, stdout } = lint("classified-clean.md");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

// ---------------------------------------------------------------------------------------------
// After the merge: one step writes and classifies, so `Suggested Level:` has nothing to suggest to
// itself. It is optional rather than removed, because documents written before the merge still
// carry it and are still valid.
// ---------------------------------------------------------------------------------------------

test("a block with no Suggested Level line is clean — the field is optional, not removed", () => {
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(/^Suggested Level: .*\n/gm, ""),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("a Suggested Level line that is still present is still checked", () => {
  // Optional does not mean ignored: a document that carries the field must carry a real level in it.
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace("Suggested Level: Component", "Suggested Level: Smoke"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E04"), stdout);
  assert.match(stdout, /"Smoke" is not a permitted level/);
});

test("a Suggested Level line out of contract order still fails TD-E02", () => {
  const path = scratchCopy("classified-clean.md", (text) =>
    text
      .replace(/^Suggested Level: (.*)\n/m, "")
      .replace(/^Requirement: (.*)$/m, "Suggested Level: Component\nRequirement: $1"),
  );
  const { status, stdout } = lintPath(path);
  assert.equal(status, 1, stdout);
  assert.ok(codes(stdout).includes("TD-E02"), stdout);
  assert.match(stdout, /out of contract order/);
});

test("--apply-all repairs the summary and the level arithmetic in one invocation", () => {
  // Two passes, not one: rewriting `# Summary` moves every line below it, so a single parse would
  // splice the level section at a line number that had already moved.
  const path = scratchCopy("classified-clean.md", (text) =>
    text.replace(/^Scenarios: .*$/m, "Scenarios: 99").replace(/^Levels: .*$/m, "Levels: nonsense"),
  );
  const { status, stdout } = lintPath(path, "--apply-all");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /rewrote # Summary/);
  assert.match(stdout, /rewrote # Summary \(Levels:\)/);

  const after = readFileSync(path, "utf8");
  assert.doesNotMatch(after, /^Scenarios: 99$/m);
  assert.doesNotMatch(after, /^Levels: nonsense$/m);
  assert.equal(lintPath(path).status, 0);

  // Idempotent, like each pass on its own.
  assert.match(lintPath(path, "--apply-all").stdout, /no change/);
});

test("--apply-all is mutually exclusive with the single apply modes", () => {
  const { status, stderr } = lint("classified-clean.md", "--apply-all", "--apply-levels");
  assert.equal(status, 2);
  assert.match(stderr, /mutually exclusive/);
});

test("classified is false while any scenario is unassigned, not merely true once one is", () => {
  // A gate settles whole streams from `scenarios_by_level`, and that map omits a block with no
  // `Assigned Level:` line. Reporting `classified: true` on a partial design therefore hands the gate
  // a level list with scenarios silently missing from it — and a stream whose only scenario is the
  // missing one gets settled `not_applicable` and never launched.
  const path = scratchCopy("classified-clean.md", (text) => {
    const blocks = text.split("\n## SCN-");
    const last = blocks.length - 1;
    blocks[last] = blocks[last]
      .replace(/^Assigned Level: .*\n/m, "")
      .replace(/^Level Rationale: .*\n/m, "");
    return blocks.join("\n## SCN-");
  });

  const partial = JSON.parse(lintPath(path, "--emit-manifest").stdout);
  assert.equal(partial.counts.unassigned, 1);
  assert.equal(partial.classified, false, "a partially classified design must not report classified");

  const whole = JSON.parse(lint("classified-clean.md", "--emit-manifest").stdout);
  assert.equal(whole.counts.unassigned, 0);
  assert.equal(whole.classified, true);
});
