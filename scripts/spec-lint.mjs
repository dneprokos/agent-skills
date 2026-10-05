#!/usr/bin/env node
/**
 * spec-lint.mjs — deterministic mechanical checks over the test code one stream wrote.
 *
 * The same argument as `test-design-lint.mjs`, pointed at TypeScript instead of a design document.
 * Most of what a test-code review used to spend its rows on is a grep with a rule attached: an
 * import from the wrong module, a fixed wait, a URL string, a credential literal, a title that does
 * not match the house form, a phase comment that appears twice. A model finds those slowly, in
 * context, and misses one per file; a script finds every one of them or none. So the reviewing side
 * runs this and spends its tokens on the questions only it can answer — whether an assertion
 * carries the value the scenario named, whether a wait matches a mechanic somebody watched fire,
 * whether the test is true to the scenario at all.
 *
 * Usage:
 *   node scripts/spec-lint.mjs --stream api|ui [--changed <path>...] [--report <path>] [--emit-json]
 *
 * Options:
 *   --stream    required. `api` scans `tests/api/**` and `services/api/**`; `ui` scans
 *               `tests/ui/**` and `pages/**`. Both also scan `utils/**` and their own fixture file.
 *   --changed   restrict the scan to these repo-relative paths, and check each one against the
 *               stream's write boundary (SL-E13). Without it the whole stream is scanned and E13
 *               is reported as skipped — there is no change set to rule on.
 *   --report    the stream's implementation report. Enables SL-E11, which cross-checks every
 *               `LOCATOR-FALLBACK` comment against the report's `locator_gaps` and
 *               `Explored Locators` map. Without it SL-E11 is reported as skipped.
 *   --emit-json emit the violations as JSON instead of one line each. `--json` is accepted as an
 *               alias, matching `test-design-lint.mjs`.
 *   --root      the directory every path is resolved against and reported relative to. Defaults to
 *               the repository root, which is what every real run wants; the tests point it at a
 *               fixture tree, because a rule scoped by path prefix cannot be exercised from a
 *               fixture that does not live at `tests/api/…`.
 *
 * Exit codes:
 *   0  clean (warnings alone never fail a run)
 *   1  violations found
 *   2  usage error
 *   3  a named path is missing or could not be read
 *
 * TWO KINDS OF FINDING, AND THE SPLIT IS LOAD-BEARING. `SL-E<nn>` is a rule the code broke, and the
 * script has all the evidence: an import from the wrong module is wrong wherever it appears.
 * `SL-W<nn>` is a *shape* whose verdict lives in the code around it — a negative assertion that may
 * or may not be paired, a soft assertion that may or may not be on a precondition, an existence
 * check that may be guarding a loop, a module-scope helper that may only be reading a response.
 * Reporting those as violations would be a linter ruling without evidence, and leaving them out
 * would send a reviewer back to grepping for them by hand, which is the work this script removes.
 * So they are printed under their own heading, they exit 0, and the reviewer reads each one.
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE. It never rules on whether an assertion carries the value the
 * scenario names, whether a wait matches an observed mechanic, whether a test is a truthful
 * implementation of the scenario it cites, whether a cleanup registration sits before the call
 * that could fail, or whether a red test is the application's fault. Those are judgement, they are
 * the whole reason a review runs at all, and a clean run of this script is never evidence that they
 * were made well.
 *
 * COMMENTS ARE BLANKED BEFORE MOST RULES RUN. A `setTimeout` named in a comment explaining why the
 * code does not use one is not a fixed wait, and a URL in a doc comment is not a hard-coded route.
 * Rules that must read a comment — the phase comments, the scenario id, the locator fallback
 * receipt — run against the raw text instead, and say so in their scope.
 */

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const EXIT_CLEAN = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;
const EXIT_UNREADABLE = 3;

const here = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(here, "..");

// --- the contract, as data -------------------------------------------------

/**
 * What each stream owns, and therefore what a `--changed` path may name (SL-E13). `utils/**` and,
 * for the UI stream, `services/api/**` are additive-only carve-outs — this script rules on whether
 * a path is inside the boundary, never on whether the change to it was additive, which needs the
 * diff and is a review question.
 */
const WRITE_BOUNDARY = {
  api: ["tests/api/", "services/api/", "fixtures/api-fixture.ts", "utils/"],
  ui: ["tests/ui/", "pages/", "fixtures/pages-fixture.ts", "services/api/", "utils/"],
};

/** The files a full (non-`--changed`) run of each stream reads. */
const STREAM_ROOTS = {
  api: ["tests/api", "services/api", "utils", "fixtures/api-fixture.ts"],
  ui: ["tests/ui", "pages", "utils", "fixtures/pages-fixture.ts"],
};

/**
 * SL-E05 is the one rule with no stream: `process.env` belongs to one file in this repository, and
 * a second reader of it is a defect wherever it is. These roots are scanned on every run.
 */
const ENV_ROOTS = ["tests", "pages", "fixtures", "services", "utils", "framework"];
const CONFIG_FILE = "framework/configuration/config.ts";

/** The fixture module a spec of each stream imports `test` and `expect` from. */
const FIXTURE_MODULE = { api: "@fixtures/api-fixture", ui: "@fixtures/pages-fixture" };

/**
 * `nth()` on a structural element is tier 1 — the second rowgroup of a table is its body, and a
 * cell index is a column. `nth()` reaching a data row is banned, because its position depends on
 * which other tests are running in parallel. The difference is what the call is anchored to, so
 * this is the allowlist of anchors rather than a list of banned shapes.
 */
const STRUCTURAL_NTH_ANCHORS = ["rowgroup", "cell", "columnheader", "rowheader", "table"];

/** Both accepted title forms. The API stream accepts only the first. */
const TITLE_SUBJECT_SHOULD = /^.+\S\s-\sShould\s\S.*$/;
const TITLE_AS_A_ROLE = /^As an?\s.+,\sI should\s\S.*$/;

// --- arguments -------------------------------------------------------------

function usage(message) {
  if (message) process.stderr.write(`spec-lint: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/spec-lint.mjs --stream api|ui [--changed <path>...] " +
      "[--report <path>] [--root <dir>] [--emit-json]\n",
  );
  process.exit(EXIT_USAGE);
}

const argv = process.argv.slice(2);
let stream = null;
let reportPath = null;
let asJson = false;
let root = defaultRoot;
const changed = [];

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--stream") {
    stream = argv[++i] ?? null;
    if (!stream) usage("--stream needs a value");
    if (stream !== "api" && stream !== "ui") usage(`--stream: "${stream}" is not api or ui`);
  } else if (arg === "--changed") {
    // Consumes every following non-flag token, so `--changed a.ts b.ts` is one list.
    while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) changed.push(argv[++i]);
    if (changed.length === 0) usage("--changed needs at least one path");
  } else if (arg === "--report") {
    reportPath = argv[++i] ?? null;
    if (!reportPath) usage("--report needs a path");
  } else if (arg === "--root") {
    const value = argv[++i] ?? null;
    if (!value) usage("--root needs a directory");
    root = resolve(value);
    if (!existsSync(root)) usage(`--root: ${value} does not exist`);
  } else if (arg === "--emit-json" || arg === "--json") {
    asJson = true;
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else {
    usage(`unexpected argument ${arg} — paths go after --changed`);
  }
}

if (!stream) usage("no --stream given");
if (reportPath && !existsSync(resolve(root, reportPath))) {
  process.stderr.write(`spec-lint: ${reportPath} does not exist\n`);
  process.exit(EXIT_UNREADABLE);
}

// --- reading ---------------------------------------------------------------

const toPosix = (p) => p.split("\\").join("/");

/** Every `.ts` file under one root-relative path, or that path itself when it is a file. */
function collect(subPath) {
  const abs = resolve(root, subPath);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return abs.endsWith(".ts") ? [toPosix(relative(root, abs))] : [];
  const out = [];
  for (const entry of readdirSync(abs, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
    out.push(...collect(toPosix(join(subPath, entry.name))));
  }
  return out;
}

/**
 * Blank every comment, preserving line and column structure so a violation's line number still
 * points at the source. Strings survive untouched: a URL in a string literal is a hard-coded route,
 * and the same URL in a comment is prose.
 */
function blankComments(text) {
  const out = [];
  let i = 0;
  let mode = "code"; // code | line | block | "'" | '"' | "`"
  while (i < text.length) {
    const c = text[i];
    const next = text[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") { mode = "line"; out.push("  "); i += 2; continue; }
      if (c === "/" && next === "*") { mode = "block"; out.push("  "); i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { mode = c; out.push(c); i += 1; continue; }
      out.push(c); i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { mode = "code"; out.push(c); i += 1; continue; }
      out.push(" "); i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") { mode = "code"; out.push("  "); i += 2; continue; }
      out.push(c === "\n" ? c : " "); i += 1; continue;
    }
    // inside a string literal
    if (c === "\\") { out.push(c, next ?? ""); i += 2; continue; }
    if (c === mode) mode = "code";
    out.push(c); i += 1;
  }
  return out.join("");
}

function loadFile(path) {
  let raw;
  try {
    raw = readFileSync(resolve(root, path), "utf8");
  } catch (error) {
    process.stderr.write(`spec-lint: cannot read ${path}: ${error.message}\n`);
    process.exit(EXIT_UNREADABLE);
  }
  const code = blankComments(raw);
  return {
    path,
    raw,
    code,
    rawLines: raw.split(/\r?\n/),
    codeLines: code.split(/\r?\n/),
  };
}

let scanned;
if (changed.length > 0) {
  const missing = changed.filter((p) => !existsSync(resolve(root, p)));
  if (missing.length > 0) {
    process.stderr.write(`spec-lint: --changed names paths that do not exist: ${missing.join(", ")}\n`);
    process.exit(EXIT_UNREADABLE);
  }
  scanned = [...new Set(changed.map(toPosix).filter((p) => p.endsWith(".ts")))];
} else {
  scanned = [...new Set(STREAM_ROOTS[stream].flatMap(collect))].sort();
}

// SL-E05 sweeps the whole source tree on a full run, because a second reader of `process.env` is a
// defect wherever it sits. A `--changed` run is about that change set and nothing else: sweeping
// then would report a file the run did not touch, which a creator cannot act on and a reviewer has
// already seen.
const envScanned = changed.length > 0 ? scanned : [...new Set(ENV_ROOTS.flatMap(collect))].sort();
const files = new Map();
for (const path of [...scanned, ...envScanned]) if (!files.has(path)) files.set(path, loadFile(path));

// --- violations ------------------------------------------------------------

const violations = [];
const warnings = [];
const skipped = [];

/** One violation. `subject` is the repo-relative path, so the report sorts by file. */
function fail(code, file, line, message) {
  violations.push({ code, subject: file, line, message });
}

/**
 * One shape a reviewer has to look at, and a verdict this script cannot reach. `SL-W<nn>` is never
 * a violation and never fails a run: the grep finds the construct, and only the surrounding code
 * says whether it is correct — whether the negative assertion is paired, whether the soft one sits
 * in `// Assert` over independent observables, whether the existence check is guarding a loop,
 * whether the module-scope helper reads a response or produces test data. Reporting these as
 * defects would be a linter making a judgement it has no evidence for; omitting them would leave a
 * reviewer grepping for them by hand, which is the work this script exists to remove.
 */
function judge(code, file, line, message) {
  warnings.push({ code, subject: file, line, message });
}

const specDir = stream === "api" ? "tests/api/" : "tests/ui/";
const isSpec = (p) => p.startsWith(specDir);
const isPage = (p) => p.startsWith("pages/");

/** Every match of `re` over the code (comments blanked), as `{ line, text }`. */
function matchesInCode(file, re) {
  const out = [];
  file.codeLines.forEach((text, index) => {
    const line = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    let m;
    while ((m = line.exec(text)) !== null) {
      out.push({ line: index + 1, text: text.trim(), full: text, match: m });
      if (m.index === line.lastIndex) line.lastIndex += 1;
    }
  });
  return out;
}

/** Every match of `re` over the raw text, comments included. */
function matchesInRaw(file, re) {
  const out = [];
  file.rawLines.forEach((text, index) => {
    if (re.test(text)) out.push({ line: index + 1, text: text.trim() });
    re.lastIndex = 0;
  });
  return out;
}

// SL-E01 — fixed waits and synchronisation crutches. tests/** and pages/**.
for (const path of scanned.filter((p) => isSpec(p) || isPage(p))) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /\b(waitForTimeout|setTimeout)\s*\(/)) {
    fail("SL-E01", path, hit.line, `${hit.match[1]} — a fixed wait. Use a web-first assertion or the locator API`);
  }
  for (const hit of matchesInCode(file, /["'`]networkidle["'`]/)) {
    fail("SL-E01", path, hit.line, "networkidle used as a synchronisation crutch — wait on the response or the rendered result");
  }
}

// SL-E02 — a spec's fixture import. tests/**.
for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /from\s+["']@playwright\/test["']/)) {
    fail("SL-E02", path, hit.line, `imports from @playwright/test — a spec imports test and expect from ${FIXTURE_MODULE[stream]}`);
  }
  if (stream === "ui") {
    for (const hit of matchesInCode(file, /from\s+["']@fixtures\/api-fixture["']/)) {
      fail("SL-E02", path, hit.line, "a UI spec imports from @fixtures/api-fixture — the page objects and the seeded session come from @fixtures/pages-fixture");
    }
  }
}

// SL-E03 — no assertion in a page object. pages/**.
for (const path of scanned.filter(isPage)) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /\bexpect\s*[.(]/)) {
    fail("SL-E03", path, hit.line, "expect in a page object — assertions live in the spec, and a page-object loop waits with waitFor({ state: \"detached\" }) rather than expect.poll");
  }
}

// SL-E04 — no URL literal. tests/** and pages/**.
for (const path of scanned.filter((p) => isSpec(p) || isPage(p))) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /["'`]https?:\/\//)) {
    fail("SL-E04", path, hit.line, "a URL literal — routes come from services/api/endpoints.ts, and the host comes from Config.BASE_URL");
  }
}

// SL-E05 — process.env belongs to one file. Every source root, every run.
for (const path of envScanned) {
  if (path === CONFIG_FILE) continue;
  const file = files.get(path);
  for (const hit of matchesInCode(file, /\bprocess\.env\b/)) {
    fail("SL-E05", path, hit.line, `process.env outside ${CONFIG_FILE} — read the validated Config class instead`);
  }
}

// SL-E06 — title form, per stream. tests/**. Raw text: a title is a string, never a comment.
for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /\btest\s*\(\s*(["'`])((?:[^"'`\\]|\\.)*)\1/)) {
    const title = hit.match[2];
    const ok = stream === "ui"
      ? TITLE_SUBJECT_SHOULD.test(title) || TITLE_AS_A_ROLE.test(title)
      : TITLE_SUBJECT_SHOULD.test(title);
    if (!ok) {
      const forms = stream === "ui"
        ? '"<Subject> - Should <behavior>" or "As a <role>, I should …"'
        : '"<Subject> - Should <behavior>"';
      fail("SL-E06", path, hit.line, `test title ${JSON.stringify(title)} follows neither accepted form — ${forms}`);
    }
  }
}

// SL-E07 — exactly one // Arrange, // Act and // Assert per test. tests/**. Raw text by design.
for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);
  const testStarts = matchesInCode(file, /\btest\s*\(\s*["'`]/).map((hit) => hit.line);
  if (testStarts.length === 0) continue;
  const bounds = testStarts.map((start, index) => ({
    start,
    end: index + 1 < testStarts.length ? testStarts[index + 1] - 1 : file.rawLines.length,
  }));
  // A phase comment opens its own line. `expect(...).toBe(200); // Act gate` is a trailing note on
  // an assertion, not a second Act block, and counting it would fail every etalon-shaped test.
  //
  // `// Arrange & Act` counts once for each phase it names. It is the house form for a test with
  // nothing to arrange — `tests/api/admin-api.spec.ts` writes every unauthenticated call that way —
  // and a rule that failed it would push new code away from the specs it is told to match.
  const phases = matchesInRaw(file, /^\s*\/\/\s*(Arrange|Act|Assert)\b/);
  for (const { start, end } of bounds) {
    const inThisTest = phases.filter((p) => p.line >= start && p.line <= end);
    for (const phase of ["Arrange", "Act", "Assert"]) {
      const re = new RegExp(`^\\s*//[^\\n]*\\b${phase}\\b`);
      const count = inThisTest.filter((p) => re.test(file.rawLines[p.line - 1])).length;
      if (count === 0) fail("SL-E07", path, start, `the test starting here has no // ${phase} comment`);
      if (count > 1) fail("SL-E07", path, start, `the test starting here has ${count} // ${phase} comments — one test has one of each, and two // Act blocks are two scenarios`);
    }
  }
}

// SL-E08 — a scenario id above every test. tests/**. Raw text by design.
for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /\btest\s*\(\s*["'`]/)) {
    // The id sits on its own line above the call, allowing the blank line and the decorators
    // between them that prettier produces.
    let found = false;
    for (let line = hit.line - 1; line >= Math.max(1, hit.line - 4); line -= 1) {
      if (/^\s*\/\/\s*SCN-\d+/.test(file.rawLines[line - 1])) { found = true; break; }
    }
    if (!found) fail("SL-E08", path, hit.line, "no // SCN-NNN comment above the test — the scenario id is the whole of its traceability");
  }
}

// SL-E09 — the builder is not a UI stream's instrument. tests/ui/**.
if (stream === "ui") {
  for (const path of scanned.filter(isSpec)) {
    const file = files.get(path);
    for (const hit of matchesInCode(file, /\.with[A-Z]\w*\s*\(/)) {
      fail("SL-E09", path, hit.line, `${hit.match[0].trim()} — an API call in a UI spec is a helper, never the subject: take the controller method with a createAdminPayload() body. A scenario needing a hand-shaped request is an API scenario`);
    }
  }
}

// SL-E10 — the two e-mail streams never cross, and no e-mail literal survives normalizeEmail().
for (const path of scanned.filter((p) => isSpec(p) || isPage(p))) {
  const file = files.get(path);
  const wrongHelper = stream === "api" ? "uniqueUiEmail" : "uniqueApiEmail";
  const rightHelper = stream === "api" ? "uniqueApiEmail" : "uniqueUiEmail";
  for (const hit of matchesInCode(file, new RegExp(`\\b${wrongHelper}\\s*\\(`))) {
    fail("SL-E10", path, hit.line, `${wrongHelper}() in a ${stream} spec — use ${rightHelper}(), whose prefix is what keeps the two streams from colliding`);
  }
  for (const hit of matchesInCode(file, /["'`]([A-Za-z0-9_.+-]+)@([A-Za-z0-9-]+\.[A-Za-z0-9.-]+)["'`]/)) {
    const local = hit.match[1];
    if (/[.+]/.test(local)) {
      fail("SL-E10", path, hit.line, `the e-mail literal "${hit.match[0].slice(1, -1)}" carries a dot or a plus in its local part — the server runs normalizeEmail() on create, so the record is stored under a different address and cleanup never finds it`);
    } else {
      fail("SL-E10", path, hit.line, `the e-mail literal "${hit.match[0].slice(1, -1)}" is shared between runs — AdminTestData.${rightHelper}() is the only source of an address`);
    }
  }
}

// SL-E11 — every tier drop is recorded, and every recorded gap is a real one. pages/**, --report.
if (!reportPath) {
  skipped.push("SL-E11 — no --report given, so a LOCATOR-FALLBACK comment has nothing to be cross-checked against");
} else if (stream !== "ui") {
  skipped.push("SL-E11 — the API stream commits no locators");
} else {
  const report = readFileSync(resolve(root, reportPath), "utf8");
  const gapText = (report.match(/^locator_gaps:\s*(.*)$/m)?.[1] ?? "").toLowerCase();
  // The report writes its sections as `## Explored Locators` and its routes as `### /owner`, so the
  // split takes headings of level 1 and 2 only — splitting deeper would cut the section off above
  // the very table this rule reads.
  const exploredSection = report.split(/^#{1,2}\s+/m).find((s) => s.startsWith("Explored Locators")) ?? "";
  const exploredText = exploredSection.toLowerCase();

  /** The identifier a fallback comment is attached to: the next `this.<name> =` line below it. */
  const fallbacks = [];
  for (const path of scanned.filter(isPage)) {
    const file = files.get(path);
    file.rawLines.forEach((text, index) => {
      const marker = /\/\/\s*LOCATOR-FALLBACK:\s*tier\s*(\d)/i.exec(text);
      if (!marker) return;
      let field = null;
      for (let line = index + 1; line < Math.min(file.rawLines.length, index + 6); line += 1) {
        const assigned = /this\.(\w+)\s*=/.exec(file.rawLines[line]);
        if (assigned) { field = assigned[1]; break; }
      }
      fallbacks.push({ path, line: index + 1, tier: marker[1], field });
    });
  }

  for (const fallback of fallbacks) {
    if (!fallback.field) {
      fail("SL-E11", fallback.path, fallback.line, "a LOCATOR-FALLBACK comment attached to no locator field — it must sit directly above the `this.<field> =` line it justifies");
      continue;
    }
    const name = fallback.field.toLowerCase();
    if (!gapText.includes(name) && !exploredText.includes(name)) {
      fail("SL-E11", fallback.path, fallback.line, `the tier-${fallback.tier} fallback on \`${fallback.field}\` appears in neither the report's \`locator_gaps\` nor its Explored Locators map — a tier drop costs three receipts and this one has produced two`);
    }
  }

  // And the inverse: a map row claiming a tier drop that no page object carries.
  const rows = exploredSection.split(/\r?\n/).filter((l) => /^\s*\|/.test(l) && !/^\s*\|[\s|:-]*\|?\s*$/.test(l));
  const header = rows[0] ?? "";
  const columns = header.split("|").map((c) => c.trim().toLowerCase());
  const tierColumn = columns.findIndex((c) => c === "tier");
  if (tierColumn >= 0) {
    for (const row of rows.slice(1)) {
      const cells = row.split("|").map((c) => c.trim());
      const tier = cells[tierColumn] ?? "";
      if (!/^[2-4]$/.test(tier)) continue;
      const subject = (cells.find((c, i) => i > 0 && i !== tierColumn && c) ?? "").toLowerCase();
      const matched = fallbacks.some((f) => f.field && subject.includes(f.field.toLowerCase()));
      if (!matched) {
        fail("SL-E11", reportPath, null, `Explored Locators records a tier-${tier} locator for "${cells[1] ?? subject}" and no page object carries a LOCATOR-FALLBACK comment for it — the map and the code disagree about what was settled for`);
      }
    }
  } else if (exploredSection && !/^\s*-\s*None\./m.test(exploredSection)) {
    fail("SL-E11", reportPath, null, "the Explored Locators map has no Tier column — the tier is the only downstream evidence that a higher one was checked");
  }
}

// SL-E12 — the shapes outside the tier ladder entirely. pages/**.
for (const path of scanned.filter(isPage)) {
  const file = files.get(path);
  for (const hit of matchesInCode(file, /xpath\s*=/)) {
    fail("SL-E12", path, hit.line, "an XPath selector — outside the tier ladder entirely, never a tier-4 fallback");
  }
  for (const hit of matchesInCode(file, /\.(css-|[\w-]*css-)[a-z0-9]{4,}/)) {
    fail("SL-E12", path, hit.line, `${hit.match[0]} — a generated class name changes on the next build, so it is outside the ladder rather than the bottom of it`);
  }
  for (const hit of matchesInCode(file, /\bpage\.\$\$?\s*\(/)) {
    fail("SL-E12", path, hit.line, "page.$ / page.$$ — the ElementHandle API has no auto-waiting; use a Locator");
  }
  for (const hit of matchesInCode(file, /(\w+|\)|\])\s*\.\s*nth\s*\(/g)) {
    // What the nth() is anchored to decides it: a structural anchor is tier 1, a data row is not.
    const before = hit.full.slice(0, hit.match.index + hit.match[0].length);
    const anchor = [...before.matchAll(/getByRole\(\s*["'`](\w+)["'`]/g)].pop()?.[1];
    const anchoredStructurally = anchor && STRUCTURAL_NTH_ANCHORS.includes(anchor);
    if (!anchoredStructurally) {
      fail("SL-E12", path, hit.line, `nth() on a non-structural element — its position depends on which other tests are running in parallel. A structural nth() (${STRUCTURAL_NTH_ANCHORS.join(", ")}) is tier 1 and needs no receipt`);
    }
  }
}

// SL-E13 — the change set stays inside the stream's write boundary.
if (changed.length === 0) {
  skipped.push("SL-E13 — no --changed given, so there is no change set to rule on");
} else {
  const boundary = WRITE_BOUNDARY[stream];
  for (const path of changed.map(toPosix)) {
    if (!boundary.some((prefix) => (prefix.endsWith("/") ? path.startsWith(prefix) : path === prefix))) {
      fail("SL-E13", path, null, `outside the ${stream} stream's write boundary (${boundary.join(", ")}) — the other stream runs in parallel and owns the rest`);
    }
  }
}

// SL-E14 — no credential literal in a spec. tests/**.
for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);
  // A template literal that interpolates something is derived, not declared here:
  // `` `${AdminTestData.DEFAULT_PASSWORD}x` `` is how a mismatched confirmation is written, and
  // the value it is built from still lives in the test-data class.
  const isDerived = (quote, body) => quote === "`" && body.includes("${");

  for (const hit of matchesInCode(file, /\b(password|passwd|pwd|token|secret|apikey|api_key)\w*\s*[:=]\s*(["'`])((?:[^"'`\\]|\\.){3,})\2/i)) {
    if (isDerived(hit.match[2], hit.match[3])) continue;
    fail("SL-E14", path, hit.line, `a credential literal (${hit.match[1]}) — read Config from @framework/configuration/config, or take the value from AdminTestData / AuthTestData`);
  }
  for (const hit of matchesInCode(file, /\.with(Password|ConfirmPassword|BearerToken|MatchingPassword)\s*\(\s*(["'`])((?:[^"'`\\]|\\.){3,})\2/)) {
    if (isDerived(hit.match[2], hit.match[3])) continue;
    fail("SL-E14", path, hit.line, `a credential literal passed to with${hit.match[1]}() — take the value from AdminTestData or AuthTestData, never a string in the spec`);
  }
}

// SL-E15 — a snapshot ref never reaches committed code. tests/** and pages/**.
for (const path of scanned.filter((p) => isSpec(p) || isPage(p))) {
  const file = files.get(path);
  // `\be\d+\b` and not `\w*e\d+`: `1e5` is a number, and its `e` is not on a word boundary.
  for (const hit of matchesInCode(file, /\be\d+\b/)) {
    fail("SL-E15", path, hit.line, `${hit.match[0]} looks like an exploration snapshot ref — those are conversation handles for one browser session and mean nothing to the next run`);
  }
}

// --- judgement required, never a violation ---------------------------------
//
// Each of these finds a shape the reviewer has to look at. The verdict is in the surrounding code,
// so the script reports where to look and stops there.

for (const path of scanned.filter(isSpec)) {
  const file = files.get(path);

  // SL-W01 — a negative assertion passes on a locator that resolves to nothing at all, so it means
  // something only when the same test asserted that locator present first.
  for (const hit of matchesInCode(file, /\.(toBeHidden|toHaveCount\s*\(\s*0\s*\))|not\s*\.\s*toBeVisible/)) {
    judge("SL-W01", path, hit.line, "a negative assertion — check the same test asserts this locator present earlier, or a misspelled name goes green having verified nothing");
  }

  // SL-W02 — soft is right over independent observables in `// Assert` and wrong on a precondition,
  // on the Act gate, on a value a later line reads, or on the presence half of a pairing.
  for (const hit of matchesInCode(file, /\bexpect\s*\.\s*soft\b/)) {
    judge("SL-W02", path, hit.line, "expect.soft — check it sits in // Assert over independent observables, not on a precondition, an Act gate, or a value a later line reads");
  }

  // SL-W03 — an existence check is a defect as the only assertion on a named value, and correct as
  // a vacuity guard immediately before a loop that carries the real ones.
  for (const hit of matchesInCode(file, /\.(toBeGreaterThan\s*\(\s*0\s*\)|toBeTruthy\s*\(\s*\))|not\s*\.\s*(toBeNull|toBeUndefined)\s*\(\s*\)/)) {
    judge("SL-W03", path, hit.line, "an existence-only assertion — check the scenario names no fixed value here, or that this guards a loop that carries the real assertions");
  }

  // SL-W04 — a spec's module scope holds its imports and its `test.describe`. A helper that only
  // reads a response is the one blessed exception; one that produces test data is not.
  file.codeLines.forEach((text, index) => {
    if (/^(export\s+)?(const|let|var|function|class)\s/.test(text)) {
      judge("SL-W04", path, index + 1, "a declaration at a spec's module scope — a helper that drives or reads the page is a page-object method, and one that produces a value the test sends belongs in utils/test-data/");
    }
  });
}

// --- report ----------------------------------------------------------------

const byCodeThenPlace = (a, b) =>
  a.code.localeCompare(b.code) ||
  String(a.subject).localeCompare(String(b.subject)) ||
  (a.line ?? 0) - (b.line ?? 0);
violations.sort(byCodeThenPlace);
warnings.sort(byCodeThenPlace);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ stream, scanned, report: reportPath, violations, warnings, skipped }, null, 2)}\n`,
  );
  process.exit(violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATIONS);
}

const width = Math.max(
  0,
  ...[...violations, ...warnings].map((v) => `${v.subject}:${v.line ?? ""}`.length),
);
const render = (v) => {
  const where = `${v.subject}${v.line ? `:${v.line}` : ""}`;
  return `${where.padEnd(width)}  [${v.code}]  ${v.message}\n`;
};

if (violations.length === 0) {
  process.stdout.write(`SPEC-LINT: clean — ${scanned.length} file(s) scanned, 0 violations\n`);
} else {
  for (const v of violations) process.stdout.write(render(v));
  process.stdout.write(`\nSPEC-LINT: ${violations.length} violation(s) across ${scanned.length} file(s)\n`);
}

if (warnings.length > 0) {
  process.stdout.write("\nJudgement required (not violations):\n");
  for (const w of warnings) process.stdout.write(render(w));
}

if (skipped.length > 0) {
  process.stdout.write("\nSkipped:\n");
  for (const s of skipped) process.stdout.write(`  ${s}\n`);
}

process.exit(violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATIONS);
