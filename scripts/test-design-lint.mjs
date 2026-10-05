#!/usr/bin/env node
/**
 * test-design-lint.mjs — deterministic structural checks over one test design document.
 *
 * The test design is a machine contract: later readers edit single lines in it and grep it for
 * exact field values. Most of what that contract asks for is a count, a set-membership test or a
 * cross-reference — work a model does slowly, in-context and unreliably. This script does it
 * instead, so the scenario-writing side spends its self-check on judgement and the reviewing side
 * spends its tokens on the same.
 *
 * Usage:
 *   node scripts/test-design-lint.mjs <test-design-path> [--requirements <path>]
 *                                     [--emit-summary] [--emit-levels]
 *                                     [--apply-summary] [--apply-levels]
 *                                     [--implemented-levels <list>] [--json]
 *
 * Options:
 *   --requirements  the requirements document the design claims to cover. Without it, checks that
 *                   need the FR/AC list (TD-E13) are reported as skipped rather than passed.
 *   --emit-summary  print a recomputed `# Summary` block and the three matrices to stdout, in
 *                   document form, and exit 0. Nothing is written to any file.
 *   --emit-levels   print a recomputed `Levels:` line and `# Level Assignment Summary` section to
 *                   stdout, in document form, and exit 0. Same contract as --emit-summary.
 *   --apply-summary write what --emit-summary prints into the document, in place: `# Summary` and
 *                   the three matrix sections, and nothing else. Prints one line per section
 *                   changed and exits 0. Idempotent — a second run reports no change.
 *   --apply-all     run --apply-summary and then --apply-levels over the same document, as two
 *                   passes. It is two passes rather than one because the summary rewrite changes how
 *                   many lines sit above every later section, so a single parse would splice the
 *                   level section at a line number that had already moved. Output and exit code are
 *                   the second pass's; a failing first pass stops the run.
 *   --apply-levels  write what --emit-levels prints into the document, in place: the `Levels:` line
 *                   of `# Summary` and the whole `# Level Assignment Summary` section, appending
 *                   that section when it does not exist yet. An unclassified design is left
 *                   untouched, matching TD-E19's skip rather than inventing arithmetic.
 *   --implemented-levels
 *                   the levels this repository automates, comma-separated. Only affects which
 *                   scenarios --emit-levels / --apply-levels list as handed-off follow-up work.
 *                   Defaults to "E2E API,E2E UI".
 *   --json          emit the violations as JSON instead of one line each.
 *
 * The four modes above are mutually exclusive — one document rewrite per invocation, so a run that
 * changed the file is always the run whose flag says it would.
 *
 * Exit codes:
 *   0  clean (or an --emit-* / --apply-* mode succeeded)
 *   1  violations found
 *   2  usage error
 *   3  the document is missing or could not be parsed (an --apply-* run writes nothing at all)
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE. It never rules on whether a partition is sound, whether two
 * scenarios contradict each other, whether a testing level is right, whether an `inferred:` basis
 * is really an inference, or whether an `Expected:` outcome is the one the requirements describe.
 * Those are judgement, they are why the reviewing side of this workflow runs on a larger model,
 * and a clean run of this script is never evidence that they were made well.
 *
 * LEVEL, AUTOMATION READINESS AND TEST PACKAGING ARE THREE QUESTIONS. `Assigned Level:` names the
 * lowest technical layer at which a scenario has an assertable, truthful oracle; `Automation
 * Suitability:` says whether that test can be automated now; `Folds Into:` says which test executes
 * it. None is evidence about the others — `Manual only` is permitted at every level, and a folded
 * scenario keeps the level its oracle needs. `TD-E21` enforces the third and reads neither of the
 * first two as a reason to fold or not to fold.
 *
 * A FOLD IS NOT A DEMOTION AND NOT A MERGE. The minimum-set pass demotes a scenario whose assertion
 * survives one level down; it folds one whose assertion needs the real stack but whose traversal is
 * already made by another E2E scenario on the same journey — the shape equivalence partitioning and
 * boundary value analysis produce by construction, one traversal and N data partitions over it. The
 * folded scenario keeps its id, its level, its requirement trace and its coverage items, and its
 * `Expected:` is asserted inside the covering scenario's test. Nothing is reworded, renumbered or
 * deleted, so no traceability is lost — only the second traversal is. `TD-E10`, which failed a below-E2E
 * level paired with `Manual only`, is retired and its code is not reused.
 *
 * A scenario whose `Expected:` records a requirement gap, an unknown or an outcome that is not
 * assertable takes `Assigned Level: Requirement Gap` — a pseudo-level, never a test layer. It is
 * counted in its own row, excluded from every E2E figure and from the follow-up-work table, and
 * listed under `## Blocked / Requirement Gaps` instead. It is the whole value of the field or none of
 * it: `Component, Requirement Gap` is a TD-E04 violation.
 *
 * TRACED IS NOT EXERCISED. A scenario carrying an `unknown:` marker with
 * `Automation Suitability: Manual only` has had its outcome taken away by the unknown — it traces a
 * requirement, but it asserts nothing. Its `Coverage Item:` citations are counted as *traced-only*
 * rather than exercised, in the technique matrix and in `# Summary`, so a design cannot report 100%
 * technique coverage on the strength of scenarios that assert nothing. An item cited by a
 * gap-blocked block and an ordinary one is exercised; an item cited only by gap-blocked blocks is
 * traced-only; TD-E06 treats it as covered either way, because it is still cited.
 *
 * TD-E07 in particular is a *literal* check: it catches an unknown value reaching `Expected:` when
 * that value is a status code, a quoted string, a route or a number. An unknown asserted as prose
 * carries no syntactic signal and cannot be caught here — TD-W01 lists every block carrying an
 * `unknown:` marker so that judgement pass has a short list to work from instead of the whole
 * document.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const EXIT_CLEAN = 0;
const EXIT_VIOLATIONS = 1;
const EXIT_USAGE = 2;
const EXIT_UNPARSEABLE = 3;

// --- the contract, as data -------------------------------------------------

const SECTION_ORDER = [
  "Summary",
  "Scenarios",
  "Traceability Matrix",
  "Coverage Matrix",
  "Technique Coverage Matrix",
  "Coverage Gaps",
  "Approved Assumptions",
  "Test Basis Research",
  "Test Basis Analysis",
];

/**
 * Sections read but deliberately outside the contract order above. The classification step appends
 * `# Level Assignment Summary` after the last contract section, so TD-E19 needs its lines while
 * TD-E01 must not count it as a contract section that is present, absent or misordered.
 */
const TRAILING_SECTIONS = ["Level Assignment Summary"];

/**
 * The named fields, in the order a block writes them. Counted with the `## SCN-NNN:` heading they
 * sit under, this is the "twelve fields" the block format calls for.
 *
 * `Suggested Level:` sits in this order and is **not required**. It was the writing step's proposal
 * back when a separate step finalised levels; the two are one step now, which writes
 * `Assigned Level:` directly and has nothing to propose to itself. Documents from before the merge
 * still carry it, they are still valid, and where it is present it is still checked and still
 * reported as an override — so a design written either way lints the same.
 */
const FIELD_ORDER = [
  "Requirement",
  "Category",
  "Technique",
  "Coverage Item",
  "Priority",
  "Preconditions",
  "Action",
  "Expected",
  "Suggested Level",
  "Automation Suitability",
  "Notes",
];

/**
 * Written by the classification step, absent before it runs.
 *
 * `Folds Into:` is the third of them and answers a third question. `Assigned Level:` says where the
 * scenario's oracle is truthful; `Automation Suitability:` says whether it can be automated now;
 * `Folds Into:` says which *test* executes it. A scenario sharing a journey with another E2E scenario
 * and differing only by data partition or boundary value cannot be demoted — its `Expected:` still
 * needs the real stack — but it does not need a second traversal of the same routes either. It names
 * the covering scenario here and is implemented as extra data and extra assertions inside that one
 * test. The id, the level and the traceability all survive; only the second browser session does not.
 */
const OPTIONAL_FIELDS = ["Assigned Level", "Level Rationale", "Folds Into"];

/**
 * The fields TD-E02 requires. `Suggested Level:` keeps its slot in `FIELD_ORDER` — a document that
 * carries it must still carry it in the right place — but its absence is not a defect.
 */
const REQUIRED_FIELDS = FIELD_ORDER.filter((f) => f !== "Suggested Level");

const API_COVERAGE_DECISIONS = ["linked", "not_needed", "not_applicable"];
const API_COVERAGE_RE = /\bAPI coverage:\s*(linked\s+SCN-\d{3}|not needed|not applicable)(?:\s+[—-]\s*(.*))?/i;
const BACKEND_MECHANICS_RE =
  /\b(backend|server|request|response|HTTP|API|endpoint|status code|database|persist(?:ed|ence)?|session|signs? in|signed in|sign-in|login|auth(?:entication|orization)?)\b/i;
const UI_MECHANICS_RE = /\b(UI|browser|screen|page|panel|form|button|link|toast|modal|row|list|table|render(?:ed|s|ing)?)\b/i;

const CATEGORIES = [
  "Happy path",
  "Negative path",
  "Boundary",
  "Validation rules",
  "Error handling",
  "Permission / authorization",
  "Data",
  "Integration",
  "Retry / timeout",
  "State transition",
  "Non-functional",
  "Regression impact",
];

const TECHNIQUES = [
  "Equivalence Partitioning",
  "Boundary Value Analysis (2-value)",
  "Boundary Value Analysis (3-value)",
  "Decision Table Testing",
  "State Transition Testing",
  "Experience-based (error guessing)",
];

const EXPERIENCE_BASED = "Experience-based (error guessing)";
/**
 * The five real testing levels, ordered lowest first — `Assigned Level:` values are written in this
 * order. `Suggested Level:` and `--implemented-levels` take one of these and nothing else.
 */
const LEVELS = ["Unit", "Component", "Integration", "E2E API", "E2E UI"];
/**
 * A pseudo-level, not a test layer: the scenario's `Expected:` records a requirement gap, an unknown,
 * a missing oracle or an outcome that is not assertable, so there is no layer at which it is
 * executable coverage. It is counted separately, excluded from every E2E figure, and reported under
 * `## Blocked / Requirement Gaps` rather than as automation follow-up work.
 */
const REQUIREMENT_GAP = "Requirement Gap";
/** Values `Assigned Level:` accepts. The pseudo-level is only ever the whole value. */
const ASSIGNABLE_LEVELS = [...LEVELS, REQUIREMENT_GAP];
const DEFAULT_IMPLEMENTED_LEVELS = ["E2E API", "E2E UI"];
const SUITABILITY = ["High", "Medium", "Low", "Manual only"];
const PRIORITIES = ["High", "Medium", "Low"];
/** The two levels an E2E figure may count. `Requirement Gap` is never one of them. */
const E2E_LEVELS = ["E2E API", "E2E UI"];

/** The ten `# Test Basis Research` rows, in the order the contract fixes. */
const RESEARCH_ROWS = [
  "Actors & roles",
  "Entities & states",
  "Inputs",
  "Limits",
  "Oracles",
  "Permissions",
  "Dependencies",
  "Data lifetime",
  "Domain terms",
  "Unknowns",
];

/** Technique subsection heading -> the coverage-item prefix it declares. */
const TECHNIQUE_SUBSECTIONS = [
  { heading: /^Equivalence Partitions/, prefix: "EP", matrixName: "Equivalence Partitioning" },
  { heading: /^Boundary Values/, prefix: "BV", matrixName: "Boundary Value Analysis" },
  { heading: /^Decision Tables/, prefix: "DT", matrixName: "Decision Table Testing" },
  { heading: /^State Transitions/, prefix: "ST", matrixName: "State Transition Testing" },
];

const NOT_APPLICABLE = /^_Not applicable\s*[—-]/;
const NONE_STATED = /^[—-]\s*none stated$/i;

// --- arguments -------------------------------------------------------------

function usage(message) {
  if (message) process.stderr.write(`test-design-lint: ${message}\n`);
  process.stderr.write(
    "usage: node scripts/test-design-lint.mjs <test-design-path> " +
      "[--requirements <path>] [--emit-summary] [--emit-levels] [--emit-manifest] " +
      "[--apply-summary] [--apply-levels] [--apply-all] [--implemented-levels <list>] [--json]\n",
  );
  process.exit(EXIT_USAGE);
}

const argv = process.argv.slice(2);
let designPath = null;
let requirementsPath = null;
let emitSummary = false;
let emitLevels = false;
let emitManifest = false;
let applySummary = false;
let applyLevels = false;
let applyAll = false;
let implementedLevels = DEFAULT_IMPLEMENTED_LEVELS;
let asJson = false;

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === "--requirements") {
    requirementsPath = argv[++i] ?? null;
    if (!requirementsPath) usage("--requirements needs a path");
  } else if (arg === "--emit-summary") {
    emitSummary = true;
  } else if (arg === "--emit-levels") {
    emitLevels = true;
  } else if (arg === "--emit-manifest") {
    emitManifest = true;
  } else if (arg === "--apply-summary") {
    applySummary = true;
  } else if (arg === "--apply-levels") {
    applyLevels = true;
  } else if (arg === "--apply-all") {
    applyAll = true;
  } else if (arg === "--implemented-levels") {
    const value = argv[++i] ?? null;
    if (!value) usage("--implemented-levels needs a comma-separated list of levels");
    implementedLevels = value.split(",").map((l) => l.trim()).filter(Boolean);
    if (implementedLevels.length === 0) usage("--implemented-levels needs at least one level");
    for (const level of implementedLevels) {
      if (!LEVELS.includes(level)) usage(`--implemented-levels: "${level}" is not a permitted level`);
    }
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg.startsWith("--")) {
    usage(`unknown option ${arg}`);
  } else if (designPath === null) {
    designPath = arg;
  } else {
    usage("more than one test design path given");
  }
}

{
  // One document rewrite per invocation. Two of these at once would leave the caller unable to say
  // which pass produced the file it is looking at, and `--emit-*` beside `--apply-*` asks for the
  // same section twice in two different forms.
  const modes = [
    ["--emit-summary", emitSummary],
    ["--emit-levels", emitLevels],
    ["--emit-manifest", emitManifest],
    ["--apply-summary", applySummary],
    ["--apply-levels", applyLevels],
    ["--apply-all", applyAll],
  ].filter(([, on]) => on);
  if (modes.length > 1) usage(`${modes.map(([name]) => name).join(" and ")} are mutually exclusive`);
}

if (!designPath) usage("no test design path given");

// `--apply-all` is two passes over the same file, not one pass doing two things. Each apply mode
// splices by line number into a parse taken at startup, and rewriting `# Summary` moves every line
// below it — including the `# Level Assignment Summary` section the second pass edits. Re-running
// the whole script between them is what re-parses, and it makes the combined mode exactly the two
// commands it replaces rather than a third code path to keep in step with them.
if (applyAll) {
  const passArgs = argv.filter((a) => a !== "--apply-all");
  for (const mode of ["--apply-summary", "--apply-levels"]) {
    const pass = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...passArgs, mode], {
      encoding: "utf8",
    });
    if (pass.error) {
      process.stderr.write(`test-design-lint: could not run ${mode}: ${pass.error.message}\n`);
      process.exit(EXIT_UNPARSEABLE);
    }
    if (pass.stdout) process.stdout.write(pass.stdout);
    if (pass.stderr) process.stderr.write(pass.stderr);
    if (pass.status !== EXIT_CLEAN) process.exit(pass.status ?? EXIT_UNPARSEABLE);
  }
  process.exit(EXIT_CLEAN);
}
if (!existsSync(designPath)) {
  process.stderr.write(`test-design-lint: ${designPath} does not exist\n`);
  process.exit(EXIT_UNPARSEABLE);
}

// --- violations ------------------------------------------------------------

const violations = [];
const warnings = [];
const skipped = [];

function fail(subject, code, message, line = null) {
  violations.push({ subject, code, message, line });
}

function warn(subject, code, message, line = null) {
  warnings.push({ subject, code, message, line });
}

// --- parsing ---------------------------------------------------------------

function splitLines(text) {
  return text.split(/\r?\n/);
}

/** Table rows of a markdown table: cells trimmed, header and separator rows excluded. */
function tableRows(lines) {
  const rows = [];
  for (const { text, line } of lines) {
    const trimmed = text.trim();
    if (!trimmed.startsWith("|")) continue;
    if (/^\|[\s:|-]+\|$/.test(trimmed)) continue; // separator
    const cells = trimmed
      .slice(1, trimmed.endsWith("|") ? -1 : undefined)
      .split("|")
      .map((c) => c.trim());
    rows.push({ cells, line });
  }
  return rows;
}

function parseDesign(text) {
  const raw = splitLines(text);
  const doc = {
    frontMatter: null,
    frontMatterLines: [],
    title: null,
    titleLine: null,
    sections: new Map(), // name -> { line, lines: [{text, line}] }
    sectionOrder: [], // every level-1 heading seen, in file order
    blocks: [],
  };

  let i = 0;

  // front matter
  if (raw[0] !== undefined && raw[0].trim() === "---") {
    let end = -1;
    for (let j = 1; j < raw.length; j += 1) {
      if (raw[j].trim() === "---") {
        end = j;
        break;
      }
    }
    if (end > 0) {
      doc.frontMatter = {};
      for (let j = 1; j < end; j += 1) {
        doc.frontMatterLines.push({ text: raw[j], line: j + 1 });
        const m = raw[j].match(/^([a-z_]+):\s*(.*)$/);
        if (m) doc.frontMatter[m[1]] = m[2].trim();
      }
      i = end + 1;
    }
  }

  let current = null;
  for (; i < raw.length; i += 1) {
    const text = raw[i];
    const line = i + 1;
    const h1 = text.match(/^# (.+?)\s*$/);
    if (h1) {
      const name = h1[1];
      doc.sectionOrder.push({ name, line });
      if (SECTION_ORDER.includes(name) || TRAILING_SECTIONS.includes(name)) {
        current = { line, lines: [] };
        doc.sections.set(name, current);
      } else if (doc.title === null) {
        doc.title = name;
        doc.titleLine = line;
        current = null;
      } else {
        current = null;
      }
      continue;
    }
    if (current) current.lines.push({ text, line });
  }

  // scenario blocks, from the Scenarios section
  const scenarios = doc.sections.get("Scenarios");
  if (scenarios) {
    let block = null;
    for (const { text, line } of scenarios.lines) {
      const h2 = text.match(/^## (SCN-\S*)\s*:\s*(.*)$/);
      if (h2) {
        block = { id: h2[1], title: h2[2].trim(), line, fields: [], body: [] };
        doc.blocks.push(block);
        continue;
      }
      if (/^##? /.test(text)) {
        block = null;
        continue;
      }
      if (!block) continue;
      block.body.push({ text, line });
      const f = text.match(/^([A-Z][A-Za-z ]*?):\s?(.*)$/);
      if (f) block.fields.push({ name: f[1], value: f[2].trim(), line });
    }
  }

  return doc;
}

/** Coverage-item ids declared by `# Test Basis Analysis`, keyed by prefix. */
function parseAnalysis(doc) {
  const declared = { EP: [], BV: [], DT: [], ST: [] };
  const present = { EP: false, BV: false, DT: false, ST: false };
  const notApplicable = { EP: false, BV: false, DT: false, ST: false };

  const analysis = doc.sections.get("Test Basis Analysis");
  if (!analysis) return { declared, present, notApplicable };

  let active = null;
  let dtTable = null;
  for (const { text, line } of analysis.lines) {
    const h2 = text.match(/^## (.+?)\s*$/);
    if (h2) {
      active = TECHNIQUE_SUBSECTIONS.find((s) => s.heading.test(h2[1])) ?? null;
      if (active) present[active.prefix] = true;
      dtTable = null;
      continue;
    }
    if (!active) continue;
    if (NOT_APPLICABLE.test(text.trim())) {
      notApplicable[active.prefix] = true;
      continue;
    }

    if (active.prefix === "EP" || active.prefix === "BV") {
      const m = text.match(/^\|\s*(EP|BV)-(\d+)\s*\|/);
      if (m) declared[active.prefix].push({ id: `${m[1]}-${m[2]}`, line });
      continue;
    }

    if (active.prefix === "DT") {
      const h3 = text.match(/^### (DT-\d+)\s*:/);
      if (h3) {
        dtTable = h3[1];
        continue;
      }
      // Rule ids come from the condition table's own column headers, not from prose.
      if (dtTable && /^\|\s*Condition\s*\/\s*Action\s*\|/i.test(text)) {
        const cells = text
          .trim()
          .replace(/^\||\|$/g, "")
          .split("|")
          .map((c) => c.trim());
        for (const cell of cells.slice(1)) {
          const r = cell.match(/^R(\d+)$/);
          if (r) declared.DT.push({ id: `${dtTable}/R${r[1]}`, line });
        }
      }
      continue;
    }

    if (active.prefix === "ST") {
      const h3 = text.match(/^### (ST-\d+)\s*:/);
      if (h3) {
        dtTable = h3[1];
        continue;
      }
      if (dtTable && text.trim().startsWith("|")) {
        for (const m of text.matchAll(/\(T(\d+)\)/g)) {
          const id = `${dtTable}/T${m[1]}`;
          if (!declared.ST.some((d) => d.id === id)) declared.ST.push({ id, line });
        }
      }
    }
  }

  return { declared, present, notApplicable };
}

/** Coverage-item ids cited by a `Coverage Item:` value. */
function citedItems(value) {
  const ids = [];
  for (const m of value.matchAll(/\b((?:EP|BV)-\d+|(?:DT|ST)-\d+\/[RT]\d+)\b/g)) ids.push(m[1]);
  return ids;
}

function fieldOf(block, name) {
  return block.fields.find((f) => f.name === name) ?? null;
}

function valueOf(block, name) {
  return fieldOf(block, name)?.value ?? null;
}

function blockText(block) {
  return block.body.map((l) => l.text).join("\n");
}

function apiCoverageDecisionOf(block) {
  const notes = valueOf(block, "Notes") ?? "";
  const match = notes.match(API_COVERAGE_RE);
  if (!match) return null;
  const raw = match[1].toLowerCase();
  const kind = raw.startsWith("linked") ? "linked" : raw.replace(/\s+/g, "_");
  return {
    kind,
    linked_scenario: raw.startsWith("linked") ? raw.match(/scn-\d{3}/i)?.[0].toUpperCase() ?? null : null,
    reason: (match[2] ?? "").trim(),
  };
}

function isUiScenario(block) {
  const suggested = valueOf(block, "Suggested Level");
  const assigned = valueOf(block, "Assigned Level") ?? "";
  return suggested === "E2E UI" || assigned.split(",").map((s) => s.trim()).includes("E2E UI");
}

function isBackendBackedUiScenario(block) {
  const levels = [valueOf(block, "Suggested Level"), ...(valueOf(block, "Assigned Level") ?? "").split(",")].map((s) =>
    (s ?? "").trim(),
  );
  if (levels.includes("E2E API")) return false;
  return isUiScenario(block) && BACKEND_MECHANICS_RE.test(blockText(block));
}

function sectionText(doc, name) {
  const s = doc.sections.get(name);
  if (!s) return "";
  return s.lines.map((l) => l.text).join("\n");
}

// --- read the documents ----------------------------------------------------

let designText;
try {
  designText = readFileSync(designPath, "utf8");
} catch (err) {
  process.stderr.write(`test-design-lint: cannot read ${designPath}: ${err.message}\n`);
  process.exit(EXIT_UNPARSEABLE);
}

const doc = parseDesign(designText);
if (doc.blocks.length === 0 && !doc.sections.has("Scenarios")) {
  process.stderr.write(
    `test-design-lint: ${designPath} has no '# Scenarios' section — not a test design document\n`,
  );
  process.exit(EXIT_UNPARSEABLE);
}

let requirementIds = null;
if (requirementsPath) {
  if (!existsSync(requirementsPath)) {
    process.stderr.write(`test-design-lint: ${requirementsPath} does not exist\n`);
    process.exit(EXIT_UNPARSEABLE);
  }
  const reqText = readFileSync(requirementsPath, "utf8");
  requirementIds = [];
  for (const m of reqText.matchAll(/^### ((?:FR-\d+\.\d+)|(?:AC-\d+))\b/gm)) {
    if (!requirementIds.includes(m[1])) requirementIds.push(m[1]);
  }
} else {
  skipped.push("TD-E13 (requirement id cross-check): no --requirements path given");
}

const analysis = parseAnalysis(doc);
const gapsText = sectionText(doc, "Coverage Gaps");

// --- derived facts, computed once and reused by the checks and --emit-summary

const blocks = doc.blocks;
const blockCount = blocks.length;
const manualOnly = blocks.filter((b) => valueOf(b, "Automation Suitability") === "Manual only");
const automatable = blockCount - manualOnly.length;

/** requirement id -> scenario ids citing it, in block order. */
const coverageByRequirement = new Map();
for (const block of blocks) {
  const value = valueOf(block, "Requirement") ?? "";
  for (const m of value.matchAll(/\b((?:FR-\d+\.\d+)|(?:AC-\d+))\b/g)) {
    if (!coverageByRequirement.has(m[1])) coverageByRequirement.set(m[1], []);
    const list = coverageByRequirement.get(m[1]);
    if (!list.includes(block.id)) list.push(block.id);
  }
}

/** category -> scenario ids, in block order. */
const coverageByCategory = new Map();
for (const block of blocks) {
  const value = valueOf(block, "Category");
  if (!value) continue;
  if (!coverageByCategory.has(value)) coverageByCategory.set(value, []);
  coverageByCategory.get(value).push(block.id);
}

/**
 * Blocks whose outcome an unknown took away: an `unknown:` marker in `Notes:` together with
 * `Automation Suitability: Manual only` is the document's own way of saying the scenario asserts
 * nothing. They trace a requirement; they do not exercise a coverage item.
 */
const gapBlockedBlocks = blocks.filter(
  (b) => /unknown:/i.test(valueOf(b, "Notes") ?? "") && valueOf(b, "Automation Suitability") === "Manual only",
);
const gapBlockedIds = new Set(gapBlockedBlocks.map((b) => b.id));

/** every coverage-item id a block that actually asserts something cites. */
const exercisedItems = new Set();
/** every coverage-item id any block cites at all, gap-blocked or not. */
const citedAnywhere = new Set();
for (const block of blocks) {
  for (const id of citedItems(valueOf(block, "Coverage Item") ?? "")) {
    citedAnywhere.add(id);
    if (!gapBlockedIds.has(block.id)) exercisedItems.add(id);
  }
}
/** cited only by gap-blocked blocks: traced, never asserted. */
const tracedOnlyItems = new Set([...citedAnywhere].filter((id) => !exercisedItems.has(id)));

/** per-technique recount: declared, exercised, traced-only, uncovered. */
const techniqueCounts = TECHNIQUE_SUBSECTIONS.map((s) => {
  const declared = analysis.declared[s.prefix].map((d) => d.id);
  const exercised = declared.filter((id) => exercisedItems.has(id));
  const tracedOnly = declared.filter((id) => tracedOnlyItems.has(id));
  const uncovered = declared.filter((id) => !citedAnywhere.has(id));
  return {
    prefix: s.prefix,
    matrixName: s.matrixName,
    items: declared.length,
    exercised: exercised.length,
    tracedOnly: tracedOnly.length,
    tracedOnlyIds: tracedOnly,
    uncovered,
    percent: declared.length === 0 ? null : Math.round((exercised.length / declared.length) * 100),
  };
});

const techniqueByPrefix = new Map(techniqueCounts.map((t) => [t.prefix, t]));

// --- level assignment, the classification step's arithmetic -----------------

/** The levels one block is assigned to. `[]` when the field is absent or empty. */
function assignedLevelsOf(block) {
  const value = valueOf(block, "Assigned Level");
  if (value === null) return [];
  return value
    .split(",")
    .map((l) => l.trim())
    .filter(Boolean);
}

const assignedBlocks = blocks.filter((b) => assignedLevelsOf(b).length > 0);
const unassignedBlocks = blocks.filter((b) => assignedLevelsOf(b).length === 0);
const anyAssignment = assignedBlocks.length > 0;

/** level -> scenario ids assigned to it, in block order. A multi-level block appears in each. */
const scenariosByLevel = new Map(ASSIGNABLE_LEVELS.map((l) => [l, []]));
for (const block of assignedBlocks) {
  for (const level of assignedLevelsOf(block)) {
    if (scenariosByLevel.has(level)) scenariosByLevel.get(level).push(block.id);
  }
}

/**
 * Blocks recording a requirement gap rather than a testing level. They are not executable coverage,
 * so nothing downstream may count them as a level this repository does or does not implement.
 */
const requirementGapBlocks = assignedBlocks.filter((b) => assignedLevelsOf(b).includes(REQUIREMENT_GAP));

/** Assigned blocks that carry a real testing level — the denominator of any E2E share. */
const executableBlocks = assignedBlocks.filter((b) => !assignedLevelsOf(b).includes(REQUIREMENT_GAP));

/** Blocks carrying more than one level. */
const multiLevelBlocks = assignedBlocks.filter((b) => assignedLevelsOf(b).length > 1);

/** Blocks whose assignment disagrees with what the writing step suggested. */
const overriddenBlocks = assignedBlocks.filter((b) => {
  const suggested = valueOf(b, "Suggested Level");
  if (suggested === null || suggested === "") return false;
  const levels = assignedLevelsOf(b);
  return !(levels.length === 1 && levels[0] === suggested);
});

/**
 * Blocks assigned only to levels this repository does not automate. A requirement gap is not such a
 * level — it is work with no level yet — so those blocks are excluded and reported on their own.
 */
const handedOffBlocks = executableBlocks.filter((b) =>
  assignedLevelsOf(b).every((l) => !implementedLevels.includes(l)),
);

/** The scenario id one block folds into, or `null` when it stands as its own test. */
function foldTargetOf(block) {
  const value = valueOf(block, "Folds Into");
  if (value === null || value.trim() === "" || value.trim() === "—") return null;
  return value.trim();
}

/** Blocks executed inside another scenario's test rather than as one of their own. */
const foldedBlocks = blocks.filter((b) => foldTargetOf(b) !== null);
/** covering scenario id -> the ids folded into it, in block order. */
const foldsByTarget = new Map();
for (const block of foldedBlocks) {
  const target = foldTargetOf(block);
  if (!foldsByTarget.has(target)) foldsByTarget.set(target, []);
  foldsByTarget.get(target).push(block.id);
}
const foldedIds = new Set(foldedBlocks.map((b) => b.id));

/**
 * How many tests each E2E level actually implies — the count the implementing steps select on, and
 * the only number here that is about tests rather than about scenarios. A folded scenario keeps its
 * level and is still counted in the level table; it just does not open a second browser to assert it.
 */
const e2eTestsImplied = Object.fromEntries(
  E2E_LEVELS.map((level) => [level, scenariosByLevel.get(level).filter((id) => !foldedIds.has(id)).length]),
);

/** The `Levels:` line of `# Summary`, lowest level first, zero counts omitted. */
function levelsLine() {
  if (!anyAssignment) return "Levels: _pending classification._";
  const parts = ASSIGNABLE_LEVELS.map((level) => ({ level, count: scenariosByLevel.get(level).length }))
    .filter((p) => p.count > 0)
    .map((p) => `${p.level} ${p.count}`);
  return `Levels: ${parts.join(", ")}`;
}

// --- TD-E01: section presence and order ------------------------------------

if (doc.frontMatter === null) fail("DOCUMENT", "TD-E01", "no YAML front matter at the top of the file", 1);
if (doc.title === null) fail("DOCUMENT", "TD-E01", "no `# Test Design — …` title heading");

{
  const seen = doc.sectionOrder.filter((s) => SECTION_ORDER.includes(s.name));
  for (const name of SECTION_ORDER) {
    if (!doc.sections.has(name)) fail("DOCUMENT", "TD-E01", `section \`# ${name}\` is missing`);
  }
  let previous = -1;
  for (const { name, line } of seen) {
    const index = SECTION_ORDER.indexOf(name);
    if (index < previous) {
      fail("DOCUMENT", "TD-E01", `section \`# ${name}\` is out of contract order`, line);
    }
    previous = Math.max(previous, index);
  }
  if (doc.titleLine !== null && doc.sections.has("Summary")) {
    if (doc.sections.get("Summary").line < doc.titleLine) {
      fail("DOCUMENT", "TD-E01", "`# Summary` appears before the title heading", doc.titleLine);
    }
  }
}

// --- per-block checks ------------------------------------------------------

for (const block of blocks) {
  const id = block.id;

  // TD-E02: the named fields, in order, one per line, no blank line between them.
  const names = block.fields.map((f) => f.name);
  for (const required of REQUIRED_FIELDS) {
    if (!names.includes(required)) fail(id, "TD-E02", `field \`${required}:\` is missing`, block.line);
  }
  {
    const ordered = names.filter((n) => FIELD_ORDER.includes(n));
    const expected = FIELD_ORDER.filter((n) => ordered.includes(n));
    if (ordered.join("|") !== expected.join("|")) {
      fail(id, "TD-E02", `fields are out of contract order: ${ordered.join(", ")}`, block.line);
    }
    for (const name of names) {
      if (!FIELD_ORDER.includes(name) && !OPTIONAL_FIELDS.includes(name)) {
        const f = block.fields.find((x) => x.name === name);
        fail(id, "TD-E02", `unknown field \`${name}:\``, f.line);
      }
    }
  }
  if (block.fields.length > 0) {
    const first = block.fields[0].line;
    const last = block.fields[block.fields.length - 1].line;
    for (const { text, line } of block.body) {
      if (line > first && line < last && text.trim() === "") {
        fail(id, "TD-E02", "blank line inside the block", line);
      }
    }
  }

  // TD-E04: enumerated field values.
  const category = valueOf(block, "Category");
  if (category !== null && !CATEGORIES.includes(category)) {
    fail(id, "TD-E04", `Category: "${category}" is not one of the twelve category names`, fieldOf(block, "Category").line);
  }
  const technique = valueOf(block, "Technique");
  if (technique !== null && !TECHNIQUES.includes(technique)) {
    fail(id, "TD-E04", `Technique: "${technique}" is not a permitted technique value`, fieldOf(block, "Technique").line);
  }
  const priority = valueOf(block, "Priority");
  if (priority !== null && !PRIORITIES.includes(priority)) {
    fail(id, "TD-E04", `Priority: "${priority}" is not High | Medium | Low`, fieldOf(block, "Priority").line);
  }
  const suggested = valueOf(block, "Suggested Level");
  if (suggested !== null && !LEVELS.includes(suggested)) {
    fail(id, "TD-E04", `Suggested Level: "${suggested}" is not a permitted level`, fieldOf(block, "Suggested Level").line);
  }
  const suitability = valueOf(block, "Automation Suitability");
  if (suitability !== null && !SUITABILITY.includes(suitability)) {
    fail(id, "TD-E04", `Automation Suitability: "${suitability}" is not High | Medium | Low | Manual only`, fieldOf(block, "Automation Suitability").line);
  }
  // `Assigned Level:` is the one multi-valued field: comma-separated, ordered lowest first. The
  // pseudo-level `Requirement Gap` is the exception — it stands alone or not at all.
  const assigned = valueOf(block, "Assigned Level");
  const assignedLevels = assignedLevelsOf(block);
  if (assigned !== null) {
    const assignedLine = fieldOf(block, "Assigned Level").line;
    if (assigned.trim() === "") {
      fail(id, "TD-E04", "Assigned Level: is empty", assignedLine);
    }
    for (const level of assignedLevels) {
      if (!ASSIGNABLE_LEVELS.includes(level)) {
        fail(id, "TD-E04", `Assigned Level: "${level}" is not a permitted level`, assignedLine);
      }
    }
    if (assignedLevels.includes(REQUIREMENT_GAP) && assignedLevels.length > 1) {
      // Reported once, and the ordering and duplicate checks below skip the pseudo-level, so a mixed
      // value produces one violation rather than three describing the same line.
      fail(id, "TD-E04", `Assigned Level: "${assigned}" mixes ${REQUIREMENT_GAP} with a test level — ${REQUIREMENT_GAP} is the whole value or none of it`, assignedLine);
    }
    const known = assignedLevels.filter((l) => LEVELS.includes(l));
    if (new Set(known).size !== known.length) {
      fail(id, "TD-E04", `Assigned Level: "${assigned}" repeats a level`, assignedLine);
    }
    const lowestFirst = [...known].sort((a, b) => LEVELS.indexOf(a) - LEVELS.indexOf(b));
    if (known.join("|") !== lowestFirst.join("|")) {
      fail(id, "TD-E04", `Assigned Level: "${assigned}" is not ordered lowest first — expected "${lowestFirst.join(", ")}"`, assignedLine);
    }
  }

  // TD-E21: the fold is well-formed and points somewhere a test will actually be written.
  //
  // Every rule here exists because the folded scenario has no test of its own: its `Expected:` is
  // asserted inside the covering scenario's test or nowhere at all. A fold that names a missing id, a
  // non-E2E id, the other stream, another folded scenario or itself silently deletes a scenario from
  // the run, and it deletes it from the one place — the implementing step's selection — that nothing
  // downstream re-derives. So the target is checked here rather than trusted.
  const foldField = fieldOf(block, "Folds Into");
  if (foldField) {
    const target = foldTargetOf(block);
    const foldLine = foldField.line;
    const levels = assignedLevelsOf(block);
    const ownE2E = levels.filter((l) => E2E_LEVELS.includes(l));

    if (target === null) {
      fail(id, "TD-E21", "Folds Into: is empty — omit the line entirely when the scenario stands as its own test", foldLine);
    } else if (!/^SCN-\d{3}$/.test(target)) {
      fail(id, "TD-E21", `Folds Into: "${target}" is not a single SCN-NNN id`, foldLine);
    } else if (target === id) {
      fail(id, "TD-E21", "Folds Into: names this scenario itself", foldLine);
    } else {
      const targetBlock = blocks.find((b) => b.id === target);
      if (!targetBlock) {
        fail(id, "TD-E21", `Folds Into: ${target} is not a scenario in this document`, foldLine);
      } else {
        // No chains. A fold is one hop by construction: the covering scenario is the one that gets a
        // test, and a target that is itself folded has no test to fold into.
        if (foldTargetOf(targetBlock) !== null) {
          fail(id, "TD-E21", `Folds Into: ${target} is itself folded into ${foldTargetOf(targetBlock)} — a fold is one hop, never a chain`, foldLine);
        }
        // Same stream. An API journey and a UI journey never cover each other, so neither can
        // execute the other's assertion inside its test.
        const targetE2E = assignedLevelsOf(targetBlock).filter((l) => E2E_LEVELS.includes(l));
        const shared = ownE2E.filter((l) => targetE2E.includes(l));
        if (ownE2E.length > 0 && shared.length === 0) {
          fail(
            id,
            "TD-E21",
            `Folds Into: ${target} carries ${targetE2E.length ? targetE2E.join(", ") : "no E2E level"}, which does not include this scenario's ${ownE2E.join(", ")}`,
            foldLine,
          );
        }
      }
    }

    // A fold is a statement about which E2E test runs this scenario, so there has to be one.
    if (levels.includes(REQUIREMENT_GAP)) {
      fail(id, "TD-E21", `Folds Into: on a ${REQUIREMENT_GAP} scenario — a scenario with no oracle is not executed by any test`, foldLine);
    } else if (levels.length > 0 && ownE2E.length === 0) {
      fail(id, "TD-E21", `Folds Into: on a scenario assigned ${levels.join(", ")} — folding is an E2E-only outcome of the minimum-set pass`, foldLine);
    }

    // Position: the classification step's three lines are contiguous, so a parser that has found
    // `Level Rationale:` knows whether a fold follows without scanning the rest of the block.
    const previous = block.fields[block.fields.findIndex((f) => f.name === "Folds Into") - 1];
    if (!previous || previous.name !== "Level Rationale") {
      fail(id, "TD-E21", `Folds Into: must sit directly after \`Level Rationale:\`, not after \`${previous ? previous.name : "the heading"}:\``, foldLine);
    }
  }

  // TD-E05: cited coverage items exist; `—` only with Experience-based.
  const coverageField = fieldOf(block, "Coverage Item");
  if (coverageField) {
    const value = coverageField.value;
    const isDash = value === "—" || value === "-";
    if (isDash && technique !== EXPERIENCE_BASED) {
      fail(id, "TD-E05", "Coverage Item: — is only permitted with Technique: Experience-based (error guessing)", coverageField.line);
    }
    if (!isDash) {
      const cited = citedItems(value);
      if (cited.length === 0) {
        fail(id, "TD-E05", `Coverage Item: "${value}" cites no EP-/BV-/DT-/ST- id`, coverageField.line);
      }
      for (const item of cited) {
        const prefix = item.slice(0, 2);
        if (!analysis.declared[prefix].some((d) => d.id === item)) {
          fail(id, "TD-E05", `Coverage Item: ${item} is not declared in # Test Basis Analysis`, coverageField.line);
        }
      }
    }
  }

  const notes = valueOf(block, "Notes") ?? "";
  const expected = valueOf(block, "Expected") ?? "";
  const notesLine = fieldOf(block, "Notes")?.line ?? block.line;

  // TD-E11: Experience-based needs its reason in Notes.
  if (technique === EXPERIENCE_BASED && (notes === "—" || notes === "-" || notes === "")) {
    fail(id, "TD-E11", "Technique: Experience-based (error guessing) with no reason in Notes:", notesLine);
  }

  // TD-E09: anything below High needs a reason in Notes.
  if (suitability !== null && suitability !== "High" && (notes === "—" || notes === "-" || notes === "")) {
    fail(id, "TD-E09", `Automation Suitability: ${suitability} with no reason in Notes:`, notesLine);
  }

  // TD-E10 is retired and its code is not reused. It failed a below-E2E `Assigned Level:` paired with
  // `Automation Suitability: Manual only`, which made E2E the only legal home for a manual-only
  // scenario. Level and automation readiness are independent: `Assigned Level:` is the lowest layer
  // with an assertable oracle, `Automation Suitability:` is whether that test can be automated now.
  // `Manual only` is permitted with every level, including `Requirement Gap`.

  // TD-E07 / TD-E08: unknown markers.
  const unknowns = [...notes.matchAll(/unknown:\s*([^—|]+?)(?:\s+[—-]\s+not assertable|$|\s*\|)/gi)].map((m) => m[1].trim());
  if (unknowns.length > 0) {
    warn(id, "TD-W01", `carries ${unknowns.length} \`unknown:\` marker(s) — criterion "unassertable values asserted" needs a judgement pass here`, notesLine);

    if (!gapsText.includes(id)) {
      fail(id, "TD-E08", "an `unknown:` marker with no `# Coverage Gaps` entry naming this scenario", notesLine);
    }

    // Literal tokens only: a status code, a quoted string, a route, a bare number.
    for (const unknown of unknowns) {
      const tokens = [
        ...[...unknown.matchAll(/\b[1-5]\d\d\b/g)].map((m) => m[0]),
        ...[...unknown.matchAll(/"([^"]+)"|'([^']+)'/g)].map((m) => m[1] ?? m[2]),
        ...[...unknown.matchAll(/(\/api\/[\w/{}-]+)/g)].map((m) => m[1]),
        ...[...unknown.matchAll(/\b\d+\s*(?:characters?|chars?|ms|s|seconds?|items?)\b/gi)].map((m) => m[0]),
      ];
      for (const token of new Set(tokens)) {
        if (expected.includes(token)) {
          fail(id, "TD-E07", `value "${token}" is marked unknown in Notes: and appears in this block's own Expected:`, fieldOf(block, "Expected")?.line ?? block.line);
        }
      }
    }
  }

  // TD-E22: UI scenarios that depend on backend mechanics need an explicit API coverage decision.
  //
  // The policy is contract-value only: the design links an API scenario when the backend behaviour
  // has independent contract value, and writes a reasoned `not needed` exemption when it is only UI
  // support, setup, cleanup or navigation mechanics. A missing decision is ambiguous downstream.
  if (isBackendBackedUiScenario(block)) {
    const decision = apiCoverageDecisionOf(block);
    if (!decision) {
      fail(id, "TD-E22", "backend-backed UI scenario has no `API coverage:` decision in Notes:", notesLine);
    } else if (!API_COVERAGE_DECISIONS.includes(decision.kind)) {
      fail(id, "TD-E22", `API coverage decision "${decision.kind}" is not recognized`, notesLine);
    } else if (decision.kind === "linked") {
      const target = blocks.find((b) => b.id === decision.linked_scenario);
      if (!target) {
        fail(id, "TD-E22", `API coverage links ${decision.linked_scenario}, which is not a scenario in this document`, notesLine);
      } else {
        const targetLevels = [valueOf(target, "Suggested Level"), ...(valueOf(target, "Assigned Level") ?? "").split(",")].map((s) =>
          (s ?? "").trim(),
        );
        if (!targetLevels.includes("E2E API")) {
          fail(id, "TD-E22", `API coverage links ${target.id}, which is not an E2E API scenario`, notesLine);
        }
      }
    } else if (decision.kind === "not_needed" && decision.reason === "") {
      fail(id, "TD-E22", "`API coverage: not needed` must include the exemption reason after a dash", notesLine);
    }
  }
}

// TD-E03: ids unique, zero-padded to three, sequential from SCN-001 with no gaps.
{
  const seen = new Set();
  for (const block of blocks) {
    if (!/^SCN-\d{3}$/.test(block.id)) {
      fail(block.id, "TD-E03", "scenario id is not `SCN-` followed by exactly three digits", block.line);
    }
    if (seen.has(block.id)) fail(block.id, "TD-E03", "duplicate scenario id", block.line);
    seen.add(block.id);
  }
  const numbers = blocks
    .filter((b) => /^SCN-\d{3}$/.test(b.id))
    .map((b) => ({ n: Number(b.id.slice(4)), block: b }));
  for (let i = 0; i < numbers.length; i += 1) {
    if (numbers[i].n !== i + 1) {
      fail(numbers[i].block.id, "TD-E03", `expected SCN-${String(i + 1).padStart(3, "0")} at this position — ids must be sequential with no gaps`, numbers[i].block.line);
      break;
    }
  }
}

// TD-E06: every declared coverage item is cited by a scenario or named in # Coverage Gaps.
// Citation is what this check asks for, so a traced-only item passes it — whether that citation
// asserts anything is the technique matrix's question, not this one's.
for (const prefix of ["EP", "BV", "DT", "ST"]) {
  for (const { id, line } of analysis.declared[prefix]) {
    if (citedAnywhere.has(id)) continue;
    if (gapsText.includes(id)) continue;
    fail(id, "TD-E06", "declared coverage item is exercised by no scenario and named in no `# Coverage Gaps` entry", line);
  }
}

// TD-E18: all four technique subsections present, as a model or an explicit not-applicable.
for (const s of TECHNIQUE_SUBSECTIONS) {
  if (!analysis.present[s.prefix]) {
    fail("ANALYSIS", "TD-E18", `# Test Basis Analysis has no \`## ${s.matrixName}\` subsection`);
    continue;
  }
  if (analysis.declared[s.prefix].length === 0 && !analysis.notApplicable[s.prefix]) {
    fail("ANALYSIS", "TD-E18", `the ${s.matrixName} subsection declares no coverage item and carries no \`_Not applicable — …._\` line`);
  }
}

// TD-E12: every `approved:` marker has a five-column # Approved Assumptions row.
{
  const rows = tableRows(doc.sections.get("Approved Assumptions")?.lines ?? []).filter(
    (r) => !/^Value$/i.test(r.cells[0] ?? ""),
  );
  const approvedSection = doc.sections.get("Approved Assumptions");
  const approvedText = sectionText(doc, "Approved Assumptions");
  if (!approvedSection) {
    // already reported by TD-E01
  } else if (rows.length === 0 && !/_None\._/.test(approvedText)) {
    fail("APPROVED", "TD-E12", "`# Approved Assumptions` is empty and does not read `_None._`", approvedSection.line);
  }
  for (const row of rows) {
    if (row.cells.length < 5 || row.cells.slice(0, 5).some((c) => c === "" || c === "—")) {
      fail("APPROVED", "TD-E12", "an `# Approved Assumptions` row is missing one of its five mandatory columns", row.line);
    }
  }
  for (const block of blocks) {
    const notes = valueOf(block, "Notes") ?? "";
    if (!/\bapproved:/i.test(notes)) continue;
    const named = rows.some((r) => (r.cells[1] ?? "").includes(block.id));
    const viaSurface = /approved:[^|]*see # API Surface/i.test(notes);
    if (!named && !viaSurface) {
      fail(block.id, "TD-E12", "an `approved:` marker with no matching `# Approved Assumptions` row", fieldOf(block, "Notes")?.line ?? block.line);
    }
  }
}

// TD-E13: traceability matrix against the blocks, and against the requirements document.
{
  const section = doc.sections.get("Traceability Matrix");
  const rows = tableRows(section?.lines ?? []).filter((r) => !/^Requirement$/i.test(r.cells[0] ?? ""));
  const rowById = new Map();
  for (const row of rows) {
    const reqId = row.cells[0];
    if (!/^(FR-\d+\.\d+|AC-\d+)$/.test(reqId)) continue;
    rowById.set(reqId, row);
  }

  for (const [reqId, scenarioIds] of coverageByRequirement) {
    const row = rowById.get(reqId);
    if (!row) {
      fail(reqId, "TD-E13", `scenarios cite this requirement but it has no traceability-matrix row: ${scenarioIds.join(", ")}`, section?.line ?? null);
      continue;
    }
    const cell = row.cells[1] ?? "";
    if (/_Out of scope for this run/.test(cell)) {
      fail(reqId, "TD-E13", `marked out of scope but cited by ${scenarioIds.join(", ")}`, row.line);
      continue;
    }
    const listed = [...cell.matchAll(/\bSCN-\d{3}\b/g)].map((m) => m[0]);
    const missing = scenarioIds.filter((s) => !listed.includes(s));
    const extra = listed.filter((s) => !scenarioIds.includes(s));
    if (missing.length) fail(reqId, "TD-E13", `traceability row omits ${missing.join(", ")}`, row.line);
    if (extra.length) fail(reqId, "TD-E13", `traceability row lists ${extra.join(", ")}, which do not cite this requirement`, row.line);
  }

  for (const [reqId, row] of rowById) {
    const cell = row.cells[1] ?? "";
    const listed = [...cell.matchAll(/\bSCN-\d{3}\b/g)].map((m) => m[0]);
    const isOutOfScope = /_Out of scope for this run/.test(cell);
    if (listed.length === 0 && !isOutOfScope && cell.trim() !== "") {
      // a free-text cell that is neither ids nor the out-of-scope marker
      fail(reqId, "TD-E13", `traceability cell is neither scenario ids nor the out-of-scope marker: "${cell}"`, row.line);
    }
    if (isOutOfScope && !gapsText.includes(reqId)) {
      fail(reqId, "TD-E13", "marked out of scope with no `# Coverage Gaps` entry naming it", row.line);
    }
  }

  if (requirementIds) {
    for (const reqId of requirementIds) {
      if (!rowById.has(reqId)) {
        fail(reqId, "TD-E13", "requirement id from the requirements document has no traceability-matrix row", section?.line ?? null);
      }
    }
    for (const block of blocks) {
      const value = valueOf(block, "Requirement") ?? "";
      for (const m of value.matchAll(/\b((?:FR-\d+\.\d+)|(?:AC-\d+))\b/g)) {
        if (!requirementIds.includes(m[1])) {
          fail(block.id, "TD-E13", `Requirement: ${m[1]} does not exist in ${requirementsPath}`, fieldOf(block, "Requirement").line);
        }
      }
    }
  }
}

// TD-E14: coverage matrix carries all twelve categories and agrees with the blocks.
{
  const section = doc.sections.get("Coverage Matrix");
  const rows = tableRows(section?.lines ?? []).filter((r) => !/^Category$/i.test(r.cells[0] ?? ""));
  const rowByCategory = new Map(rows.map((r) => [r.cells[0], r]));
  for (const category of CATEGORIES) {
    const row = rowByCategory.get(category);
    if (!row) {
      fail("COVERAGE", "TD-E14", `coverage matrix has no row for category "${category}"`, section?.line ?? null);
      continue;
    }
    const cell = row.cells[1] ?? "";
    const listed = [...cell.matchAll(/\bSCN-\d{3}\b/g)].map((m) => m[0]);
    const actual = coverageByCategory.get(category) ?? [];
    if (NOT_APPLICABLE.test(cell.trim())) {
      if (actual.length > 0) {
        fail("COVERAGE", "TD-E14", `category "${category}" is marked not applicable but ${actual.join(", ")} carry it`, row.line);
      }
      continue;
    }
    const missing = actual.filter((s) => !listed.includes(s));
    const extra = listed.filter((s) => !actual.includes(s));
    if (missing.length) fail("COVERAGE", "TD-E14", `category "${category}" row omits ${missing.join(", ")}`, row.line);
    if (extra.length) fail("COVERAGE", "TD-E14", `category "${category}" row lists ${extra.join(", ")}, which do not carry it`, row.line);
    if (listed.length === 0 && actual.length === 0) {
      fail("COVERAGE", "TD-E14", `category "${category}" has neither scenarios nor an explicit \`_Not applicable — …._\``, row.line);
    }
  }
}

// TD-E15: technique coverage matrix survives a recount; uncovered ids appear in # Coverage Gaps.
{
  const section = doc.sections.get("Technique Coverage Matrix");
  const rows = tableRows(section?.lines ?? []).filter((r) => !/^Technique$/i.test(r.cells[0] ?? ""));
  for (const t of techniqueCounts) {
    const row = rows.find((r) => (r.cells[0] ?? "").startsWith(t.matrixName));
    if (!row) {
      fail("TECHNIQUE", "TD-E15", `technique coverage matrix has no row for ${t.matrixName}`, section?.line ?? null);
      continue;
    }
    // Six columns since traced-only became its own figure: | Technique | Coverage items |
    // Exercised | Traced-only | Coverage | Uncovered |. A five-column row is a document written
    // against the older contract, and its `Coverage` percentage is the number this split exists to
    // correct — so it is reported rather than read leniently.
    if (row.cells.length < 6) {
      fail("TECHNIQUE", "TD-E15", `${t.matrixName} row has ${row.cells.length} columns; the matrix takes six — | Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |`, row.line);
      continue;
    }
    const items = Number(row.cells[1]);
    const exercised = Number(row.cells[2]);
    const tracedOnly = Number(row.cells[3]);
    const percentCell = (row.cells[4] ?? "").replace("%", "").trim();
    if (items !== t.items) {
      fail("TECHNIQUE", "TD-E15", `${t.matrixName} claims ${row.cells[1]} coverage items; # Test Basis Analysis declares ${t.items}`, row.line);
    }
    if (exercised !== t.exercised) {
      fail("TECHNIQUE", "TD-E15", `${t.matrixName} claims ${row.cells[2]} exercised; the scenario blocks exercise ${t.exercised}`, row.line);
    }
    if (tracedOnly !== t.tracedOnly) {
      fail("TECHNIQUE", "TD-E15", `${t.matrixName} claims ${row.cells[3]} traced-only; ${t.tracedOnly} item(s) are cited only by gap-blocked scenarios`, row.line);
    }
    if (t.percent !== null && percentCell !== "—" && Number(percentCell) !== t.percent) {
      fail("TECHNIQUE", "TD-E15", `${t.matrixName} claims ${row.cells[4]}; the recount is ${t.percent}%`, row.line);
    }
    // A traced-only item is a coverage item nothing asserts. The matrix reports how many there are;
    // `# Coverage Gaps` is where a reader finds out which, and why.
    for (const id of t.tracedOnlyIds) {
      if (!gapsText.includes(id)) {
        fail(id, "TD-E15", "coverage item cited only by scenarios that assert nothing, and named in no `# Coverage Gaps` entry", row.line);
      }
    }
    for (const id of t.uncovered) {
      if (!(row.cells[5] ?? "").includes(id)) {
        fail("TECHNIQUE", "TD-E15", `${t.matrixName} does not list uncovered item ${id}`, row.line);
      }
      if (!gapsText.includes(id)) {
        fail(id, "TD-E15", "uncovered coverage item with no `# Coverage Gaps` entry", row.line);
      }
    }
  }
}

// TD-E16: # Summary recount.
{
  const section = doc.sections.get("Summary");
  const text = sectionText(doc, "Summary");
  const line = section?.line ?? null;

  const counts = text.match(/Scenarios:\s*(\d+)\s*\|\s*Automatable:\s*(\d+)\s*\|\s*Manual only:\s*(\d+)/);
  if (!counts) {
    fail("SUMMARY", "TD-E16", "no `Scenarios: n  |  Automatable: n  |  Manual only: n` line", line);
  } else {
    if (Number(counts[1]) !== blockCount) fail("SUMMARY", "TD-E16", `Scenarios: ${counts[1]} but the document has ${blockCount} \`## SCN-\` blocks`, line);
    if (Number(counts[2]) !== automatable) fail("SUMMARY", "TD-E16", `Automatable: ${counts[2]} but ${automatable} blocks are not \`Manual only\``, line);
    if (Number(counts[3]) !== manualOnly.length) fail("SUMMARY", "TD-E16", `Manual only: ${counts[3]} but ${manualOnly.length} blocks carry it`, line);
    if (Number(counts[2]) + Number(counts[3]) !== Number(counts[1])) fail("SUMMARY", "TD-E16", "Automatable: + Manual only: does not equal Scenarios:", line);
  }

  const techniques = text.match(/Techniques:\s*(.+)/);
  if (!techniques) {
    fail("SUMMARY", "TD-E16", "no `Techniques:` line", line);
  } else {
    // `EP 8/14 (3 traced-only)` — the parenthetical is written exactly when the figure is non-zero,
    // so its absence is a claim that every cited item is asserted by something.
    const pairs = {
      EP: /EP\s+(\d+|n\/a)(?:\/(\d+))?(?:\s*\((\d+) traced-only\))?/,
      BVA: /BVA\s+(\d+|n\/a)(?:\/(\d+))?(?:\s*\((\d+) traced-only\))?/,
      DT: /DT\s+(\d+|n\/a)(?:\/(\d+))?(?:\s*\((\d+) traced-only\))?/,
      ST: /ST\s+(\d+|n\/a)(?:\/(\d+))?(?:\s*\((\d+) traced-only\))?/,
    };
    const prefixFor = { EP: "EP", BVA: "BV", DT: "DT", ST: "ST" };
    for (const [label, re] of Object.entries(pairs)) {
      const m = techniques[1].match(re);
      const t = techniqueByPrefix.get(prefixFor[label]);
      if (!m) {
        fail("SUMMARY", "TD-E16", `Techniques: line has no ${label} figure`, line);
        continue;
      }
      if (m[1] === "n/a") {
        if (t.items !== 0) fail("SUMMARY", "TD-E16", `Techniques: ${label} reads n/a but ${t.items} items are declared`, line);
        continue;
      }
      if (Number(m[1]) !== t.exercised || Number(m[2]) !== t.items) {
        fail("SUMMARY", "TD-E16", `Techniques: ${label} ${m[1]}/${m[2]} but the recount is ${t.exercised}/${t.items}`, line);
      }
      const statedTracedOnly = m[3] === undefined ? 0 : Number(m[3]);
      if (statedTracedOnly !== t.tracedOnly) {
        fail("SUMMARY", "TD-E16", `Techniques: ${label} states ${m[3] === undefined ? "no" : m[3]} traced-only but ${t.tracedOnly} item(s) are cited only by gap-blocked scenarios`, line);
      }
    }
  }

  const requirements = text.match(/Requirements:\s*FR\s+(\d+)\/(\d+),\s*AC\s+(\d+)\/(\d+)/);
  if (!requirements) {
    fail("SUMMARY", "TD-E16", "no `Requirements: FR n/n, AC n/n covered` line", line);
  } else {
    const rows = tableRows(doc.sections.get("Traceability Matrix")?.lines ?? []).filter((r) =>
      /^(FR-\d+\.\d+|AC-\d+)$/.test(r.cells[0] ?? ""),
    );
    const countFor = (prefix) => {
      const all = rows.filter((r) => r.cells[0].startsWith(prefix));
      const covered = all.filter((r) => /\bSCN-\d{3}\b/.test(r.cells[1] ?? ""));
      return { total: all.length, covered: covered.length };
    };
    const fr = countFor("FR-");
    const ac = countFor("AC-");
    if (Number(requirements[1]) !== fr.covered || Number(requirements[2]) !== fr.total) {
      fail("SUMMARY", "TD-E16", `Requirements: FR ${requirements[1]}/${requirements[2]} but the traceability matrix has ${fr.covered}/${fr.total}`, line);
    }
    if (Number(requirements[3]) !== ac.covered || Number(requirements[4]) !== ac.total) {
      fail("SUMMARY", "TD-E16", `Requirements: AC ${requirements[3]}/${requirements[4]} but the traceability matrix has ${ac.covered}/${ac.total}`, line);
    }
  }

  if (!/^Levels:/m.test(text)) fail("SUMMARY", "TD-E16", "no `Levels:` line", line);
}

// TD-E17: # Test Basis Research — ten rows, in order, Findings implies Feeds.
{
  const section = doc.sections.get("Test Basis Research");
  const rows = tableRows(section?.lines ?? []).filter((r) => !/^Aspect$/i.test(r.cells[0] ?? ""));
  const names = rows.map((r) => r.cells[0]);
  for (const aspect of RESEARCH_ROWS) {
    if (!names.includes(aspect)) {
      fail("RESEARCH", "TD-E17", `\`# Test Basis Research\` has no "${aspect}" row — an absent row and an empty row are different claims`, section?.line ?? null);
    }
  }
  const ordered = names.filter((n) => RESEARCH_ROWS.includes(n));
  const expected = RESEARCH_ROWS.filter((n) => ordered.includes(n));
  if (ordered.join("|") !== expected.join("|")) {
    fail("RESEARCH", "TD-E17", "research rows are out of contract order", section?.line ?? null);
  }
  for (const row of rows) {
    if (!RESEARCH_ROWS.includes(row.cells[0])) continue;
    const findings = (row.cells[1] ?? "").trim();
    const feeds = (row.cells[2] ?? "").trim();
    if (findings === "") {
      fail("RESEARCH", "TD-E17", `"${row.cells[0]}" has an empty Findings cell — write \`— none stated\` instead`, row.line);
      continue;
    }
    if (NONE_STATED.test(findings)) continue;
    if (feeds === "" || feeds === "—" || feeds === "-") {
      fail("RESEARCH", "TD-E17", `"${row.cells[0]}" has findings and an empty Feeds cell — research nobody built on`, row.line);
    }
  }
  // The Unknowns row must not read `— none stated` while blocks carry unknown markers.
  const unknownsRow = rows.find((r) => r.cells[0] === "Unknowns");
  const anyUnknownMarker = blocks.some((b) => /unknown:/i.test(valueOf(b, "Notes") ?? ""));
  if (unknownsRow && anyUnknownMarker && NONE_STATED.test((unknownsRow.cells[1] ?? "").trim())) {
    fail("RESEARCH", "TD-E17", "the Unknowns row reads `— none stated` while scenarios carry `unknown:` markers", unknownsRow.line);
  }
}

// --- TD-E19 / TD-E20: the level assignment recount -------------------------

/**
 * `# Level Assignment Summary` split at its two subheadings: the level table and narrative lines,
 * then `## Handed Off As Follow-Up Work`, then `## Blocked / Requirement Gaps`. The two subsections
 * answer different questions — a level this repository does not automate, versus a scenario with no
 * level at all — so they are never merged.
 */
function splitLevelSection(section) {
  const before = [];
  const after = [];
  const blocked = [];
  let target = before;
  let hasHandedOff = false;
  let hasBlocked = false;
  for (const entry of section?.lines ?? []) {
    if (/^##\s+Handed Off As Follow-Up Work\s*$/.test(entry.text)) {
      hasHandedOff = true;
      target = after;
      continue;
    }
    if (/^##\s+Blocked\s*\/\s*Requirement Gaps\s*$/.test(entry.text)) {
      hasBlocked = true;
      target = blocked;
      continue;
    }
    target.push(entry);
  }
  return { before, after, blocked, hasHandedOff, hasBlocked };
}

/** The scenario ids a free-text line names, de-duplicated in reading order. */
function idsIn(text) {
  const ids = [];
  for (const m of text.matchAll(/\bSCN-\d{3}\b/g)) if (!ids.includes(m[0])) ids.push(m[0]);
  return ids;
}

/**
 * The scenario ids a follow-up / blocked table *lists as rows* — read from each row's Scenario
 * column alone, never from the whole subsection text.
 *
 * The distinction is load-bearing. An `Expected:` cell is copied verbatim out of the scenario block,
 * and a scenario legitimately cross-references another one in its prose ("see SCN-002"). Scanning the
 * whole subsection reads that mention as a claimed row and reports a scenario that is not listed at
 * all — which is what TD-E19 did to SCRUM-115's `## Blocked / Requirement Gaps` table. A row is what
 * its first column says, so that is what is read.
 */
function listedRowIds(lines) {
  const ids = [];
  for (const row of tableRows(lines)) {
    const first = row.cells[0] ?? "";
    if (/^Scenario$/i.test(first)) continue; // header
    for (const m of first.matchAll(/\bSCN-\d{3}\b/g)) if (!ids.includes(m[0])) ids.push(m[0]);
  }
  return ids;
}

function compareIdSets(subject, code, label, actual, listed, line) {
  const missing = actual.filter((id) => !listed.includes(id));
  const extra = listed.filter((id) => !actual.includes(id));
  if (missing.length) fail(subject, code, `${label} omits ${missing.join(", ")}`, line);
  if (extra.length) fail(subject, code, `${label} lists ${extra.join(", ")}, which do not belong there`, line);
}

{
  const section = doc.sections.get("Level Assignment Summary");
  const levelsText = sectionText(doc, "Summary").match(/^Levels:.*$/m)?.[0] ?? null;
  const summaryLine = doc.sections.get("Summary")?.line ?? null;

  if (!anyAssignment) {
    // A document that has not been classified yet is not in scope for either check. Saying so is
    // the point: silence here would read as a pass on arithmetic nobody has done.
    skipped.push("TD-E19/TD-E20 (level assignment recount): no block carries an `Assigned Level:` line");
    if (section) {
      fail("LEVELS", "TD-E19", "`# Level Assignment Summary` is present but no scenario carries an `Assigned Level:` line", section.line);
    }
    if (levelsText !== null && !/_pending classification\._/.test(levelsText)) {
      fail("SUMMARY", "TD-E20", `\`${levelsText}\` but no scenario carries an \`Assigned Level:\` line`, summaryLine);
    }
  } else if (!section) {
    fail("LEVELS", "TD-E19", `${assignedBlocks.length} scenario(s) carry an \`Assigned Level:\` line but the document has no \`# Level Assignment Summary\` section`);
  } else {
    const { before, after, blocked, hasHandedOff, hasBlocked } = splitLevelSection(section);
    const beforeText = before.map((l) => l.text).join("\n");

    // the | Level | Count | Scenarios | table
    const rows = tableRows(before).filter((r) => !/^Level$/i.test(r.cells[0] ?? ""));
    const rowByLevel = new Map(rows.map((r) => [r.cells[0], r]));
    for (const level of ASSIGNABLE_LEVELS) {
      const row = rowByLevel.get(level);
      const actual = scenariosByLevel.get(level);
      if (!row) {
        // The five real levels always carry a row. The pseudo-level's row is required only when a
        // scenario is assigned to it, so a design with no requirement gaps keeps the table it has.
        if (level === REQUIREMENT_GAP && actual.length === 0) continue;
        fail("LEVELS", "TD-E19", `the level table has no row for "${level}"`, section.line);
        continue;
      }
      if (Number(row.cells[1]) !== actual.length) {
        fail("LEVELS", "TD-E19", `"${level}" claims a count of ${row.cells[1]}; ${actual.length} scenario(s) carry it`, row.line);
      }
      compareIdSets("LEVELS", "TD-E19", `the "${level}" row`, actual, idsIn(row.cells[2] ?? ""), row.line);
    }

    // Scenarios: n total, n assigned, n unassigned.
    const totals = beforeText.match(/Scenarios:\s*(\d+)\s*total,\s*(\d+)\s*assigned,\s*(\d+)\s*unassigned/);
    if (!totals) {
      fail("LEVELS", "TD-E19", "no `Scenarios: n total, n assigned, n unassigned.` line", section.line);
    } else {
      if (Number(totals[1]) !== blockCount) fail("LEVELS", "TD-E19", `${totals[1]} total but the document has ${blockCount} \`## SCN-\` blocks`, section.line);
      if (Number(totals[2]) !== assignedBlocks.length) fail("LEVELS", "TD-E19", `${totals[2]} assigned but ${assignedBlocks.length} blocks carry an \`Assigned Level:\` line`, section.line);
      if (Number(totals[3]) !== unassignedBlocks.length) fail("LEVELS", "TD-E19", `${totals[3]} unassigned but ${unassignedBlocks.length} blocks carry no \`Assigned Level:\` line`, section.line);
    }

    // the two recomputable narrative lines
    for (const [label, actual] of [
      ["Multi-level scenarios", multiLevelBlocks.map((b) => b.id)],
      ["Overridden suggestions", overriddenBlocks.map((b) => b.id)],
    ]) {
      const match = beforeText.match(new RegExp(`^${label}:.*$`, "m"));
      if (!match) {
        fail("LEVELS", "TD-E19", `no \`${label}:\` line`, section.line);
        continue;
      }
      compareIdSets("LEVELS", "TD-E19", `the \`${label}:\` line`, actual, idsIn(match[0]), section.line);
    }

    // `E2E tests implied:` is a recount like the two above, not a judgement: it counts the E2E
    // scenarios that carry no `Folds Into:` line. Checked per level so a wrong figure names which.
    {
      const match = beforeText.match(/^E2E tests implied:.*$/m);
      if (!match) {
        fail("LEVELS", "TD-E19", "no `E2E tests implied:` line", section.line);
      } else {
        for (const level of E2E_LEVELS) {
          const claimed = match[0].match(new RegExp(`${level}\\s+(\\d+)`));
          if (!claimed) {
            fail("LEVELS", "TD-E19", `the \`E2E tests implied:\` line states no figure for "${level}"`, section.line);
          } else if (Number(claimed[1]) !== e2eTestsImplied[level]) {
            fail(
              "LEVELS",
              "TD-E19",
              `\`E2E tests implied:\` claims ${claimed[1]} for "${level}"; ${e2eTestsImplied[level]} scenario(s) carry that level without a \`Folds Into:\` line`,
              section.line,
            );
          }
        }
      }
    }

    // the three judgement lines: presence only — none is derivable from the document.
    for (const label of ["E2E journeys", "Demoted by the minimum-set pass", "Folded by the minimum-set pass"]) {
      if (!new RegExp(`^${label}:`, "m").test(beforeText)) {
        fail("LEVELS", "TD-E19", `no \`${label}:\` line`, section.line);
      }
    }

    // ## Handed Off As Follow-Up Work
    const handedOff = handedOffBlocks.map((b) => b.id);
    if (!hasHandedOff) {
      fail("LEVELS", "TD-E19", "`# Level Assignment Summary` has no `## Handed Off As Follow-Up Work` subsection", section.line);
    } else {
      const afterText = after.map((l) => l.text).join("\n");
      const handedRows = tableRows(after).filter((r) => !/^Scenario$/i.test(r.cells[0] ?? ""));
      if (handedOff.length === 0) {
        if (handedRows.length > 0) {
          fail("LEVELS", "TD-E19", `the follow-up table lists ${listedRowIds(after).join(", ")}, but every assigned scenario sits at a level this run implements`, handedRows[0].line);
        } else if (!/_None\._/.test(afterText)) {
          fail("LEVELS", "TD-E19", "the follow-up table is empty and does not read `_None._`", section.line);
        }
      } else {
        compareIdSets("LEVELS", "TD-E19", "the follow-up table", handedOff, listedRowIds(after), section.line);
      }
    }

    // ## Blocked / Requirement Gaps — present exactly when a scenario records one.
    {
      const gapIds = requirementGapBlocks.map((b) => b.id);
      if (gapIds.length === 0) {
        if (hasBlocked && listedRowIds(blocked).length > 0) {
          fail("LEVELS", "TD-E19", `the \`## Blocked / Requirement Gaps\` subsection lists ${listedRowIds(blocked).join(", ")}, but no scenario is assigned ${REQUIREMENT_GAP}`, section.line);
        }
      } else if (!hasBlocked) {
        fail("LEVELS", "TD-E19", `${gapIds.length} scenario(s) are assigned ${REQUIREMENT_GAP} but the section has no \`## Blocked / Requirement Gaps\` subsection`, section.line);
      } else {
        compareIdSets("LEVELS", "TD-E19", "the `## Blocked / Requirement Gaps` subsection", gapIds, listedRowIds(blocked), section.line);
      }
    }

    // TD-E20: the `Levels:` line of `# Summary` against the same assignments.
    const expectedLevels = levelsLine();
    if (levelsText === null) {
      // TD-E16 already reports the absent line.
    } else if (levelsText.trim() !== expectedLevels) {
      fail("SUMMARY", "TD-E20", `\`${levelsText.trim()}\` but the \`Assigned Level:\` lines recount to \`${expectedLevels}\``, summaryLine);
    }
  }
}

// --- --emit-summary --------------------------------------------------------

function emitSummaryBlock() {
  const out = [];
  const traceRows = tableRows(doc.sections.get("Traceability Matrix")?.lines ?? []).filter((r) =>
    /^(FR-\d+\.\d+|AC-\d+)$/.test(r.cells[0] ?? ""),
  );
  const knownIds = requirementIds ?? traceRows.map((r) => r.cells[0]);
  const outOfScope = new Map(
    traceRows
      .filter((r) => /_Out of scope for this run/.test(r.cells[1] ?? ""))
      .map((r) => [r.cells[0], r.cells[1]]),
  );

  const frIds = knownIds.filter((id) => id.startsWith("FR-"));
  const acIds = knownIds.filter((id) => id.startsWith("AC-"));
  const coveredCount = (ids) => ids.filter((id) => (coverageByRequirement.get(id) ?? []).length > 0).length;

  const summarySource = sectionText(doc, "Summary");
  const existingLevels = (summarySource.match(/^Levels:.*$/m) ?? ["Levels: _pending classification._"])[0];

  // `Blocked by (top unknowns):` is a judgement call — which five unknowns matter most — so it is
  // carried through verbatim rather than recomputed, exactly as `Levels:` is. Omitted entirely when
  // the document has none, which is what the contract asks for.
  const blockedBy = [];
  {
    const lines = splitLines(summarySource);
    const start = lines.findIndex((l) => /^Blocked by \(top unknowns\):/.test(l));
    if (start >= 0) {
      blockedBy.push(lines[start]);
      for (let i = start + 1; i < lines.length && lines[i].trim() !== ""; i += 1) blockedBy.push(lines[i]);
    }
  }

  out.push("# Summary");
  out.push("");
  out.push(`Scenarios: ${blockCount}  |  Automatable: ${automatable}  |  Manual only: ${manualOnly.length}`);
  out.push(existingLevels);
  out.push(`Requirements: FR ${coveredCount(frIds)}/${frIds.length}, AC ${coveredCount(acIds)}/${acIds.length} covered`);
  out.push(
    "Techniques: " +
      ["EP", "BV", "DT", "ST"]
        .map((p) => {
          const t = techniqueByPrefix.get(p);
          const label = p === "BV" ? "BVA" : p;
          if (t.items === 0) return `${label} n/a`;
          const traced = t.tracedOnly > 0 ? ` (${t.tracedOnly} traced-only)` : "";
          return `${label} ${t.exercised}/${t.items}${traced}`;
        })
        .join(", "),
  );
  if (blockedBy.length > 0) {
    out.push("");
    out.push(...blockedBy);
  }
  out.push("");
  out.push("# Traceability Matrix");
  out.push("");
  out.push("| Requirement | Scenarios |");
  out.push("|---|---|");
  for (const id of knownIds) {
    const scenarios = coverageByRequirement.get(id) ?? [];
    const cell = scenarios.length > 0 ? scenarios.join(", ") : (outOfScope.get(id) ?? "");
    out.push(`| ${id} | ${cell} |`);
  }
  out.push("");
  out.push("# Coverage Matrix");
  out.push("");
  out.push("| Category | Scenarios |");
  out.push("|---|---|");
  const existingCoverage = new Map(
    tableRows(doc.sections.get("Coverage Matrix")?.lines ?? []).map((r) => [r.cells[0], r.cells[1] ?? ""]),
  );
  for (const category of CATEGORIES) {
    const scenarios = coverageByCategory.get(category) ?? [];
    const cell = scenarios.length > 0 ? scenarios.join(", ") : (existingCoverage.get(category) ?? "");
    out.push(`| ${category} | ${cell} |`);
  }
  out.push("");
  out.push("# Technique Coverage Matrix");
  out.push("");
  out.push("| Technique | Coverage items | Exercised | Traced-only | Coverage | Uncovered |");
  out.push("|---|---|---|---|---|---|");
  const existingTechnique = new Map(
    tableRows(doc.sections.get("Technique Coverage Matrix")?.lines ?? []).map((r) => [r.cells[0], r.cells[0]]),
  );
  for (const t of techniqueCounts) {
    const label = [...existingTechnique.keys()].find((k) => k.startsWith(t.matrixName)) ?? t.matrixName;
    const percent = t.percent === null ? "—" : `${t.percent}%`;
    const uncovered = t.uncovered.length > 0 ? t.uncovered.join(", ") : "—";
    out.push(`| ${label} | ${t.items} | ${t.exercised} | ${t.tracedOnly} | ${percent} | ${uncovered} |`);
  }
  return out.join("\n");
}

if (emitSummary) {
  process.stdout.write(`${emitSummaryBlock()}\n`);
  process.exit(EXIT_CLEAN);
}

// --- --emit-levels ---------------------------------------------------------

function emitLevelsBlock() {
  const section = doc.sections.get("Level Assignment Summary");
  const { before } = splitLevelSection(section);
  const beforeText = before.map((l) => l.text).join("\n");

  // Two lines nothing in the document can derive: which journeys the E2E set covers, and what the
  // minimum-set pass demoted. They belong to the judgement half of this step, so they are carried
  // through untouched rather than recomputed — the same treatment `--emit-summary` gives `Levels:`.
  const carry = (label) => beforeText.match(new RegExp(`^${label}:.*$`, "m"))?.[0] ?? `${label}: — none`;

  const out = [];
  out.push(levelsLine());
  out.push("");
  out.push("# Level Assignment Summary");
  out.push("");
  out.push(
    "_Recounted from the `Assigned Level:` lines of the scenario blocks above._",
  );
  out.push("");
  out.push("| Level | Count | Scenarios |");
  out.push("|---|---|---|");
  for (const level of ASSIGNABLE_LEVELS) {
    const ids = scenariosByLevel.get(level);
    // The pseudo-level earns a row only when something is assigned to it — an all-zero row would read
    // as a claim about test levels, which it is not.
    if (level === REQUIREMENT_GAP && ids.length === 0) continue;
    out.push(`| ${level} | ${ids.length} | ${ids.length > 0 ? ids.join(", ") : "—"} |`);
  }
  out.push("");
  out.push(`Scenarios: ${blockCount} total, ${assignedBlocks.length} assigned, ${unassignedBlocks.length} unassigned.`);
  if (requirementGapBlocks.length > 0) {
    // The denominator of any E2E share, stated where the share is read: a requirement gap is not
    // coverage at any level, so it counts towards neither side of that figure.
    out.push(
      `Executable coverage: ${executableBlocks.length} scenario(s) at a testing level; ` +
        `${requirementGapBlocks.length} recorded as ${REQUIREMENT_GAP} and excluded from every E2E figure.`,
    );
  }
  out.push(
    "Multi-level scenarios: " +
      (multiLevelBlocks.length === 0
        ? "— none"
        : multiLevelBlocks.map((b) => `${b.id} (${assignedLevelsOf(b).join(" + ")})`).join(", ")),
  );
  // `Overridden suggestions:` is emitted only for a document that still carries `Suggested Level:`
  // lines — one written before the writing and classifying steps were merged. After the merge there
  // is no proposal to override, and a line reading "none" would report a comparison nobody made as a
  // finding that nothing was overridden.
  if (blocks.some((b) => valueOf(b, "Suggested Level") !== null)) {
    out.push(
      "Overridden suggestions: " +
        (overriddenBlocks.length === 0
          ? "— none"
          : overriddenBlocks
              .map((b) => `${b.id} (${valueOf(b, "Suggested Level")} -> ${assignedLevelsOf(b).join(", ")})`)
              .join(", ")),
    );
  }
  // Arithmetic, not judgement: which scenarios carry a `Folds Into:` line is on disk, and so is how
  // many tests the E2E set therefore implies. Which scenarios *should* have been folded is the
  // judgement, and it is on the carried line below.
  out.push(
    "E2E tests implied: " +
      E2E_LEVELS.map((level) => `${level} ${e2eTestsImplied[level]}`).join(", ") +
      (foldedBlocks.length === 0
        ? ""
        : ` (${foldedBlocks.length} scenario(s) folded into another scenario's test)`) +
      ".",
  );
  out.push(carry("E2E journeys"));
  out.push(carry("Demoted by the minimum-set pass"));
  out.push(carry("Folded by the minimum-set pass"));
  out.push("");
  out.push("## Handed Off As Follow-Up Work");
  out.push("");
  out.push("Scenarios at levels not implemented in this repository. Kept here for traceability.");
  out.push("");
  if (handedOffBlocks.length === 0) {
    out.push("_None._");
  } else {
    out.push("| Scenario | Assigned Level | Requirement |");
    out.push("|---|---|---|");
    for (const block of handedOffBlocks) {
      out.push(`| ${block.id} | ${assignedLevelsOf(block).join(", ")} | ${valueOf(block, "Requirement") ?? "—"} |`);
    }
  }
  if (requirementGapBlocks.length > 0) {
    out.push("");
    out.push(`## Blocked / ${REQUIREMENT_GAP}s`);
    out.push("");
    out.push(
      "Scenarios whose `Expected:` records a missing or unassertable oracle. Not automation work and " +
        "not coverage at any level — the requirement has to be specified before a level applies.",
    );
    out.push("");
    out.push("| Scenario | Requirement | Expected |");
    out.push("|---|---|---|");
    for (const block of requirementGapBlocks) {
      const expected = (valueOf(block, "Expected") ?? "—").replace(/\|/g, "\\|");
      out.push(`| ${block.id} | ${valueOf(block, "Requirement") ?? "—"} | ${expected} |`);
    }
  }
  return out.join("\n");
}

if (emitLevels) {
  process.stdout.write(`${emitLevelsBlock()}\n`);
  process.exit(EXIT_CLEAN);
}

/**
 * The design as data.
 *
 * Everything below is already computed — it is what `--emit-summary` and `--emit-levels` render into
 * Markdown — and until now none of it was reachable except by reading those sections back out of the
 * document. So every consumer re-derived it from prose: the orchestrator counted `E2E API` scenarios by
 * hand at the gate that settles a whole stream, and each implementing step re-read the design to work
 * out which scenarios were its own. This emits the model instead.
 *
 * WHAT THIS IS NOT. It is a recount, exactly like the other two emit modes, and it inherits their one
 * hard rule: **a judgement is carried through, never derived.** `Levels:`, `Blocked by (top unknowns):`,
 * `E2E journeys:`, `Demoted by the minimum-set pass:` and `Folded by the minimum-set pass:` are the
 * five lines this script refuses to recompute, and nothing here recomputes them either. `folds_into`
 * is not one of them: which scenario a fold names is written in the document and read back, while
 * whether that fold was the right call is the judgement, and it lives on the carried line. Nor does the manifest rule on whether a level is
 * right, whether an oracle is sound or whether a scenario should exist — a clean structural pass is not
 * evidence about the models, and reading it as one is the mistake `TD-W01` exists to prevent.
 *
 * It carries `violations` and `warnings` too, so a consumer that reads the manifest cannot be reading a
 * document it has not also checked.
 */
function manifestBlock() {
  const scenarios = blocks.map((block) => {
    const levels = assignedLevelsOf(block);
    const notes = valueOf(block, "Notes") ?? "";
    return {
      id: block.id,
      title: block.title ?? null,
      requirements: [...(valueOf(block, "Requirement") ?? "").matchAll(/\b((?:FR-\d+\.\d+)|(?:AC-\d+))\b/g)]
        .map((m) => m[1])
        .filter((id, i, all) => all.indexOf(id) === i),
      category: valueOf(block, "Category"),
      technique: valueOf(block, "Technique"),
      coverage_items: citedItems(valueOf(block, "Coverage Item") ?? ""),
      priority: valueOf(block, "Priority"),
      suggested_level: valueOf(block, "Suggested Level"),
      assigned_levels: levels,
      // A pseudo-level, never a test layer: no assertable oracle, so it is not executable coverage at
      // any level and is excluded from every E2E figure on both sides.
      requirement_gap: levels.includes(REQUIREMENT_GAP),
      automation_suitability: valueOf(block, "Automation Suitability"),
      // An `unknown:` marker together with `Manual only` is the document saying this scenario asserts
      // nothing. It traces its requirement; it does not exercise its coverage items.
      gap_blocked: gapBlockedIds.has(block.id),
      // Which test runs this scenario. `folds_into` non-null means no test of its own — its
      // `Expected:` is asserted inside that scenario's test. `folds` is the same fact from the
      // covering side, so a consumer implementing one scenario does not have to scan the document
      // for who points at it.
      folds_into: foldTargetOf(block),
      folds: foldsByTarget.get(block.id) ?? [],
      unknown_markers: [...notes.matchAll(/unknown:\s*([^\n;]+)/gi)].map((m) => m[1].trim()),
      api_coverage: apiCoverageDecisionOf(block),
      line: block.line ?? null,
    };
  });

  const byLevel = {};
  for (const level of ASSIGNABLE_LEVELS) byLevel[level] = [...(scenariosByLevel.get(level) ?? [])];

  return {
    document: designPath,
    requirements: requirementsPath,
    // A recount, never a ruling. See the note above this function.
    scope: "structure_and_arithmetic_only",
    counts: {
      scenarios: blockCount,
      assigned: assignedBlocks.length,
      unassigned: unassignedBlocks.length,
      executable: executableBlocks.length,
      requirement_gaps: requirementGapBlocks.length,
      multi_level: multiLevelBlocks.length,
      overridden: overriddenBlocks.length,
      manual_only: manualOnly.length,
      automatable,
      gap_blocked: gapBlockedBlocks.length,
      folded: foldedBlocks.length,
    },
    // Tests, not scenarios — the count each implementing step selects on. A folded scenario keeps its
    // level and stays in `scenarios_by_level`; it simply does not open a second session to assert it.
    e2e_tests_implied: e2eTestsImplied,
    // **Every** scenario, not merely one. A gate reading this settles whole streams from
    // `scenarios_by_level`, and that map omits a block carrying no `Assigned Level:` line — so a
    // design where one scenario is unclassified would report `classified: true` and a level list with
    // that scenario silently missing. If the missing one were the only `E2E UI` scenario, the gate
    // would settle the UI stream `not_applicable` and its work would never be launched or missed.
    // `anyAssignment` is kept for the emit paths below, which describe a document rather than gate on
    // it; this field answers "is it safe to count levels from this?" and the honest answer needs all
    // of them.
    classified: unassignedBlocks.length === 0 && anyAssignment,
    implemented_levels: implementedLevels,
    scenarios_by_level: byLevel,
    handed_off: handedOffBlocks.map((b) => b.id),
    coverage_by_requirement: Object.fromEntries(coverageByRequirement),
    coverage_by_category: Object.fromEntries(coverageByCategory),
    techniques: techniqueCounts.map((t) => ({
      prefix: t.prefix,
      name: t.matrixName,
      items: t.items,
      exercised: t.exercised,
      traced_only: t.tracedOnly,
      traced_only_ids: t.tracedOnlyIds,
      uncovered: t.uncovered,
      percent: t.percent,
    })),
    scenarios,
    violations,
    warnings,
    skipped,
  };
}

if (emitManifest) {
  process.stdout.write(`${JSON.stringify(manifestBlock(), null, 2)}\n`);
  // The manifest is emitted whether or not the document lints clean — a consumer needs to see a broken
  // design's shape to know what is broken — but the exit code still reports the truth about it.
  process.exit(violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATIONS);
}

// --- --apply-summary / --apply-levels --------------------------------------
//
// The same arithmetic the emit modes print, written into the document instead. Only the counted
// sections are touched: every other byte of the file, including every scenario block, is carried
// through untouched. Nothing here rules on a violation — an apply run fixes arithmetic, it does not
// decide whether the document is sound, and the plain run still has to be clean before anyone
// trusts it.

const applying = applySummary || applyLevels;
const eol = /\r\n/.test(designText) ? "\r\n" : "\n";
const docLines = splitLines(designText);

/** Refuse to write, naming what is wrong. A partial rewrite is worse than no rewrite. */
function refuseApply(message) {
  process.stderr.write(`test-design-lint: cannot apply — ${message}\n`);
  process.exit(EXIT_UNPARSEABLE);
}

/** 1-based inclusive line range of a section: its heading through the line before the next one. */
function sectionRange(name) {
  const section = doc.sections.get(name);
  if (!section) return null;
  const next = doc.sectionOrder.find((h) => h.line > section.line);
  return { start: section.line, end: next ? next.line - 1 : docLines.length };
}

/** Replace a 1-based inclusive range in `lines` with `replacement`, keeping one blank separator. */
function spliceRange(lines, range, replacement) {
  const tail = lines.slice(range.end);
  const body = [...replacement];
  // A section that is not the last thing in the file keeps exactly one blank line after it.
  if (tail.length > 0 && body[body.length - 1] !== "") body.push("");
  return [...lines.slice(0, range.start - 1), ...body, ...tail];
}

const changed = [];

if (applySummary) {
  const emitted = splitLines(emitSummaryBlock());
  const matrixStart = emitted.findIndex((l) => l === "# Traceability Matrix");
  if (matrixStart < 0) refuseApply("the recomputed block carries no `# Traceability Matrix`");

  const summaryRange = sectionRange("Summary");
  const traceRange = sectionRange("Traceability Matrix");
  const coverageRange = sectionRange("Coverage Matrix");
  const techniqueRange = sectionRange("Technique Coverage Matrix");
  for (const [name, range] of [
    ["Summary", summaryRange],
    ["Traceability Matrix", traceRange],
    ["Coverage Matrix", coverageRange],
    ["Technique Coverage Matrix", techniqueRange],
  ]) {
    if (!range) refuseApply(`the document has no \`# ${name}\` section — write the section first, then recount it`);
  }
  if (!(traceRange.start < coverageRange.start && coverageRange.start < techniqueRange.start)) {
    refuseApply("the three matrix sections are out of contract order — fix TD-E01 first, then recount");
  }
  // The traceability matrix lists every requirement id, covered or not, and those ids come from the
  // requirements document. With neither that document nor an existing matrix to read them from, the
  // recount would quietly write `FR 0/0` — a full-coverage claim over nothing.
  if (requirementIds === null && !/^\|\s*(FR-\d+\.\d+|AC-\d+)\s*\|/m.test(sectionText(doc, "Traceability Matrix"))) {
    refuseApply("no `--requirements` path and an empty traceability matrix — there is nothing to take the requirement ids from");
  }

  const summaryText = emitted.slice(0, matrixStart).join("\n").replace(/\n+$/, "");
  const matrixText = emitted.slice(matrixStart).join("\n").replace(/\n+$/, "");
  const matrixRange = { start: traceRange.start, end: techniqueRange.end };

  let next = docLines;
  const wasMatrices = next.slice(matrixRange.start - 1, matrixRange.end).join("\n").replace(/\n+$/, "");
  const wasSummary = next.slice(summaryRange.start - 1, summaryRange.end).join("\n").replace(/\n+$/, "");
  // Later range first: splicing the summary would move every line number below it.
  next = spliceRange(next, matrixRange, splitLines(matrixText));
  next = spliceRange(next, summaryRange, splitLines(summaryText));

  if (wasSummary !== summaryText) changed.push("# Summary");
  if (wasMatrices !== matrixText) {
    changed.push("# Traceability Matrix", "# Coverage Matrix", "# Technique Coverage Matrix");
  }
  if (changed.length > 0) writeFileSync(designPath, next.join(eol), "utf8");
}

if (applyLevels) {
  if (!anyAssignment) {
    process.stdout.write(
      `APPLY: nothing to write — no scenario carries an \`Assigned Level:\` line, so the level arithmetic ` +
        `has not been done yet (${designPath} unchanged)\n`,
    );
    process.exit(EXIT_CLEAN);
  }

  const emitted = splitLines(emitLevelsBlock());
  const sectionStart = emitted.findIndex((l) => l === "# Level Assignment Summary");
  if (sectionStart < 0) refuseApply("the recomputed block carries no `# Level Assignment Summary`");
  const newLevelsLine = emitted[0];
  const newSectionText = emitted.slice(sectionStart).join("\n").replace(/\n+$/, "");

  const summaryRange = sectionRange("Summary");
  if (!summaryRange) refuseApply("the document has no `# Summary` section to carry the `Levels:` line");

  let next = docLines;

  // The section, first: it sits below `# Summary`, and appending moves nothing above it.
  const levelRange = sectionRange("Level Assignment Summary");
  const wasSection = levelRange
    ? next.slice(levelRange.start - 1, levelRange.end).join("\n").replace(/\n+$/, "")
    : null;
  if (levelRange) {
    if (wasSection !== newSectionText) {
      next = spliceRange(next, levelRange, splitLines(newSectionText));
      changed.push("# Level Assignment Summary");
    }
  } else {
    while (next.length > 0 && next[next.length - 1] === "") next.pop();
    next = [...next, "", ...splitLines(newSectionText), ""];
    changed.push("# Level Assignment Summary (appended)");
  }

  // Then the one line inside `# Summary` that this arithmetic owns.
  let levelsIdx = -1;
  for (let i = summaryRange.start - 1; i < summaryRange.end && i < next.length; i += 1) {
    if (/^Levels:/.test(next[i])) {
      levelsIdx = i;
      break;
    }
  }
  if (levelsIdx >= 0) {
    if (next[levelsIdx] !== newLevelsLine) {
      next[levelsIdx] = newLevelsLine;
      changed.push("# Summary (Levels:)");
    }
  } else {
    let scenariosIdx = -1;
    for (let i = summaryRange.start - 1; i < summaryRange.end && i < next.length; i += 1) {
      if (/^Scenarios:/.test(next[i])) scenariosIdx = i;
    }
    if (scenariosIdx < 0) refuseApply("`# Summary` has neither a `Levels:` line to replace nor a `Scenarios:` line to write one after");
    next.splice(scenariosIdx + 1, 0, newLevelsLine);
    changed.push("# Summary (Levels: inserted)");
  }

  if (changed.length > 0) writeFileSync(designPath, next.join(eol), "utf8");
}

if (applying) {
  if (changed.length === 0) {
    process.stdout.write(`APPLY: no change — ${designPath} already matches the recount\n`);
  } else {
    for (const section of changed) process.stdout.write(`APPLY: rewrote ${section}\n`);
    process.stdout.write(`APPLY: ${changed.length} section(s) rewritten in ${designPath}\n`);
  }
  process.exit(EXIT_CLEAN);
}

// --- report ----------------------------------------------------------------

const CODE_ORDER = (v) => v.code;
violations.sort((a, b) => CODE_ORDER(a).localeCompare(CODE_ORDER(b)) || String(a.subject).localeCompare(String(b.subject)));

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ document: designPath, requirements: requirementsPath, violations, warnings, skipped }, null, 2)}\n`,
  );
  process.exit(violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATIONS);
}

const width = Math.max(0, ...violations.map((v) => String(v.subject).length), ...warnings.map((v) => String(v.subject).length));
const render = (v) =>
  `${String(v.subject).padEnd(width)}  [${v.code}]  ${v.message}${v.line ? `  (${designPath}:${v.line})` : ""}`;

if (violations.length === 0) {
  process.stdout.write(`LINT: clean — ${blockCount} scenarios, 0 violations\n`);
} else {
  for (const v of violations) process.stdout.write(`${render(v)}\n`);
  process.stdout.write(`\nLINT: ${violations.length} violation(s) in ${designPath}\n`);
}

if (warnings.length > 0) {
  process.stdout.write("\nJudgement required (not violations):\n");
  for (const w of warnings) process.stdout.write(`${render(w)}\n`);
}

if (skipped.length > 0) {
  process.stdout.write("\nSkipped:\n");
  for (const s of skipped) process.stdout.write(`  ${s}\n`);
}

process.exit(violations.length === 0 ? EXIT_CLEAN : EXIT_VIOLATIONS);
