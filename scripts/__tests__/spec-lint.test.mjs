/**
 * Tests for scripts/spec-lint.mjs.
 *
 * The subject is a CLI, so every case runs it as one: point it at a fixture tree with `--root` and
 * assert on the exit code and the `SL-E<nn>` codes it printed. Nothing here imports the script — it
 * exits the process on every path, and its behaviour *is* the exit code.
 *
 *   node --test scripts/__tests__/            (or: npm run test:scripts)
 *
 * Two fixture trees, described in scripts/__fixtures__/spec-lint/README.md. `clean/` satisfies every
 * rule, and a violation reported over it is a false positive — the failure mode a linter cannot
 * survive. Each file under `violations/` carries exactly the defect it is named for, so a case
 * asserting one code proves that rule fires *and* that no other rule fired on the same file.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const lintScript = join(repoRoot, "scripts", "spec-lint.mjs");
const fixtureRoot = join(repoRoot, "scripts", "__fixtures__", "spec-lint");
const cleanTree = join(fixtureRoot, "clean");
const violationTree = join(fixtureRoot, "violations");
const report = (name) => join(fixtureRoot, "reports", name);

/** Run the linter. `{ status, stdout, stderr }`. */
function lint(...args) {
  const result = spawnSync(process.execPath, [lintScript, ...args], {
    encoding: "utf8",
    cwd: repoRoot,
  });
  assert.equal(result.error, undefined, `failed to spawn the linter: ${result.error?.message}`);
  return result;
}

/** Run one stream over one file of the violations tree. */
function lintOne(stream, path, ...args) {
  return lint("--stream", stream, "--root", violationTree, "--changed", path, ...args);
}

/** The distinct `SL-E<nn>` codes one run reported. */
function codes(stdout) {
  return [...new Set([...stdout.matchAll(/\[(SL-E\d+)\]/g)].map((m) => m[1]))].sort();
}

// --- the clean tree --------------------------------------------------------

test("the clean fixture tree reports nothing, for either stream", () => {
  for (const stream of ["api", "ui"]) {
    const { status, stdout } = lint("--stream", stream, "--root", cleanTree);
    assert.equal(status, 0, `${stream}: ${stdout}`);
    assert.deepEqual(codes(stdout), [], stream);
  }
});

test("the clean tree stays clean with a report that documents nothing, because it drops no tier", () => {
  const { status, stdout } = lint(
    "--stream", "ui", "--root", cleanTree, "--report", report("ui-implementation-silent.md"),
  );
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

// --- one case per rule -----------------------------------------------------

const CASES = [
  ["SL-E01", "api", "tests/api/e01-fixed-wait.spec.ts"],
  ["SL-E02", "api", "tests/api/e02-playwright-import.spec.ts"],
  ["SL-E03", "ui", "pages/e03-expect-in-page.ts"],
  ["SL-E04", "api", "tests/api/e04-url-literal.spec.ts"],
  ["SL-E05", "api", "utils/e05-process-env.ts"],
  ["SL-E06", "api", "tests/api/e06-title.spec.ts"],
  ["SL-E07", "api", "tests/api/e07-phases.spec.ts"],
  ["SL-E08", "api", "tests/api/e08-no-scn.spec.ts"],
  ["SL-E09", "ui", "tests/ui/e09-builder.spec.ts"],
  ["SL-E10", "api", "tests/api/e10-wrong-stream-email.spec.ts"],
  ["SL-E10", "api", "tests/api/e10-email-literal.spec.ts"],
  ["SL-E12", "ui", "pages/e12-outside-the-ladder.ts"],
  ["SL-E14", "api", "tests/api/e14-credential.spec.ts"],
  ["SL-E15", "ui", "pages/e15-snapshot-ref.ts"],
];

for (const [code, stream, path] of CASES) {
  test(`${code} — ${path} reports ${code} and nothing else`, () => {
    const { status, stdout } = lintOne(stream, path);
    assert.equal(status, 1, stdout);
    assert.deepEqual(codes(stdout), [code], stdout);
  });
}

// --- the rules with more than one direction --------------------------------

test("SL-E07 names the phase that appeared twice, not merely that the test is malformed", () => {
  const { stdout } = lintOne("api", "tests/api/e07-phases.spec.ts");
  assert.match(stdout, /2 \/\/ Act comments/);
});

test("SL-E07 accepts `// Arrange & Act`, the house form for a test with nothing to arrange", () => {
  // The second test of the clean API spec is written that way; the tree lints clean above, so this
  // asserts the reason rather than the result.
  const { status, stdout } = lint("--stream", "api", "--root", cleanTree);
  assert.equal(status, 0, stdout);
});

test("SL-E10 tells a stream collision from an address normalizeEmail() would rewrite", () => {
  const collision = lintOne("api", "tests/api/e10-wrong-stream-email.spec.ts").stdout;
  assert.match(collision, /uniqueUiEmail\(\) in a api spec/);
  const literal = lintOne("api", "tests/api/e10-email-literal.spec.ts").stdout;
  assert.match(literal, /dot or a plus in its local part/);
});

test("SL-E11 passes a tier drop the report's locator_gaps names", () => {
  const { status, stdout } = lintOne(
    "ui", "pages/e11-undocumented-fallback.ts", "--report", report("ui-implementation-documented.md"),
  );
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), []);
});

test("SL-E11 fails a tier drop the report records nowhere", () => {
  const { status, stdout } = lintOne(
    "ui", "pages/e11-undocumented-fallback.ts", "--report", report("ui-implementation-silent.md"),
  );
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["SL-E11"]);
  assert.match(stdout, /genreCell/);
});

test("SL-E11 fails the inverse too — a map row claiming a tier drop no page object carries", () => {
  const { status, stdout } = lint(
    "--stream", "ui", "--root", cleanTree, "--report", report("ui-implementation-orphan-row.md"),
  );
  assert.equal(status, 1, stdout);
  assert.deepEqual(codes(stdout), ["SL-E11"]);
  assert.match(stdout, /statusBanner/);
});

test("SL-E11 is skipped, not passed, when no report was given", () => {
  const { stdout } = lintOne("ui", "pages/e11-undocumented-fallback.ts");
  assert.deepEqual(codes(stdout), []);
  assert.match(stdout, /Skipped:[\s\S]*SL-E11/);
});

test("SL-E12 separates a structural nth() from one reaching a data row", () => {
  const { stdout } = lintOne("ui", "pages/e12-outside-the-ladder.ts");
  assert.match(stdout, /nth\(\) on a non-structural element/);
  // The clean page object indexes a rowgroup and a cell, and neither is a finding.
  const clean = lint("--stream", "ui", "--root", cleanTree).stdout;
  assert.doesNotMatch(clean, /nth\(\)/);
});

test("SL-E13 fails a changed path outside the stream's boundary and passes one inside it", () => {
  const outside = lint(
    "--stream", "ui", "--root", cleanTree, "--changed", "tests/api/admin-api.spec.ts",
  );
  assert.equal(outside.status, 1, outside.stdout);
  assert.deepEqual(codes(outside.stdout), ["SL-E13"]);

  const inside = lint(
    "--stream", "ui", "--root", cleanTree, "--changed", "tests/ui/owner.spec.ts", "pages/owner-page.ts",
  );
  assert.equal(inside.status, 0, inside.stdout);
});

test("SL-E13 is skipped, not passed, when no change set was given", () => {
  const { stdout } = lint("--stream", "api", "--root", cleanTree);
  assert.match(stdout, /Skipped:[\s\S]*SL-E13/);
});

// --- the judgement warnings ------------------------------------------------

test("SL-W01 to SL-W04 report where to look and never fail the run", () => {
  const { status, stdout } = lintOne("ui", "tests/ui/w01-judgement.spec.ts");
  assert.equal(status, 0, stdout);
  assert.deepEqual(codes(stdout), [], "a warning is not a violation");
  const reported = [...new Set([...stdout.matchAll(/\[(SL-W\d+)\]/g)].map((m) => m[1]))].sort();
  assert.deepEqual(reported, ["SL-W01", "SL-W02", "SL-W03", "SL-W04"], stdout);
  assert.match(stdout, /Judgement required \(not violations\)/);
});

test("the warnings travel in --emit-json under their own key", () => {
  const { stdout } = lintOne("ui", "tests/ui/w01-judgement.spec.ts", "--emit-json");
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed.violations, []);
  assert.equal(parsed.warnings.length, 4);
  assert.ok(parsed.warnings.every((w) => w.code.startsWith("SL-W")));
});

test("the clean tree raises no warnings either — a paired negative assertion is not a warning", () => {
  // `clean/tests/ui/owner.spec.ts` asserts a row visible and never absent, and holds nothing at
  // module scope. A warning here would mean the shape-finders match ordinary correct code.
  const { stdout } = lint("--stream", "ui", "--root", cleanTree);
  assert.doesNotMatch(stdout, /Judgement required/, stdout);
});

// --- what the linter deliberately does not report --------------------------

test("a comment naming a banned construct is prose, not a violation", () => {
  // `clean/pages/owner-page.ts` explains its structural nth() in a comment and the clean API spec
  // carries `// Act gate` after an assertion. Both would fire if comments were scanned as code.
  const { status, stdout } = lint("--stream", "ui", "--root", cleanTree);
  assert.equal(status, 0, stdout);
});

// --- the CLI itself --------------------------------------------------------

test("--stream is required, and an unknown stream is a usage error", () => {
  const missing = lint("--root", cleanTree);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /no --stream given/);

  const wrong = lint("--stream", "e2e", "--root", cleanTree);
  assert.equal(wrong.status, 2);
  assert.match(wrong.stderr, /is not api or ui/);
});

test("a --changed path that does not exist is exit 3, not a violation", () => {
  const { status, stderr } = lint(
    "--stream", "api", "--root", cleanTree, "--changed", "tests/api/never-written.spec.ts",
  );
  assert.equal(status, 3);
  assert.match(stderr, /do not exist/);
});

test("--emit-json carries the violations, the scanned set and what was skipped", () => {
  const { status, stdout } = lintOne("api", "tests/api/e01-fixed-wait.spec.ts", "--emit-json");
  assert.equal(status, 1);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.stream, "api");
  assert.deepEqual(parsed.scanned, ["tests/api/e01-fixed-wait.spec.ts"]);
  assert.equal(parsed.violations.length, 1);
  assert.equal(parsed.violations[0].code, "SL-E01");
  assert.equal(parsed.violations[0].subject, "tests/api/e01-fixed-wait.spec.ts");
  assert.ok(parsed.violations[0].line > 0);
  assert.ok(parsed.skipped.some((s) => s.startsWith("SL-E11")));
});

// --- the repository itself -------------------------------------------------

test("the repository's own specs report only the pre-existing missing scenario ids", () => {
  // These specs were written before the workflow that mints SCN ids existed, so every test in them
  // is an SL-E08. Any other code appearing here is a regression in the repository, not in the
  // linter, and that is exactly what this case is for.
  for (const stream of ["api", "ui"]) {
    const { stdout } = lint("--stream", stream);
    assert.deepEqual(codes(stdout), ["SL-E08"], `${stream}: ${stdout}`);
  }
});
