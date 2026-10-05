#!/usr/bin/env node
/**
 * workflow-state.mjs — deterministic checks over one QA workflow state file.
 *
 * `.workflow/<TICKET-ID>.yaml` is the resume contract: the orchestrator writes it after every step,
 * and the next delegation is parameterised from it. A field that silently loses its value therefore
 * does not fail loudly — it re-runs a reviewer in full-review mode, or hands an implementer an
 * unscoped revision, at full token cost and with nothing in the transcript to say why.
 *
 * That is not hypothetical. `.workflow/SCRUM-132.yaml` carried `test_design.last_findings` twice:
 * once holding an 1800-character routing block, once holding `null`. YAML is last-wins, so every
 * consumer read `null` and a whole review loop ran without the findings it was routing on.
 *
 * This script turns that class of defect from silent data loss into a loud failure at the next step.
 *
 * Usage:
 *   node scripts/workflow-state.mjs validate        <TICKET-ID|path> [--json] [--strict] [--metrics <p>]
 *   node scripts/workflow-state.mjs get             <TICKET-ID|path> <dotted.path> [--json]
 *   node scripts/workflow-state.mjs check-artifacts  <TICKET-ID|path> [--json] [--root <dir>]
 *   node scripts/workflow-state.mjs check-streams   <TICKET-ID|path> [--json] [--design <path>]
 *   node scripts/workflow-state.mjs print-schema    [--json | --markdown]
 *   node scripts/workflow-state.mjs init            <TICKET-ID|path> [--set <path>=<value>]...
 *   node scripts/workflow-state.mjs set             <TICKET-ID|path> <path>=<value>... [--allow-unknown]
 *   node scripts/workflow-state.mjs set-block       <TICKET-ID|path> <path> --from-stdin | --from-file <p>
 *   node scripts/workflow-state.mjs append          <TICKET-ID|path> <path> --json '<json>' [--dedupe]
 *   node scripts/workflow-state.mjs clear-in-flight <TICKET-ID|path> [--agent <name>] [--step <id>]
 *   node scripts/workflow-state.mjs normalize       <TICKET-ID|path>
 *   node scripts/workflow-state.mjs reset           <TICKET-ID|path> --reason <why> [--dry-run]
 *
 * A bare ticket id resolves to `.workflow/<TICKET-ID>.yaml` under the repository root; anything else
 * is taken as a path, so a fixture or a scratch copy can be checked directly.
 *
 * THE WRITE COMMANDS EXIST SO THE ORCHESTRATOR STOPS HAND-WRITING YAML. Every one of them re-emits
 * the whole document from the parsed model, atomically, and is idempotent by value: a `set` writing
 * what is already there prints `unchanged` and does not touch mtime, and `init` over an existing file
 * prints `EXISTS` and changes nothing. `set-block --from-stdin` is how a multi-line findings block
 * reaches the file without passing through shell quoting.
 *
 * `reset` is the one command that moves a run backwards, and the only one that touches a file other
 * than the state file. It archives by rename — never by deletion — and re-initialises, because the
 * alternative was already happening at a shell prompt three times over.
 *
 * Exit codes:
 *   0  clean, or warnings only; a write that happened, and a write that was already satisfied
 *   1  violations found, or a write refused over a document with duplicate keys; WS-E41, a rename
 *      that failed part-way through a reset
 *   2  usage error, or a write to a path the schema does not define without --allow-unknown; WS-E40,
 *      a reset with no free archive name left
 *   3  the file is missing, or holds a YAML construct this parser refuses to guess at
 *   4  check-artifacts only: the document is fine and a path it names is gone from disk
 *
 * ERRORS ARE STRUCTURE; WARNINGS ARE DRIFT. A duplicate key, an unknown enum value or a missing
 * required key is an error: some consumer will read the wrong thing. An *unknown* key is only a
 * warning, because the orchestrator demonstrably needs fields the schema lacks and erroring would
 * push it back to hand-writing the file — the very failure being removed. `--strict` promotes the
 * warnings, and the test suite runs `--strict` against the fixtures, so schema and fixtures cannot
 * drift apart quietly. The designated home for a field the schema has no opinion on is a `notes:`
 * map, at the top level or inside a section; nothing under `notes.` is ever reported as unknown.
 *
 * WHAT THIS SCRIPT DOES NOT DECIDE. It never rules on whether a routing decision was right, whether
 * a verdict was read correctly, whether an iteration should have been spent, or whether the prose in
 * `last_findings` says anything useful. It checks that the file means what it appears to mean.
 */

import {
  readFileSync,
  existsSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
} from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const TICKET_RE = /^[A-Z][A-Z0-9]+-\d+$/;

/**
 * The status values, in one place. The metrics hook needs the run-level set to decide which state
 * file belongs to a live run; keeping its regex in step with this list is what a shared export is
 * for. `escalated` and `blocked` are live states — a run standing on one has not gone anywhere.
 */
export const ENUMS = {
  phase: ["test_design", "test_automation", "ship", "done"],
  status: ["in_progress", "paused", "escalated", "blocked", "declined", "completed"],
  mode: ["manual", "auto"],
  /**
   * What auto mode does when an unapproved unknown leaves an in-scope requirement with no
   * automatable coverage at all. `escalate` is the default and the historical behaviour: the run
   * stops and names the requirement. `continue` relaxes it for requirements whose coverage is
   * alternative-flow only — never for a main flow, which stops the run under either value.
   */
  blocked_alternative_flow: ["escalate", "continue"],
  /**
   * What auto mode does at the gate between design and automation when the design wants API
   * coverage and no API surface was ever mapped. `escalate` is the default and the stopping
   * behaviour: the run halts and names the feature-to-endpoint mapping a human must confirm.
   * `ignore` settles the API stream as `not_applicable` and prints the consequence. Like the
   * setting above it approves nothing — it only decides whether a human is fetched now.
   */
  missing_api_surface: ["escalate", "ignore"],
  /**
   * `approved_with_open_findings` is what reaching `max_design_iterations` produces: the design is
   * good enough to implement and the review still has open Majors, whose ids go to
   * `test_design.open_questions` and into the pull-request body. It is a distinct state rather than
   * `approved`, because a reader who cannot tell the two apart cannot tell a design nobody
   * criticised from one whose criticism nobody answered.
   */
  design_status: ["pending", "generated", "classified", "approved", "approved_with_open_findings"],
  review_status: ["pending", "passed", "needs_revision", "blocked"],
  stream_status: [
    "pending",
    "not_applicable",
    "implemented",
    "review_in_progress",
    "passed",
    "needs_revision",
    "blocked",
  ],
  handback_status: ["pending", "done", "skipped", "partial", "failed"],
  comment_status: ["pending", "added", "already_present", "skipped"],
  final_decision: [
    "pending",
    "accept",
    "request_revision",
    "escalate",
    "block",
    "decline",
    "continue",
  ],
  surface_status: ["mapped", "partial", "none", "ignored", "absent"],
  surface_provenance: ["openapi", "user-supplied", "mixed", "none", "ignored"],
};

/** The states a state file is in when its run is still standing somewhere. */
export const LIVE_STATUSES = ["in_progress", "paused", "escalated", "blocked"];

const stream = (name) => ({
  type: "map",
  required: true,
  doc: `the ${name} automation stream`,
  children: {
    status: { type: "enum", values: ENUMS.stream_status, required: true },
    not_applicable_reason: {
      type: "scalar",
      doc: "required whenever status is not_applicable — a settled stream with no stated reason is indistinguishable from a forgotten one",
    },
    report: { type: "scalar", doc: "path to the implementation report" },
    implemented_scenarios: { type: "seq" },
    created_tests: { type: "seq" },
    review_status: { type: "enum", values: ENUMS.review_status, required: true },
    last_findings: {
      type: "scalar",
      doc: "the reviewer's own previous block, fed back as previous_findings",
    },
    notes: { type: "free" },
  },
});

const SCHEMA = {
  ticket_id: { type: "scalar", required: true },
  phase: { type: "enum", values: ENUMS.phase, required: true },
  status: { type: "enum", values: ENUMS.status, required: true },
  mode: { type: "enum", values: ENUMS.mode, required: true },
  current_step: { type: "scalar", required: true },

  configuration: {
    type: "map",
    required: true,
    children: {
      review_requirements: { type: "scalar" },
      non_e2e_coverage_strategy: { type: "scalar" },
      max_review_iterations: { type: "int" },
      max_design_iterations: {
        type: "int",
        doc: "the design review's own cap, separate from the code reviews' because the two loops converge differently; on reaching it the design is approved_with_open_findings and the open ids travel to the pull request",
      },
      batch_threshold: { type: "int" },
      batch_size: { type: "int" },
      jira_target_status: { type: "scalar" },
      on_blocked_alternative_flow: {
        type: "enum",
        values: ENUMS.blocked_alternative_flow,
        doc: "auto mode only — continue relaxes the no-coverage escalation for alternative-flow requirements, never for a main flow",
      },
      on_missing_api_surface: {
        type: "enum",
        values: ENUMS.missing_api_surface,
        doc: "auto mode only — what the automation gate does when the design wants API coverage and no surface was mapped; ignore settles the API stream as not_applicable instead of stopping the run",
      },
      notes: { type: "free" },
    },
  },

  iterations: {
    type: "map",
    required: true,
    doc: "one counter per review loop, never shared",
    children: {
      design: { type: "int", required: true },
      api: { type: "int", required: true },
      ui: { type: "int", required: true },
    },
  },

  artifacts: {
    type: "map",
    required: true,
    children: {
      requirements: { type: "scalar" },
      test_design: { type: "scalar" },
      metrics: { type: "scalar", doc: "written by the hook, not by the orchestrator" },
      api_surface: {
        type: "map",
        children: {
          status: { type: "enum", values: ENUMS.surface_status },
          provenance: { type: "enum", values: ENUMS.surface_provenance },
          match_basis: { type: "scalar" },
          matched_operations: { type: "int" },
          spec_gaps: { type: "int" },
          decided_by: { type: "scalar" },
          decided_at: { type: "scalar" },
        },
      },
      notes: { type: "free" },
    },
  },

  test_design: {
    type: "map",
    required: true,
    children: {
      status: { type: "enum", values: ENUMS.design_status, required: true },
      review_status: { type: "enum", values: ENUMS.review_status, required: true },
      batches: { type: "seq" },
      open_questions: { type: "seq" },
      last_findings: {
        type: "scalar",
        doc: "the reviewer's own previous block, fed back as previous_findings",
      },
      unapproved_unknowns: { type: "seq" },
      blocked_scenarios: { type: "seq" },
      approved_assumptions: { type: "seq" },
      notes: { type: "free" },
    },
  },

  automation: {
    type: "map",
    required: true,
    children: { api: stream("API"), ui: stream("UI"), notes: { type: "free" } },
  },

  in_flight: {
    type: "seq",
    doc: "written immediately before a delegation, cleared on the receipt; a list, because two streams launch together",
  },
  pull_request: { type: "scalar", doc: "the PR_URL off the ship receipt" },
  jira: {
    type: "map",
    children: {
      status: { type: "scalar" },
      handback_status: { type: "enum", values: ENUMS.handback_status },
      comment: { type: "enum", values: ENUMS.comment_status },
    },
  },
  follow_up_tickets: { type: "seq" },
  requirement_gaps: { type: "seq" },
  final_decision: { type: "enum", values: ENUMS.final_decision, required: true },
  declined: {
    type: "map",
    children: {
      at_step: { type: "scalar" },
      question: { type: "scalar" },
      reason: { type: "scalar", doc: "the user's own words — never a paraphrase" },
    },
  },
  history: { type: "seq", required: true },
  notes: { type: "free" },
};

// ---------------------------------------------------------------------------------------------
// A deliberately small YAML subset.
//
// This parser only ever reads documents written against the schema above. Rather than accept YAML
// and guess, it accepts the constructs the schema uses and refuses the rest with WS-E90. Refusing
// is the safe direction: a construct nobody writes cannot be silently mis-read.
//
// Supported: 2-space block mappings; block sequences of scalars and of flow mappings (which may
// span lines); plain, single- and double-quoted scalars; `|` and `|-` block literals; `#` comments.
// Not supported: anchors, aliases, tags, multiple documents, `?` complex keys, `>` folded scalars.
// ---------------------------------------------------------------------------------------------

const KEY_RE = /^([A-Za-z_][A-Za-z0-9_-]*):(?:[ \t](.*))?$/;

/** Strip a trailing ` # comment`, but only when the `#` is outside quotes and flow punctuation. */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "#" && (i === 0 || /\s/.test(text[i - 1]))) return text.slice(0, i).trimEnd();
  }
  return text.trimEnd();
}

/** Flow depth delta for one line, ignoring bracket characters inside quotes. */
function flowDelta(text) {
  let quote = null;
  let depth = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== "\\") quote = null;
      continue;
    }
    if (ch === '"' || ch === "'") quote = ch;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") depth -= 1;
  }
  return depth;
}

class Parser {
  constructor(text) {
    this.raw = text.split("\n").map((l) => l.replace(/\r$/, ""));
    this.i = 0;
    this.fatal = null;
    // Layout carried through a write: the comment lines and the blank line that preceded the entry
    // about to be consumed. `validate` ignores both; the emitter needs them, because a re-emit that
    // dropped every comment would make `normalize` a destructive command nobody would run.
    this.pendingComments = [];
    this.pendingBlank = false;
  }

  /** The layout collected since the last entry, handed to whichever entry consumes next. */
  takeLead() {
    const lead = { comments: this.pendingComments, blankBefore: this.pendingBlank };
    this.pendingComments = [];
    this.pendingBlank = false;
    return lead;
  }

  /** The next line that carries content, as `{ n, indent, text }`, or null at end of input. */
  peek() {
    while (this.i < this.raw.length) {
      const line = this.raw[this.i];
      if (line.trim() === "") {
        this.pendingBlank = true;
        this.i += 1;
        continue;
      }
      if (line.trimStart().startsWith("#")) {
        this.pendingComments.push(line.trimStart());
        this.i += 1;
        continue;
      }
      if (/^\s*\t/.test(line)) {
        this.fail(this.i + 1, "tab in indentation");
        return null;
      }
      const indent = line.length - line.trimStart().length;
      return { n: this.i + 1, indent, text: line.slice(indent) };
    }
    return null;
  }

  fail(line, what) {
    if (!this.fatal) this.fatal = { line, what };
    this.i = this.raw.length;
  }

  /**
   * Consume a value that opens a flow collection and may not close on this line. Returns the joined
   * text. A history entry written as a two-line `{ ... }` is the reason this exists.
   */
  consumeFlow(first) {
    const start = this.i;
    let depth = flowDelta(first);
    let text = first;
    this.i += 1;
    while (depth > 0 && this.i < this.raw.length) {
      const next = stripComment(this.raw[this.i]);
      text += ` ${next.trim()}`;
      depth += flowDelta(next);
      this.i += 1;
    }
    // The source lines verbatim, so a wrapped `history` entry nobody touched survives a re-emit
    // unwrapped-and-rewrapped. Only entries the write path replaces lose their original layout.
    const srcLines = this.i - start > 1 ? this.raw.slice(start, this.i) : null;
    return { text, srcLines };
  }

  /**
   * A `|` literal or `>` folded scalar: every following line indented past the key. Both forms are
   * in live use — `last_findings` is written as a literal, the escalation prose in SCRUM-115 as a
   * folded one — so both are read rather than refused.
   */
  consumeBlockScalar(style, chomp, keyIndent) {
    this.i += 1;
    const lines = [];
    let bodyIndent = null;
    while (this.i < this.raw.length) {
      const line = this.raw[this.i].replace(/\r$/, "");
      if (line.trim() === "") {
        lines.push("");
        this.i += 1;
        continue;
      }
      const indent = line.length - line.trimStart().length;
      if (indent <= keyIndent) break;
      if (bodyIndent === null) bodyIndent = indent;
      lines.push(line.slice(Math.min(bodyIndent, indent)));
      this.i += 1;
    }
    while (lines.length && lines[lines.length - 1] === "") lines.pop();

    let body;
    if (style === "|") {
      body = lines.join("\n");
    } else {
      // Folded: a run of non-blank lines joins with a space; a blank line is one newline.
      body = lines
        .reduce((acc, line) => {
          if (line === "") acc.push([]);
          else acc[acc.length - 1].push(line.trim());
          return acc;
        }, [[]])
        .map((paragraph) => paragraph.join(" "))
        .join("\n");
    }
    return chomp === "-" ? body : `${body}\n`;
  }

  parseMap(indent) {
    const node = { kind: "map", entries: [], byKey: new Map(), line: this.peek()?.n ?? 0 };
    for (;;) {
      const cur = this.peek();
      if (!cur || cur.indent < indent) break;
      if (cur.indent > indent) {
        this.fail(cur.n, `unexpected indentation (expected ${indent} spaces)`);
        break;
      }
      if (cur.text.startsWith("- ")) break;

      const m = cur.text.match(KEY_RE);
      if (!m) {
        this.fail(cur.n, `not a mapping entry: ${cur.text.slice(0, 40)}`);
        break;
      }
      const key = m[1];
      const rest = m[2] === undefined ? "" : stripComment(m[2]).trim();
      const lead = this.takeLead();

      let value;
      const blockScalar = rest.match(/^([|>])([-+]?)$/);
      if (blockScalar) {
        value = {
          kind: "scalar",
          raw: this.consumeBlockScalar(blockScalar[1], blockScalar[2], indent),
          line: cur.n,
          block: true,
        };
      } else if (rest === "") {
        this.i += 1;
        const child = this.peek();
        if (child && child.indent > indent) {
          value = child.text.startsWith("- ") ? this.parseSeq(child.indent) : this.parseMap(child.indent);
        } else {
          value = { kind: "scalar", raw: "null", line: cur.n, bare: true };
        }
      } else if ((rest.startsWith("{") || rest.startsWith("[")) && flowDelta(rest) > 0) {
        const flow = this.consumeFlow(rest);
        value = { kind: "scalar", raw: flow.text, srcLines: flow.srcLines, line: cur.n, flow: true };
      } else {
        this.i += 1;
        value = { kind: "scalar", raw: rest, line: cur.n, flow: rest.startsWith("{") || rest.startsWith("[") };
      }
      if (this.fatal) break;

      node.entries.push({ key, value, line: cur.n, ...lead });
      if (node.byKey.has(key)) node.byKey.get(key).push(cur.n);
      else node.byKey.set(key, [cur.n]);
    }
    return node;
  }

  parseSeq(indent) {
    const node = { kind: "seq", items: [], line: this.peek()?.n ?? 0 };
    for (;;) {
      const cur = this.peek();
      if (!cur || cur.indent < indent || !cur.text.startsWith("- ")) break;
      const rest = stripComment(cur.text.slice(2)).trim();
      const line = cur.n;
      const lead = this.takeLead();
      if ((rest.startsWith("{") || rest.startsWith("[")) && flowDelta(rest) > 0) {
        const flow = this.consumeFlow(rest);
        node.items.push({ kind: "scalar", raw: flow.text, srcLines: flow.srcLines, line, flow: true, ...lead });
      } else {
        this.i += 1;
        node.items.push({ kind: "scalar", raw: rest, line, flow: rest.startsWith("{"), ...lead });
      }
      if (this.fatal) break;
    }
    return node;
  }
}

/** `{ root, fatal }` — `root` is a map node, `fatal` a refusal to guess. */
export function parseStateYaml(text) {
  const parser = new Parser(text);
  const first = parser.peek();
  const root = first ? parser.parseMap(first.indent) : { kind: "map", entries: [], byKey: new Map(), line: 0 };
  // Whatever the loop swallowed after the last entry is a trailing comment block, not a lost line.
  root.trailingComments = parser.pendingComments;
  root.eol = text.includes("\r\n") ? "\r\n" : "\n";
  return { root, fatal: parser.fatal };
}

/** The scalar text of a node, unquoted; `null` for a YAML null or an absent node. */
function scalarValue(node) {
  if (!node || node.kind !== "scalar") return null;
  const raw = node.raw;
  if (node.block) return raw;
  if (raw === "" || raw === "null" || raw === "~") return null;
  const quoted = raw.match(/^"([\s\S]*)"$/) || raw.match(/^'([\s\S]*)'$/);
  return quoted ? quoted[1] : raw;
}

function lookup(node, segments) {
  let cur = node;
  for (const segment of segments) {
    if (!cur || cur.kind !== "map") return null;
    const entry = [...cur.entries].reverse().find((e) => e.key === segment);
    if (!entry) return null;
    cur = entry.value;
  }
  return cur;
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

class Report {
  constructor() {
    this.items = [];
  }
  err(code, subject, message, line) {
    this.items.push({ severity: "error", code, subject, message, line });
  }
  warn(code, subject, message, line) {
    this.items.push({ severity: "warning", code, subject, message, line });
  }
  get errors() {
    return this.items.filter((i) => i.severity === "error");
  }
  get warnings() {
    return this.items.filter((i) => i.severity === "warning");
  }
}

function walk(node, schema, prefix, report) {
  if (!node || node.kind !== "map") return;

  // WS-E01 — the SCRUM-132 defect. YAML is last-wins, so the earlier value is simply gone.
  for (const [key, lines] of node.byKey) {
    if (lines.length > 1) {
      report.err(
        "WS-E01",
        prefix ? `${prefix}.${key}` : key,
        `duplicate key — defined at line ${lines[0]}, again at line ${lines.slice(1).join(", ")}. ` +
          `YAML keeps the last value, so every earlier one is lost`,
        lines[lines.length - 1],
      );
    }
  }

  for (const entry of node.entries) {
    const dotted = prefix ? `${prefix}.${entry.key}` : entry.key;
    const field = schema?.[entry.key];

    if (!field) {
      report.warn(
        "WS-W10",
        dotted,
        `key is not in the schema. Fields the schema has no opinion on belong under a 'notes:' map ` +
          `(for example ${prefix ? `${prefix}.notes` : "notes"}.${entry.key})`,
        entry.line,
      );
      continue;
    }
    if (field.type === "free") continue;

    if (field.type === "map") {
      if (entry.value.kind === "map") walk(entry.value, field.children, dotted, report);
      else if (scalarValue(entry.value) !== null && !entry.value.flow) {
        report.err("WS-E20", dotted, `expected a mapping, found a scalar`, entry.line);
      }
      continue;
    }
    if (field.type === "seq") {
      // A block sequence, a flow sequence on one line, or an explicit null — all three are a list.
      const isFlowSeq = entry.value.kind === "scalar" && entry.value.raw.startsWith("[");
      if (entry.value.kind !== "seq" && !isFlowSeq && scalarValue(entry.value) !== null) {
        report.err("WS-E20", dotted, `expected a sequence, found a scalar`, entry.line);
      }
      continue;
    }

    const value = scalarValue(entry.value);
    if (field.type === "enum" && value !== null && !field.values.includes(value)) {
      report.err(
        "WS-E21",
        dotted,
        `"${value}" is not a permitted value. One of: ${field.values.join(", ")}`,
        entry.line,
      );
    }
    if (field.type === "int" && value !== null && !/^-?\d+$/.test(value)) {
      report.err("WS-E20", dotted, `expected an integer, found "${value}"`, entry.line);
    }
  }

  for (const [key, field] of Object.entries(schema ?? {})) {
    if (field.required && !node.byKey.has(key)) {
      report.err(
        "WS-E10",
        prefix ? `${prefix}.${key}` : key,
        `required key is missing`,
        node.line,
      );
    }
  }
}

/** The conditional rules — the ones that read two fields against each other. */
function crossChecks(root, report, metricsRecords) {
  const get = (dotted) => scalarValue(lookup(root, dotted.split(".")));
  const lineOf = (dotted) => lookup(root, dotted.split("."))?.line ?? 0;

  for (const name of ["api", "ui"]) {
    if (get(`automation.${name}.status`) === "not_applicable" && !get(`automation.${name}.not_applicable_reason`)) {
      report.err(
        "WS-E30",
        `automation.${name}`,
        `status is not_applicable with no not_applicable_reason. A settled stream with nothing ` +
          `behind it is indistinguishable from a stream that was forgotten`,
        lineOf(`automation.${name}.status`),
      );
    }
  }

  if (get("status") === "declined") {
    for (const field of ["at_step", "question", "reason"]) {
      if (!get(`declined.${field}`)) {
        report.err(
          "WS-E31",
          `declined.${field}`,
          `status is declined, so this must be filled in`,
          lineOf("declined") || lineOf("status"),
        );
      }
    }
  }

  if (get("phase") === "done" && get("jira.handback_status") === "pending") {
    report.err(
      "WS-E32",
      "jira.handback_status",
      `the run is done but the hand-back never resolved. A hand-back that failed is recorded as ` +
        `failed or skipped, never left pending`,
      lineOf("jira.handback_status"),
    );
  }

  // Two caps, because the two loops converge differently: a code review's findings are answered by
  // editing the file it names, while a design review's are answered by regenerating a document
  // whose next version invites new findings. `max_design_iterations` falls back to the shared cap
  // for a document written before it existed.
  // `Number(null)` is 0 and `Number(undefined)` is NaN, so an absent key has to be tested before it
  // is coerced — otherwise a document predating this setting reports a cap of zero and fails on its
  // first review round.
  const asCap = (path) => {
    const raw = get(path);
    if (raw === null || raw === undefined || raw === "") return NaN;
    return Number(raw);
  };
  const codeCap = asCap("configuration.max_review_iterations");
  const declaredDesignCap = asCap("configuration.max_design_iterations");
  const designCap = Number.isFinite(declaredDesignCap) ? declaredDesignCap : codeCap;
  const caps = { design: designCap, api: codeCap, ui: codeCap };
  for (const [counter, cap] of Object.entries(caps)) {
    if (!Number.isFinite(cap)) continue;
    const spent = Number(get(`iterations.${counter}`));
    if (Number.isFinite(spent) && spent > cap) {
      report.err(
        "WS-E33",
        `iterations.${counter}`,
        `${spent} review rounds spent against a cap of ${cap}. Reaching the cap is legal; passing it is not`,
        lineOf(`iterations.${counter}`),
      );
    }
  }

  const pr = get("pull_request");
  const phase = get("phase");
  if (pr && pr !== "none" && phase && !["ship", "done"].includes(phase)) {
    report.err(
      "WS-E34",
      "pull_request",
      `a pull request is recorded while phase is "${phase}"`,
      lineOf("pull_request"),
    );
  }

  // WS-E35 — a stream that never settled, in a document that says the run reached the ship phase.
  //
  // The ship step's own precondition is that both stream reviews passed, and it reads an unknown
  // verdict as "not passed" — so this is not the last line of defence, it is the early one. The
  // difference is where the drift becomes visible: caught here, the document is wrong before the
  // ship delegation is made; caught there, a run has already been routed on a false premise. Only
  // two statuses are shippable. `passed` is a stream that finished its review; `not_applicable` is
  // a stream that was settled at the automation gate and carries the reason WS-E30 demands. Every
  // other value says the stream was still in flight, or that its review asked for changes nobody
  // made — neither of which is a state a pull request may be opened from.
  const shippablePhase = ["ship", "done"].includes(get("phase"));
  for (const name of ["api", "ui"]) {
    const streamStatus = get(`automation.${name}.status`);
    if (!shippablePhase || !streamStatus || ["passed", "not_applicable"].includes(streamStatus)) continue;
    const never = ["pending", "implemented", "review_in_progress"].includes(streamStatus);
    report.err(
      "WS-E35",
      `automation.${name}.status`,
      `phase is "${get("phase")}" with the ${name.toUpperCase()} stream at "${streamStatus}". ` +
        (never
          ? `The stream never finished its review, so nothing settled it — a run reaches the ship ` +
            `phase with both streams passed or not_applicable, never with one still in flight`
          : `The stream's review did not pass, so it is not shippable. A stream settled against ` +
            `shipping is fixed and re-reviewed, or the run stops; the phase does not move past it`),
      lineOf(`automation.${name}.status`),
    );
  }

  // WS-W20 — cost figures with no provenance. `SKILL.md` forbids inventing one, and a reader cannot
  // tell a correctly transcribed number from an invented one, so a `history` entry that carries a
  // cost has to name the metrics-log row it was copied from: `metrics_seq: <seq>`, whose `agent`
  // must match. The earlier form of this check counted rows per agent name and let the nth claim
  // for an agent pass on the strength of any nth row — a figureless background launch counted as
  // backing for a duration somebody typed in from a notification.
  const history = lookup(root, ["history"]);
  if (history?.kind === "seq" && metricsRecords !== null) {
    const bySeq = new Map();
    for (const record of metricsRecords) {
      if (typeof record?.seq === "number") bySeq.set(record.seq, record);
    }
    const CLAIM = /\b(tokens|duration_s|tool_uses|api_calls|cost_usd):\s*[\d$]/;
    for (const item of history.items) {
      if (!CLAIM.test(item.raw)) continue;
      const agent = item.raw.match(/\bagent:\s*([A-Za-z0-9_-]+)/)?.[1] ?? "unknown";
      const seqMatch = item.raw.match(/\bmetrics_seq:\s*(\d+)/);
      if (!seqMatch) {
        report.warn(
          "WS-W20",
          agent,
          `history entry carries a cost figure without a metrics_seq naming the metrics-log row it was ` +
            `copied from. A cost nobody measured cannot be told apart from one somebody estimated`,
          item.line,
        );
        continue;
      }
      const seq = Number(seqMatch[1]);
      const row = bySeq.get(seq);
      if (!row) {
        report.warn(
          "WS-W20",
          agent,
          `history entry carries a cost figure with metrics_seq ${seq}, and the metrics log has no row ${seq}`,
          item.line,
        );
      } else if (row.agent && row.agent !== agent) {
        report.warn(
          "WS-W20",
          agent,
          `history entry carries a cost figure with metrics_seq ${seq}, but row ${seq} is a ${row.agent} ` +
            `run, not a ${agent} run`,
          item.line,
        );
      }
    }
  }
}

/** Read `.workflow/metrics/<TICKET>.jsonl`, or `null` when there is nothing to compare against. */
function readMetrics(metricsPath) {
  if (!metricsPath || !existsSync(metricsPath)) return [];
  try {
    return readFileSync(metricsPath, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return null;
  }
}

export function validateState(text, { metricsRecords = [] } = {}) {
  const { root, fatal } = parseStateYaml(text);
  if (fatal) return { fatal, report: new Report() };
  const report = new Report();
  walk(root, SCHEMA, "", report);
  crossChecks(root, report, metricsRecords);
  return { root, report };
}

// ---------------------------------------------------------------------------------------------
// The write path
//
// `validate` is containment: it stops a malformed file surviving to the next delegation, which was
// the whole of the SCRUM-132 harm. It does not stop one being written. These commands do, and the
// mechanism is the emitter below rather than a rule anybody has to remember.
//
// EVERY WRITE RE-EMITS THE WHOLE DOCUMENT from the parsed model. No code path inserts, appends to or
// patches a line, so a duplicate key is structurally impossible to produce rather than merely
// reported afterwards. What the emitter does not own, it copies: an entry nobody touched is written
// back from its original source text — its quoting, its flow wrapping, its comments and the blank
// line above it — so a `set` of one field produces a one-field diff and `normalize` on a clean file
// is a no-op.
// ---------------------------------------------------------------------------------------------

/** A value that cannot survive as a plain or quoted scalar on one line. */
function needsBlock(value) {
  return value.includes("\n") || value.length > 200 || /^\s|\s$/.test(value);
}

/** `null`, or the YAML text of a one-line scalar: plain where that is unambiguous, else quoted. */
function formatInlineScalar(value) {
  if (value === null || value === undefined) return "null";
  const text = String(value);
  if (text === "") return '""';
  if (/^(null|true|false|~|-?\d+(\.\d+)?)$/.test(text)) return text;
  // Plain is safe only for text with no indicator character anywhere and no edge whitespace.
  if (/^[A-Za-z0-9_][A-Za-z0-9 _./@+-]*$/.test(text) && !/\s$/.test(text)) return text;
  return JSON.stringify(text);
}

/** A scalar node for `value`, as a block literal when one line cannot hold it honestly. */
function scalarNode(value) {
  if (value === null || value === undefined) return { kind: "scalar", raw: "null" };
  const text = String(value);
  if (needsBlock(text)) return { kind: "scalar", raw: text, block: true };
  return { kind: "scalar", raw: formatInlineScalar(text) };
}

/**
 * A JSON value as YAML flow text — the form `history` and `in_flight` entries are written in.
 * JSON carries types, so they are kept: the string `"1.1"` is quoted, the number `1.1` is not.
 */
function formatFlow(value) {
  if (value === null) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (typeof value === "string") {
    return /^(null|true|false|~|-?\d+(\.\d+)?)$/.test(value) ? JSON.stringify(value) : formatInlineScalar(value);
  }
  if (Array.isArray(value)) return `[${value.map(formatFlow).join(", ")}]`;
  const pairs = Object.entries(value).map(([k, v]) => `${k}: ${formatFlow(v)}`);
  return `{ ${pairs.join(", ")} }`;
}

function emitScalar(key, node, pad, lines) {
  if (node.srcLines) {
    lines.push(...node.srcLines);
    return;
  }
  if (node.block) {
    // Chomp is derived from the value, never carried: `|-` unless the value really ends in newline.
    const keep = node.raw.endsWith("\n");
    const body = keep ? node.raw.slice(0, -1) : node.raw;
    lines.push(`${pad}${key}: ${keep ? "|" : "|-"}`);
    for (const line of body.split("\n")) lines.push(line === "" ? "" : `${pad}  ${line}`);
    return;
  }
  if (node.bare || node.raw === "") lines.push(`${pad}${key}:`);
  else lines.push(`${pad}${key}: ${node.raw}`);
}

function emitSeq(node, indent, lines) {
  const pad = " ".repeat(indent);
  for (const item of node.items) {
    if (item.blankBefore && lines.length) lines.push("");
    for (const comment of item.comments ?? []) lines.push(pad + comment);
    if (item.srcLines) lines.push(...item.srcLines);
    else lines.push(`${pad}- ${item.raw}`);
  }
}

function emitMap(node, indent, lines) {
  const pad = " ".repeat(indent);
  for (const entry of node.entries) {
    if (entry.blankBefore && lines.length) lines.push("");
    for (const comment of entry.comments ?? []) lines.push(pad + comment);
    const value = entry.value;
    if (value.kind === "map") {
      if (value.entries.length === 0) lines.push(`${pad}${entry.key}: {}`);
      else {
        lines.push(`${pad}${entry.key}:`);
        emitMap(value, indent + 2, lines);
      }
    } else if (value.kind === "seq") {
      if (value.items.length === 0) lines.push(`${pad}${entry.key}: []`);
      else {
        lines.push(`${pad}${entry.key}:`);
        emitSeq(value, indent + 2, lines);
      }
    } else {
      emitScalar(entry.key, value, pad, lines);
    }
  }
}

/** The whole document, from the model. The only function that produces state-file bytes. */
export function emitState(root) {
  const lines = [];
  emitMap(root, 0, lines);
  for (const comment of root.trailingComments ?? []) lines.push(comment);
  return `${lines.join(root.eol ?? "\n")}${root.eol ?? "\n"}`;
}

// --- model mutation ---------------------------------------------------------------------------

function mapEntry(node, key) {
  // Last-wins, exactly as a YAML reader would resolve it. Writes refuse on a duplicated document
  // anyway; this keeps `get`-shaped lookups and the write path agreeing about which value is live.
  return [...node.entries].reverse().find((e) => e.key === key) ?? null;
}

function newMap() {
  return { kind: "map", entries: [], byKey: new Map() };
}

/**
 * Resolve `segments` to the containing map, creating intermediate maps. Returns
 * `{ parent, key }`, or `{ error }` when a segment would have to traverse a scalar or a sequence.
 */
function resolveContainer(root, segments) {
  let node = root;
  for (const segment of segments.slice(0, -1)) {
    let entry = mapEntry(node, segment);
    if (!entry) {
      entry = { key: segment, value: newMap() };
      node.entries.push(entry);
    }
    if (entry.value.kind === "scalar" && scalarValue(entry.value) === null) entry.value = newMap();
    if (entry.value.kind !== "map") {
      return { error: `${segment} is not a mapping, so nothing can be written beneath it` };
    }
    node = entry.value;
  }
  return { parent: node, key: segments[segments.length - 1] };
}

function setNode(root, dotted, valueNode) {
  const { parent, key, error } = resolveContainer(root, dotted.split("."));
  if (error) return error;
  const entry = mapEntry(parent, key);
  // The entry carries the comments and the blank line above it; only its value is replaced.
  if (entry) entry.value = valueNode;
  else parent.entries.push({ key, value: valueNode });
  return null;
}

/** The schema field at a dotted path, or `null`. Anything under a `free` map is known by design. */
function schemaFieldAt(dotted) {
  let level = SCHEMA;
  const segments = dotted.split(".");
  for (let i = 0; i < segments.length; i += 1) {
    const field = level?.[segments[i]];
    if (!field) return null;
    if (field.type === "free") return field;
    if (i === segments.length - 1) return field;
    level = field.children;
  }
  return null;
}

const KNOWN_PATH_HINT = (dotted) => {
  const segments = dotted.split(".");
  const home = segments.length > 1 ? `${segments.slice(0, -1).join(".")}.notes` : "notes";
  return (
    `"${dotted}" is not a path the schema defines. A field the schema has no opinion on belongs ` +
    `under a notes map — try ${home}.${segments[segments.length - 1]} — or pass --allow-unknown ` +
    `to write it where you asked`
  );
};

/** temp file in the same directory, fsync, rename. The state file *is* the resume contract. */
function writeAtomic(filePath, text) {
  const dir = path.dirname(filePath);
  mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.tmp`);
  const fd = openSync(temp, "w");
  try {
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, filePath);
}

/**
 * Load a document for writing. A duplicated key is refused here rather than re-emitted: the write
 * path exists to make that state unreachable, and silently keeping the last value would hide the
 * very defect `WS-E01` was written to surface. `normalize` is the one command that resolves it.
 */
function loadForWrite(statePath, { allowDuplicates = false } = {}) {
  if (!existsSync(statePath)) return { error: `no state file at ${statePath}`, code: 3 };
  const text = readFileSync(statePath, "utf8");
  const { root, fatal } = parseStateYaml(text);
  if (fatal) return { error: `line ${fatal.line}: ${fatal.what} [WS-E90]`, code: 3 };
  if (!allowDuplicates) {
    const duplicates = collectDuplicates(root, "");
    if (duplicates.length > 0) {
      return {
        error:
          `[WS-E01] ${duplicates.join(", ")} defined more than once. Refusing to write over a ` +
          `document whose live values are ambiguous — run \`normalize\` to keep the last value of each`,
        code: 1,
      };
    }
  }
  return { root, text };
}

function collectDuplicates(node, prefix) {
  const found = [];
  if (!node || node.kind !== "map") return found;
  const seen = new Set();
  for (const entry of node.entries) {
    const dotted = prefix ? `${prefix}.${entry.key}` : entry.key;
    if (seen.has(entry.key)) found.push(dotted);
    seen.add(entry.key);
    found.push(...collectDuplicates(entry.value, dotted));
  }
  return found;
}

/** Keep only the last entry per key, in the position the first one held. */
function dedupeMap(node) {
  if (!node || node.kind !== "map") return 0;
  let removed = 0;
  const last = new Map();
  for (const entry of node.entries) last.set(entry.key, entry);
  const kept = [];
  const placed = new Set();
  for (const entry of node.entries) {
    if (placed.has(entry.key)) {
      removed += 1;
      continue;
    }
    placed.add(entry.key);
    const winner = last.get(entry.key);
    kept.push(entry === winner ? entry : { ...entry, value: winner.value });
  }
  node.entries = kept;
  for (const entry of node.entries) removed += dedupeMap(entry.value);
  return removed;
}

/**
 * Write when the bytes changed; say `unchanged` and leave mtime alone when they did not.
 *
 * The result is validated *before* it reaches disk, so the write path refuses to create the state
 * `validate` exists to catch rather than creating it and reporting it afterwards. A pair of fields
 * that only make sense together — `not_applicable` and its reason — is set in one command for
 * exactly this reason. `--force` writes anyway, for the genuinely intermediate state.
 */
function persist(statePath, root, before, label, flags = new Set()) {
  const after = emitState(root);
  if (before !== null && after === before) {
    console.log(`unchanged  ${statePath}`);
    return 0;
  }
  const { report, fatal } = validateState(after, { metricsRecords: null });
  if (fatal) {
    console.error(`the emitted document does not re-parse: line ${fatal.line}: ${fatal.what} [WS-E90]`);
    return 1;
  }
  if (report.errors.length > 0 && !flags.has("--force")) {
    for (const item of report.errors) console.error(`[${item.code}]  ${item.subject}: ${item.message}`);
    console.error(`refusing to write ${statePath} — the result would not validate. Fix the values, or pass --force`);
    return 1;
  }
  writeAtomic(statePath, after);
  console.log(`${label}  ${statePath}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------------------------

const USAGE = `usage:
  node scripts/workflow-state.mjs validate        <TICKET-ID|path> [--json] [--strict] [--metrics <p>]
  node scripts/workflow-state.mjs get             <TICKET-ID|path> <dotted.path> [--json]
  node scripts/workflow-state.mjs check-artifacts <TICKET-ID|path> [--json] [--root <dir>]
  node scripts/workflow-state.mjs check-streams   <TICKET-ID|path> [--json] [--design <path>]
  node scripts/workflow-state.mjs print-schema    [--json | --markdown]
  node scripts/workflow-state.mjs init            <TICKET-ID|path> [--set <path>=<value>]...
  node scripts/workflow-state.mjs set             <TICKET-ID|path> <path>=<value>... [--allow-unknown]
  node scripts/workflow-state.mjs set-block       <TICKET-ID|path> <path> --from-stdin | --from-file <p>
  node scripts/workflow-state.mjs append          <TICKET-ID|path> <path> --json '<json>' [--dedupe]
  node scripts/workflow-state.mjs clear-in-flight <TICKET-ID|path> [--agent <name>] [--step <id>]
  node scripts/workflow-state.mjs normalize       <TICKET-ID|path>
  node scripts/workflow-state.mjs reset           <TICKET-ID|path> --reason <why> | --reason-file <p>
                                                  [--dry-run [--json]] [--fresh-config] [--root <dir>]`;

function resolveStatePath(target) {
  if (TICKET_RE.test(target)) return path.join(REPO_ROOT, ".workflow", `${target}.yaml`);
  return path.resolve(process.cwd(), target);
}

function defaultMetricsPath(statePath) {
  const ticket = path.basename(statePath, path.extname(statePath));
  return path.join(path.dirname(statePath), "metrics", `${ticket}.jsonl`);
}

function schemaRows(schema, prefix = "") {
  const rows = [];
  for (const [key, field] of Object.entries(schema)) {
    const dotted = prefix ? `${prefix}.${key}` : key;
    rows.push({
      path: dotted,
      type: field.type === "enum" ? `enum(${field.values.join(" | ")})` : field.type,
      required: Boolean(field.required),
      doc: field.doc ?? "",
    });
    if (field.children) rows.push(...schemaRows(field.children, dotted));
  }
  return rows;
}

function cmdPrintSchema(flags) {
  const rows = schemaRows(SCHEMA);
  if (flags.has("--json")) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }
  console.log("| Path | Type | Required | Notes |");
  console.log("|---|---|---|---|");
  for (const row of rows) {
    console.log(`| \`${row.path}\` | ${row.type} | ${row.required ? "yes" : "—"} | ${row.doc} |`);
  }
  return 0;
}

function cmdGet(target, dotted, flags) {
  const statePath = resolveStatePath(target);
  if (!existsSync(statePath)) {
    console.error(`no state file at ${statePath}`);
    return 3;
  }
  const { root, fatal } = parseStateYaml(readFileSync(statePath, "utf8"));
  if (fatal) {
    console.error(`line ${fatal.line}: ${fatal.what} [WS-E90]`);
    return 3;
  }
  const node = lookup(root, dotted.split("."));
  if (flags.has("--json")) {
    console.log(JSON.stringify(node ? scalarValue(node) ?? null : null));
    return 0;
  }
  const value = scalarValue(node);
  // Printed raw and unquoted: this is what gets pasted into the next delegation's parameters.
  console.log(value === null ? "" : value);
  return 0;
}

function cmdValidate(target, flags, metricsOverride) {
  const statePath = resolveStatePath(target);
  if (!existsSync(statePath)) {
    console.error(`no state file at ${statePath}`);
    return 3;
  }
  const metricsPath = metricsOverride ?? defaultMetricsPath(statePath);
  const { report, fatal } = validateState(readFileSync(statePath, "utf8"), {
    metricsRecords: readMetrics(metricsPath),
  });
  if (fatal) {
    console.error(`line ${fatal.line}: ${fatal.what} [WS-E90]`);
    return 3;
  }

  const strict = flags.has("--strict");
  const items = report.items;
  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          file: statePath,
          errors: report.errors.length,
          warnings: report.warnings.length,
          strict,
          violations: items,
          promote_candidates: report.warnings.filter((w) => w.code === "WS-W10").map((w) => w.subject),
        },
        null,
        2,
      ),
    );
  } else {
    for (const item of items) {
      const label = item.severity === "error" ? "" : " (warning)";
      console.log(`${statePath}:${item.line}  [${item.code}]${label}  ${item.subject}: ${item.message}`);
    }
    if (items.length === 0) console.log(`${path.basename(statePath)}: clean`);
  }

  if (report.errors.length > 0) return 1;
  return strict && report.warnings.length > 0 ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// check-artifacts
//
// The state file is a record of what happened, not of what still exists. Three runs have now
// resumed on a phase the file recorded correctly and then failed at the point of use, because the
// artifacts that phase presupposes had been deleted, renamed or reset underneath it — the
// 2026-08-17 SCRUM-132 run resumed at `phase: ship`, validated clean, and found the spec carrying
// all four implemented scenarios gone, nine delegations later. Step 0's existence check is scoped
// to `in_flight:`, which is empty on a run that completed its delegations, so a step already
// recorded as done is never re-checked.
//
// This mode stats every path the document names and says which are gone. It rules on nothing: a
// missing artifact is a fact to announce and route on, exactly as a non-empty `in_flight:` is, and
// deciding whether that means a re-run, an escalation or a shrug is the orchestrator's job. Hence
// exit 4 rather than 1 — drift found, not a file to repair before the next command.
// ---------------------------------------------------------------------------------------------

/**
 * The paths worth stating, and the only ones. `artifacts.metrics` is deliberately absent: the hook
 * owns that file, and its absence before the first agent run is normal rather than drift.
 *
 * `archive` is what `reset` reads off the same list, so the paths a reset moves and the paths a
 * drift check stats cannot fall out of step. `rename` is every artifact whose mere existence makes
 * an agent resolve to `EXISTS` and refuse to work — the two phase-1 documents and both
 * implementation reports. `keep` is live source: renaming a spec would leave it compiling, still
 * matched by `testDir`, and still imported by whatever imports it.
 */
const ARTIFACT_FIELDS = [
  { dotted: "artifacts.requirements", archive: "rename" },
  { dotted: "artifacts.test_design", archive: "rename" },
  { dotted: "automation.api.report", stream: "api", archive: "rename" },
  { dotted: "automation.api.created_tests", stream: "api", seq: true, archive: "keep" },
  { dotted: "automation.ui.report", stream: "ui", archive: "rename" },
  { dotted: "automation.ui.created_tests", stream: "ui", seq: true, archive: "keep" },
];

/** Strip the one layer of quoting the emitter may have added. */
function unquoteScalar(raw) {
  const text = raw.trim();
  const quoted = text.match(/^"([\s\S]*)"$/) || text.match(/^'([\s\S]*)'$/);
  return quoted ? quoted[1] : text;
}

/**
 * The entries of a sequence, in either form the parser produces: a block sequence is a `seq` node,
 * while a flow sequence (`[a, b]`) reaches us as a scalar and is split here.
 */
function seqEntries(node) {
  if (!node) return [];
  if (node.kind === "seq") return node.items.map((item) => unquoteScalar(item.raw)).filter(Boolean);
  if (node.kind !== "scalar") return [];
  const raw = node.raw.trim();
  if (!raw.startsWith("[") || !raw.endsWith("]")) return [];
  return raw
    .slice(1, -1)
    .split(",")
    .map((part) => unquoteScalar(part))
    .filter(Boolean);
}

/** Every recorded artifact path, in document order, each with the field that named it. */
export function artifactRows(root, repoRoot) {
  const rows = [];
  const streamStatus = (name) => scalarValue(lookup(root, ["automation", name, "status"]));
  for (const field of ARTIFACT_FIELDS) {
    const node = lookup(root, field.dotted.split("."));
    const found = field.seq
      ? seqEntries(node).map((value, i) => ({ label: `${field.dotted}[${i}]`, value }))
      : [{ label: field.dotted, value: scalarValue(node) }];
    for (const { label, value } of found) {
      if (!value) continue;
      rows.push({
        field: label,
        path: value,
        exists: existsSync(path.resolve(repoRoot, value)),
        stream: field.stream ?? null,
        stream_status: field.stream ? streamStatus(field.stream) : null,
        archive: field.archive,
      });
    }
  }
  return rows;
}

/**
 * check-streams — the state file's two stream decisions, read against the classified design.
 *
 * `validate` rules on the document alone and `check-artifacts` on what is still on disk. Neither can
 * see the defect this command exists for: a stream settled one way while the design says the other.
 * A stream marked `not_applicable` with scenarios waiting for it is work that will never be launched
 * and never be missed — nothing downstream re-derives that decision, and the ship gate cannot tell a
 * stream nobody needed from one nobody ran.
 *
 * It reads its counts from `test-design-lint.mjs --emit-manifest` rather than counting
 * `Assigned Level:` lines, because that is the one place the arithmetic lives. `classified: false` is
 * refused rather than read as zero: an unclassified design reports nothing at every level, which is a
 * true statement about the document and the exact opposite of what a gate would conclude from it.
 *
 * Like the other read commands it rules on nothing else — not whether a step ran, not whether a
 * verdict was right. Exit `5` is "the state file and the design disagree", kept distinct from `1`, a
 * document that does not validate, and `4`, an artifact gone from disk.
 */
function cmdCheckStreams(target, flags, designOverride) {
  const statePath = resolveStatePath(target);
  if (!existsSync(statePath)) {
    console.error(`no state file at ${statePath}`);
    return 3;
  }
  const { root, fatal } = parseStateYaml(readFileSync(statePath, "utf8"));
  if (fatal) {
    console.error(`line ${fatal.line}: ${fatal.what} [WS-E90]`);
    return 3;
  }
  const get = (dotted) => scalarValue(lookup(root, dotted.split(".")));
  const designPath = designOverride ?? get("artifacts.test_design");
  if (!designPath) {
    console.error(
      `no test design to check against: the state file records no artifacts.test_design and no ` +
        `--design was given`,
    );
    return 2;
  }
  const resolved = path.isAbsolute(designPath) ? designPath : path.resolve(REPO_ROOT, designPath);
  if (!existsSync(resolved)) {
    console.error(`no test design at ${resolved}`);
    return 3;
  }

  const lint = spawnSync(
    process.execPath,
    [path.join(REPO_ROOT, "scripts", "test-design-lint.mjs"), resolved, "--emit-manifest"],
    { encoding: "utf8" },
  );
  let manifest;
  try {
    manifest = JSON.parse(lint.stdout);
  } catch {
    console.error(
      `could not read a manifest from the design: test-design-lint.mjs exited ${lint.status}. ` +
        `${(lint.stderr || lint.stdout || "").trim().split("\n")[0] ?? ""}`,
    );
    return 3;
  }

  const violations = [];
  const err = (code, subject, what) => violations.push({ code, subject, what });

  if (manifest.classified !== true) {
    err(
      "CS-E01",
      "test_design",
      `the design is not classified, so no stream conclusion can be drawn from it. An unclassified ` +
        `design reports zero scenarios at every level, which is not the same statement as a stream ` +
        `with no work`,
    );
  }

  const byLevel = manifest.scenarios_by_level ?? {};
  const streams = [
    { name: "api", level: "E2E API" },
    { name: "ui", level: "E2E UI" },
  ].map(({ name, level }) => ({
    name,
    level,
    scenarios: Array.isArray(byLevel[level]) ? byLevel[level] : [],
    status: get(`automation.${name}.status`),
    reason: get(`automation.${name}.not_applicable_reason`),
  }));

  if (manifest.classified === true) {
    for (const stream of streams) {
      const count = stream.scenarios.length;
      if (count > 0 && stream.status === "not_applicable") {
        err(
          "CS-E02",
          `automation.${stream.name}.status`,
          `settled as not_applicable while the design assigns ${count} scenario(s) to ${stream.level} ` +
            `(${stream.scenarios.join(", ")}). That work will never be launched and never be missed`,
        );
      }
      if (count === 0 && stream.status !== "not_applicable" && stream.status !== "pending") {
        err(
          "CS-E03",
          `automation.${stream.name}.status`,
          `"${stream.status}" while the design assigns no scenario to ${stream.level}. A stream with ` +
            `nothing to test is settled as not_applicable with a reason, never worked`,
        );
      }
    }
  }

  const ticket = get("ticket_id") ?? path.basename(statePath);
  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          file: statePath,
          design: resolved,
          ticket,
          classified: manifest.classified === true,
          scope: "stream_scope_only",
          streams: streams.map((s) => ({
            stream: s.name,
            level: s.level,
            scenarios: s.scenarios,
            status: s.status,
            not_applicable_reason: s.reason,
          })),
          violations,
        },
        null,
        2,
      ),
    );
    return violations.length > 0 ? 5 : 0;
  }

  for (const v of violations) console.log(`${v.subject}  [${v.code}]  ${v.what}`);
  if (violations.length > 0) {
    console.log(`\nSTREAMS: ${violations.length} disagreement(s) between ${statePath} and ${resolved}`);
    return 5;
  }
  const shape = streams.map((s) => `${s.level} ${s.scenarios.length} -> ${s.status}`).join("; ");
  console.log(`${path.basename(statePath)}: streams agree with the design (${shape})`);
  return 0;
}

function cmdCheckArtifacts(target, flags, rootOverride) {
  const statePath = resolveStatePath(target);
  if (!existsSync(statePath)) {
    console.error(`no state file at ${statePath}`);
    return 3;
  }
  const { root, fatal } = parseStateYaml(readFileSync(statePath, "utf8"));
  if (fatal) {
    console.error(`line ${fatal.line}: ${fatal.what} [WS-E90]`);
    return 3;
  }

  const repoRoot = rootOverride ? path.resolve(process.cwd(), rootOverride) : REPO_ROOT;
  const rows = artifactRows(root, repoRoot);
  const missing = rows.filter((r) => !r.exists);
  const ticket = scalarValue(lookup(root, ["ticket_id"])) ?? path.basename(statePath);

  if (flags.has("--json")) {
    console.log(
      JSON.stringify(
        {
          file: statePath,
          root: repoRoot,
          ticket,
          recorded: rows.length,
          missing: missing.length,
          scope: "existence_only",
          artifacts: rows,
        },
        null,
        2,
      ),
    );
    return missing.length > 0 ? 4 : 0;
  }

  if (rows.length === 0) {
    console.log(`${ticket}: no artifact paths recorded yet`);
    return 0;
  }
  const width = Math.max(...rows.map((r) => r.field.length));
  for (const row of rows) {
    const suffix = row.stream ? `   (${row.stream} stream: ${row.stream_status ?? "unrecorded"})` : "";
    console.log(
      `  ${row.exists ? "present" : "MISSING"}  ${row.field.padEnd(width)}  ${row.path}${suffix}`,
    );
  }
  console.log(
    missing.length === 0
      ? `${ticket}: ${rows.length} recorded artifact(s), all present`
      : `${ticket}: ${missing.length} of ${rows.length} recorded artifact(s) missing from disk. ` +
          `The state file is right about what happened and wrong about what still exists — ` +
          `announce this before choosing a phase`,
  );
  return missing.length > 0 ? 4 : 0;
}

/** The skeleton `init` writes. Parsed rather than constructed, so one template is the whole shape. */
function initialDocument(ticket) {
  return `# Workflow state for ${ticket}. Written by scripts/workflow-state.mjs — the orchestrator does
# not hand-write this file. Fields the schema has no opinion on go under a \`notes:\` map.
ticket_id: ${ticket}
phase: test_design
status: in_progress
mode: manual
current_step: "0"

configuration:
  review_requirements: true
  non_e2e_coverage_strategy: create_follow_up_ticket
  max_review_iterations: 2
  max_design_iterations: 1
  batch_threshold: 15
  batch_size: 10
  jira_target_status: In Review
  on_blocked_alternative_flow: escalate
  on_missing_api_surface: escalate

iterations:
  design: 0
  api: 0
  ui: 0

artifacts:
  requirements: null
  test_design: null
  metrics: .workflow/metrics/${ticket}.jsonl

test_design:
  status: pending
  review_status: pending
  batches: []
  open_questions: []
  last_findings: null
  unapproved_unknowns: []
  blocked_scenarios: []
  approved_assumptions: []

automation:
  api:
    status: pending
    not_applicable_reason: null
    review_status: pending
    last_findings: null
  ui:
    status: pending
    not_applicable_reason: null
    review_status: pending
    last_findings: null

in_flight: []
pull_request: null
jira:
  status: null
  handback_status: pending
  comment: pending
follow_up_tickets: []
requirement_gaps: []
final_decision: pending

history: []
`;
}

function applySet(root, dotted, value, flags) {
  if (!schemaFieldAt(dotted) && !flags.has("--allow-unknown")) {
    console.error(KNOWN_PATH_HINT(dotted));
    return 2;
  }
  // `path=` and `path=null` both clear the field; everything else is a value.
  const node = value === "" || value === "null" ? { kind: "scalar", raw: "null" } : scalarNode(value);
  const error = setNode(root, dotted, node);
  if (error) {
    console.error(error);
    return 1;
  }
  return 0;
}

function splitAssignment(assignment) {
  const at = assignment.indexOf("=");
  if (at <= 0) return null;
  return { dotted: assignment.slice(0, at), value: assignment.slice(at + 1) };
}

function cmdInit(target, flags, values) {
  const statePath = resolveStatePath(target);
  const ticket = TICKET_RE.test(target) ? target : path.basename(statePath, path.extname(statePath));
  if (existsSync(statePath)) {
    // Deliberately the vocabulary the orchestrator already normalizes as `already_done`.
    console.log(`EXISTS  ${statePath}`);
    return 0;
  }
  const { root, fatal } = parseStateYaml(initialDocument(ticket));
  if (fatal) {
    console.error(`the init template does not parse: line ${fatal.line}: ${fatal.what}`);
    return 1;
  }
  for (const assignment of values.get("--set") ?? []) {
    const pair = splitAssignment(assignment);
    if (!pair) {
      console.error(`not a <path>=<value> assignment: ${assignment}`);
      return 2;
    }
    const rc = applySet(root, pair.dotted, pair.value, flags);
    if (rc) return rc;
  }
  return persist(statePath, root, null, "created", flags);
}

function cmdSet(target, assignments, flags) {
  const statePath = resolveStatePath(target);
  const loaded = loadForWrite(statePath);
  if (loaded.error) {
    console.error(loaded.error);
    return loaded.code;
  }
  for (const assignment of assignments) {
    const pair = splitAssignment(assignment);
    if (!pair) {
      console.error(`not a <path>=<value> assignment: ${assignment}`);
      return 2;
    }
    const rc = applySet(loaded.root, pair.dotted, pair.value, flags);
    if (rc) return rc;
  }
  return persist(statePath, loaded.root, loaded.text, "set", flags);
}

function cmdSetBlock(target, dotted, flags, values) {
  const statePath = resolveStatePath(target);
  const fromFile = values.get("--from-file")?.[0];
  if (!fromFile && !flags.has("--from-stdin")) {
    console.error("set-block needs --from-stdin or --from-file <path>");
    return 2;
  }
  let body;
  try {
    body = fromFile ? readFileSync(path.resolve(process.cwd(), fromFile), "utf8") : readFileSync(0, "utf8");
  } catch (error) {
    console.error(`cannot read the block: ${error.message}`);
    return 3;
  }
  const loaded = loadForWrite(statePath);
  if (loaded.error) {
    console.error(loaded.error);
    return loaded.code;
  }
  if (!schemaFieldAt(dotted) && !flags.has("--allow-unknown")) {
    console.error(KNOWN_PATH_HINT(dotted));
    return 2;
  }
  // One trailing newline is the file's, not the value's. `|-` then round-trips it byte for byte.
  const text = body.replace(/\r\n/g, "\n").replace(/\n$/, "");
  const error = setNode(loaded.root, dotted, text === "" ? { kind: "scalar", raw: "null" } : scalarNode(text));
  if (error) {
    console.error(error);
    return 1;
  }
  return persist(statePath, loaded.root, loaded.text, "set-block", flags);
}

/** The sequence node at `dotted`, materialising `[]`, `null` and an absent key into a real one. */
function sequenceAt(root, dotted) {
  const { parent, key, error } = resolveContainer(root, dotted.split("."));
  if (error) return { error };
  let entry = mapEntry(parent, key);
  if (!entry) {
    entry = { key, value: { kind: "seq", items: [] } };
    parent.entries.push(entry);
  }
  if (entry.value.kind === "scalar") {
    const raw = entry.value.raw.trim();
    if (raw === "[]" || raw === "null" || raw === "" || raw === "~") entry.value = { kind: "seq", items: [] };
    else return { error: `${dotted} holds a scalar, not a sequence` };
  }
  if (entry.value.kind !== "seq") return { error: `${dotted} is not a sequence` };
  return { node: entry.value };
}

function cmdAppend(target, dotted, flags, values) {
  const statePath = resolveStatePath(target);
  // Repeatable, so the two entries of a parallel pair are appended in one write rather than two.
  const jsons = values.get("--json") ?? [];
  if (jsons.length === 0) {
    console.error("append needs --json '<json>' — the entry to add; repeat it to add several at once");
    return 2;
  }
  let parsedAll;
  try {
    parsedAll = jsons.map((json) => JSON.parse(json));
  } catch (error) {
    console.error(`--json is not JSON: ${error.message}`);
    return 2;
  }
  const loaded = loadForWrite(statePath);
  if (loaded.error) {
    console.error(loaded.error);
    return loaded.code;
  }
  const field = schemaFieldAt(dotted);
  if (!field && !flags.has("--allow-unknown")) {
    console.error(KNOWN_PATH_HINT(dotted));
    return 2;
  }
  if (field && field.type !== "seq" && field.type !== "free") {
    console.error(`${dotted} is a ${field.type} in the schema — append only writes to a sequence`);
    return 2;
  }
  const seq = sequenceAt(loaded.root, dotted);
  if (seq.error) {
    console.error(seq.error);
    return 1;
  }
  for (const parsed of parsedAll) {
    const raw = formatFlow(parsed);
    const last = seq.node.items[seq.node.items.length - 1];
    // A resumed run re-appending the same `history` row is a live risk, not a hypothetical.
    if (flags.has("--dedupe") && last && last.raw === raw) continue;
    seq.node.items.push({ kind: "scalar", raw, flow: true });
  }
  return persist(statePath, loaded.root, loaded.text, "append", flags);
}

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function cmdClearInFlight(target, flags, values) {
  const statePath = resolveStatePath(target);
  const agent = values.get("--agent")?.[0];
  const step = values.get("--step")?.[0];
  if (!agent && !step) {
    console.error("clear-in-flight needs --agent <name> or --step <id> — never clears the whole list");
    return 2;
  }
  const loaded = loadForWrite(statePath);
  if (loaded.error) {
    console.error(loaded.error);
    return loaded.code;
  }
  const entry = mapEntry(loaded.root, "in_flight");
  if (entry && entry.value.kind === "seq") {
    const matches = (raw) =>
      (!agent || new RegExp(`\\bagent:\\s*["']?${escapeRe(agent)}["']?(?=[,}\\s]|$)`).test(raw)) &&
      (!step || new RegExp(`\\bstep:\\s*["']?${escapeRe(step)}["']?(?=[,}\\s]|$)`).test(raw));
    entry.value.items = entry.value.items.filter((item) => !matches(item.raw));
  }
  return persist(statePath, loaded.root, loaded.text, "clear-in-flight", flags);
}

/**
 * The `configuration:` block of a freshly initialised document, parsed. It is the only source of
 * defaults here — a second list in this file could only ever disagree with the template, which is
 * the same reason the banner is printed from the state file rather than kept beside it.
 */
function templateConfiguration() {
  const { root } = parseStateYaml(initialDocument("TEMPLATE-1"));
  const entry = mapEntry(root, "configuration");
  return entry && entry.value.kind === "map" ? entry.value : null;
}

/**
 * Write in the settings a document predates. A configuration key the schema defines and the file
 * lacks is not a neutral absence: the banner resolves it as `default` and prints it as a value
 * nobody chose, and a resume of a run somebody capped or relaxed goes on reporting the template's
 * answer instead of theirs. `init` writes every key for exactly this reason; this is the same rule
 * applied to the documents written before the key existed.
 *
 * Only `configuration.*`, and only keys the template carries a value for. Nothing else in the
 * document is touched — a back-fill is not a migration of the run, and a counter, a phase or a
 * history entry means what it said before this command ran.
 *
 * One key is deliberately never back-filled, for that same reason. `max_design_iterations` is a
 * *cap*, and writing a tighter one into a run that already spent more rounds than it allows would
 * retroactively make that run illegal — the document stops validating, `normalize` then refuses to
 * write it, and a command whose whole promise is that it changes nothing about the run has bricked
 * one. A document that predates the key falls back to `max_review_iterations` in the validator,
 * which is a defined answer rather than an absence, so there is nothing here for a back-fill to fix.
 */
const NEVER_BACKFILLED = new Set(["max_design_iterations"]);

function backfillConfiguration(root) {
  const template = templateConfiguration();
  const target = mapEntry(root, "configuration");
  if (!template || !target || target.value.kind !== "map") return [];
  const added = [];
  for (const entry of template.entries) {
    const field = SCHEMA.configuration.children?.[entry.key];
    if (!field || field.type === "free") continue;
    if (NEVER_BACKFILLED.has(entry.key)) continue;
    if (mapEntry(target.value, entry.key)) continue;
    target.value.entries.push({ key: entry.key, value: entry.value });
    added.push(`${entry.key}: ${scalarValue(entry.value)}`);
  }
  return added;
}

function cmdNormalize(target, flags) {
  const statePath = resolveStatePath(target);
  const loaded = loadForWrite(statePath, { allowDuplicates: true });
  if (loaded.error) {
    console.error(loaded.error);
    return loaded.code;
  }
  const collapsed = dedupeMap(loaded.root);
  if (collapsed > 0) {
    console.log(`collapsed ${collapsed} duplicate key${collapsed === 1 ? "" : "s"}, keeping the last value of each`);
  }
  for (const added of backfillConfiguration(loaded.root)) {
    console.log(`added      configuration.${added}  (the value init would have written)`);
  }
  return persist(statePath, loaded.root, loaded.text, "normalized", flags);
}

// ---------------------------------------------------------------------------------------------
// reset — the drop to the first stage
//
// Everything else here moves a run forwards. This is the one command that puts one back at the
// beginning, and it exists because the alternative was already happening by hand: `.workflow/
// SCRUM-132.yaml` carries a step-0 note describing a reset done with three renames at a shell
// prompt, and it calls itself the third occurrence. The naming it invented is the naming used here.
//
// Two rules shape the whole command.
//
// ARCHIVE, NEVER DELETE. Every displaced file is renamed to a name nothing else uses. That is what
// makes the absence of a rollback safe: a half-finished reset has lost nothing, because each
// completed move put its file somewhere the receipt has already named.
//
// THE STATE FILE MOVES SECOND TO LAST. It is the index of everything else, so while it is still in
// place a failure leaves a document that still describes the world — and re-running `reset` re-plans
// correctly from it, skipping each row whose source is now `absent`. Archive it first and a later
// failure leaves the only index inside a `.bak` nothing reads.
//
// What it does not touch: `artifacts.metrics`, which the hooks own, and every `created_tests` entry,
// which is live TypeScript. Renaming a spec to `old_do_not_use_*.ts` leaves it matched by `testDir`
// and imported by whatever imported it — a rename that buys a confusing name and no isolation. They
// are reported instead, because "nothing owns these four files now" is the fact the human needs.
// ---------------------------------------------------------------------------------------------

const RESET_STAMP_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The archive date. Injectable, so the tests are not a function of the day they run on. */
function resetStamp(override) {
  if (override !== undefined && override !== null) return RESET_STAMP_RE.test(override) ? override : null;
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** The first name in a family that nothing occupies. An archive that clobbers an archive is not one. */
function firstFreeName(candidates) {
  for (const candidate of candidates) if (!existsSync(candidate)) return candidate;
  return null;
}

/**
 * `<state>.yaml.bak-<date>-reset`, then `.2`, `.3`, … The suffix goes *after* `.yaml` on purpose:
 * the metrics hook finds the live state file by scanning `.workflow/` for `.yaml`, and an archive
 * named `SCRUM-132.bak-….yaml` would give it two candidates and mis-file every run's cost.
 */
function stateArchiveName(statePath, stamp) {
  const base = `${statePath}.bak-${stamp}-reset`;
  const names = [base];
  for (let n = 2; n <= 99; n += 1) names.push(`${base}.${n}`);
  return firstFreeName(names);
}

/**
 * `old_do_not_use_<base>`, then `old_do_not_use_2_<base>`, … The counter sits after the fixed
 * prefix so one glob still finds every archive and the extension stays where it was.
 */
function documentArchiveName(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const names = [path.join(dir, `old_do_not_use_${base}`)];
  for (let n = 2; n <= 99; n += 1) names.push(path.join(dir, `old_do_not_use_${n}_${base}`));
  return firstFreeName(names);
}

/** Repo-relative and forward-slashed, the form every path in the document already takes. */
function relativeTo(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

/**
 * The whole move list, computed and executed nowhere. Every predictable failure dies here — a
 * missing file, a duplicated key, a document that will not parse, an archive family that is full —
 * so `--dry-run` and the real run disagree only if the disk changes between them.
 */
function planReset(statePath, repoRoot, { stamp, reason, freshConfig }) {
  const loaded = loadForWrite(statePath);
  if (loaded.error) return { error: loaded.error, code: loaded.code };
  const root = loaded.root;
  const ticket =
    scalarValue(lookup(root, ["ticket_id"])) ?? path.basename(statePath, path.extname(statePath));

  const moves = [];
  const kept = [];
  for (const row of artifactRows(root, repoRoot)) {
    if (row.archive === "keep") {
      kept.push({ field: row.field, path: row.path, why: "live source — nothing owns it now" });
      continue;
    }
    if (!row.exists) {
      moves.push({ field: row.field, from: row.path, to: null, action: "absent" });
      continue;
    }
    const fromFull = path.resolve(repoRoot, row.path);
    const toFull = documentArchiveName(fromFull);
    if (!toFull) {
      return { error: `[WS-E40] no free archive name beside ${row.path} — 99 are already taken`, code: 2 };
    }
    moves.push({
      field: row.field,
      from: row.path,
      to: relativeTo(repoRoot, toFull),
      action: "rename",
      fromFull,
      toFull,
    });
  }

  const metrics = scalarValue(lookup(root, ["artifacts", "metrics"]));
  if (metrics) kept.push({ field: "artifacts.metrics", path: metrics, why: "the hooks own it" });

  const stateToFull = stateArchiveName(statePath, stamp);
  if (!stateToFull) {
    return { error: `[WS-E40] no free archive name for ${statePath} — 99 are already taken`, code: 2 };
  }
  const state = {
    field: "the state file",
    from: relativeTo(repoRoot, statePath),
    to: relativeTo(repoRoot, stateToFull),
    action: "rename",
    fromFull: statePath,
    toFull: stateToFull,
  };

  const carried = freshConfig
    ? { mode: null, configuration: null }
    : {
        mode: mapEntry(root, "mode")?.value ?? null,
        configuration: mapEntry(root, "configuration")?.value ?? null,
      };

  // No `duration_s` and no `tokens`: a reset spends no agent, and WS-W20 warns on a cost figure
  // with no metrics record behind it.
  const seed = {
    step: "0",
    agent: "none",
    result: "reset",
    at: stamp,
    reason,
    archived: [state.to, ...moves.filter((m) => m.action === "rename").map((m) => m.to)],
    kept: kept.map((k) => k.path),
    carried: freshConfig ? "none — --fresh-config" : "mode, configuration",
  };

  return { plan: { ticket, statePath, repoRoot, stamp, state, moves, kept, carried, seed } };
}

/** What happened, what did not, and where everything is. Printed before a write, not after it. */
function renderResetPlan(plan, dryRun) {
  const verb = dryRun ? "would reset" : "reset";
  console.log(`${verb}  ${plan.ticket}  ${plan.stamp}`);
  const rows = [plan.state, ...plan.moves];
  const width = Math.max(...rows.map((r) => r.from.length), ...plan.kept.map((k) => k.path.length));
  const tag = (label) => `  ${label.padEnd(10)}  `;
  for (const row of rows) {
    if (row.action === "absent") {
      console.log(`${tag("absent")}${row.from.padEnd(width)}  (recorded, already gone — nothing to archive)`);
      continue;
    }
    console.log(`${tag(dryRun ? "would arc" : "archive")}${row.from.padEnd(width)}  -> ${row.to}`);
  }
  for (const k of plan.kept) {
    console.log(`${tag(dryRun ? "would keep" : "kept")}${k.path.padEnd(width)}  (${k.field} — ${k.why})`);
  }
  const config = plan.carried.configuration;
  const keys = config && config.kind === "map" ? config.entries.length : 0;
  console.log(
    plan.carried.configuration || plan.carried.mode
      ? `${tag("carried")}mode and configuration: ${keys} key(s), forward from the archived document`
      : `${tag("carried")}nothing — --fresh-config, so every setting returns to its template default`,
  );
  const tests = plan.kept.filter((k) => k.field.includes("created_tests")).length;
  if (tests > 0) {
    console.log(
      `\n  ${tests} test file(s) were created by the archived run and are NOT renamed. Nothing owns\n` +
        `  them now: use git to keep or drop them.`,
    );
  }
}

function renderResetJson(plan, dryRun) {
  console.log(
    JSON.stringify(
      {
        file: plan.statePath,
        root: plan.repoRoot,
        ticket: plan.ticket,
        stamp: plan.stamp,
        dry_run: dryRun,
        scope: "archive_and_reinitialise",
        state: { from: plan.state.from, to: plan.state.to },
        moves: plan.moves.map((m) => ({ field: m.field, from: m.from, to: m.to, action: m.action })),
        kept: plan.kept,
        carried: plan.carried.configuration || plan.carried.mode ? "mode, configuration" : "none",
        history_seed: plan.seed,
      },
      null,
      2,
    ),
  );
}

/** Say what is where. No rollback: every completed move is a rename to a name the receipt named. */
function resetFailed(done, failed, error) {
  console.error(
    `[WS-E41] ${failed.from} could not be archived: ${error.message}. Nothing was rolled back — ` +
      `a rollback is another sequence of renames that can fail, and every move that did succeed put ` +
      `its file under a name nothing else uses. Re-run the same command: each move already made ` +
      `reports as \`absent\` and is skipped`,
  );
  for (const move of done) console.error(`  archived   ${move.from}  -> ${move.to}`);
  console.error(`  FAILED     ${failed.from}  -> ${failed.to}`);
  return 1;
}

function applyReset(plan, flags) {
  const done = [];
  for (const move of plan.moves) {
    if (move.action !== "rename") continue;
    try {
      renameSync(move.fromFull, move.toFull);
      done.push(move);
    } catch (error) {
      return resetFailed(done, move, error);
    }
  }
  try {
    renameSync(plan.state.fromFull, plan.state.toFull);
    done.push(plan.state);
  } catch (error) {
    return resetFailed(done, plan.state, error);
  }

  const { root, fatal } = parseStateYaml(initialDocument(plan.ticket));
  if (fatal) {
    console.error(`the init template does not parse: line ${fatal.line}: ${fatal.what}`);
    return 1;
  }
  // Carried as nodes rather than a key allowlist: an allowlist silently drops `configuration.notes.*`
  // and every key added to the schema after it was written.
  if (plan.carried.mode) setNode(root, "mode", plan.carried.mode);
  if (plan.carried.configuration) setNode(root, "configuration", plan.carried.configuration);
  const seq = sequenceAt(root, "history");
  if (seq.error) {
    console.error(seq.error);
    return 1;
  }
  seq.node.items.push({ raw: formatFlow(plan.seed) });

  const rc = persist(plan.statePath, root, null, "created", flags);
  if (rc !== 0) {
    console.error(
      `the archives are in place and no state file is. Repair with \`init ${plan.ticket}\` — ` +
        `a re-run of \`reset\` would exit 3, which is true and unhelpful`,
    );
  }
  return rc;
}

function cmdReset(target, flags, values) {
  const statePath = resolveStatePath(target);
  const reasonFlag = values.get("--reason")?.[0];
  const reasonFile = values.get("--reason-file")?.[0];
  if (reasonFlag && reasonFile) {
    console.error("reset takes --reason or --reason-file, not both");
    return 2;
  }
  let reason = reasonFlag ?? null;
  if (reasonFile) {
    try {
      reason = readFileSync(path.resolve(process.cwd(), reasonFile), "utf8");
    } catch (error) {
      console.error(`cannot read the reason: ${error.message}`);
      return 3;
    }
  }
  if (!reason || reason.trim() === "") {
    // Everything else about a reset is derivable from the document and the clock. This is the one
    // input nothing can reconstruct afterwards, and two of this repository's three hand resets have
    // already lost theirs. `--reason "no reason given"` stays typeable: that is a claim somebody
    // made, which is not the same as a blank the tool filled in.
    console.error(
      `reset needs --reason "<why>" or --reason-file <path>. A drop to the first stage archives ` +
        `the state file and every document a fresh run would otherwise refuse to rewrite; the reason ` +
        `is the only part of that a reader cannot reconstruct later`,
    );
    return 2;
  }
  const stamp = resetStamp(values.get("--at")?.[0]);
  if (!stamp) {
    console.error("--at takes a date as YYYY-MM-DD");
    return 2;
  }
  const rootOverride = values.get("--root")?.[0];
  const repoRoot = rootOverride ? path.resolve(process.cwd(), rootOverride) : REPO_ROOT;
  const dryRun = flags.has("--dry-run");
  if (flags.has("--json") && !dryRun) {
    console.error("reset --json prints the plan, so it goes with --dry-run; a real run prints its receipt");
    return 2;
  }

  const planned = planReset(statePath, repoRoot, {
    stamp,
    reason: reason.trim(),
    freshConfig: flags.has("--fresh-config"),
  });
  if (planned.error) {
    console.error(planned.error);
    return planned.code;
  }

  if (flags.has("--json")) renderResetJson(planned.plan, dryRun);
  else renderResetPlan(planned.plan, dryRun);
  if (dryRun) {
    if (!flags.has("--json")) console.log("dry-run  nothing was moved and nothing was written");
    return 0;
  }
  return applyReset(planned.plan, flags);
}

/** Which flags take a following value, per command. `--json` is a value flag only for `append`. */
const VALUE_FLAGS = {
  validate: ["--metrics"],
  "check-artifacts": ["--root"],
  "check-streams": ["--design"],
  init: ["--set"],
  "set-block": ["--from-file"],
  append: ["--json"],
  "clear-in-flight": ["--agent", "--step"],
  reset: ["--reason", "--reason-file", "--at", "--root"],
};

function parseArgs(command, rest) {
  const takesValue = new Set(VALUE_FLAGS[command] ?? []);
  const flags = new Set();
  const values = new Map();
  const positional = [];
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    if (!takesValue.has(arg)) {
      flags.add(arg);
      continue;
    }
    const value = rest[i + 1];
    if (value === undefined) return null;
    if (!values.has(arg)) values.set(arg, []);
    values.get(arg).push(value);
    i += 1;
  }
  return { flags, values, positional };
}

function main(argv) {
  const [command, ...rest] = argv;
  const parsed = parseArgs(command, rest);
  if (!parsed) {
    console.error(USAGE);
    return 2;
  }
  const { flags, values, positional } = parsed;
  const wrongArity = () => {
    console.error(USAGE);
    return 2;
  };

  switch (command) {
    case "print-schema":
      return cmdPrintSchema(flags);
    case "validate":
      return positional.length === 1
        ? cmdValidate(positional[0], flags, values.get("--metrics")?.[0] ?? null)
        : wrongArity();
    case "get":
      return positional.length === 2 ? cmdGet(positional[0], positional[1], flags) : wrongArity();
    case "check-streams":
      return positional.length === 1
        ? cmdCheckStreams(positional[0], flags, values.get("--design")?.[0] ?? null)
        : wrongArity();
    case "check-artifacts":
      return positional.length === 1
        ? cmdCheckArtifacts(positional[0], flags, values.get("--root")?.[0] ?? null)
        : wrongArity();
    case "init":
      return positional.length === 1 ? cmdInit(positional[0], flags, values) : wrongArity();
    case "set":
      return positional.length >= 2 ? cmdSet(positional[0], positional.slice(1), flags) : wrongArity();
    case "set-block":
      return positional.length === 2 ? cmdSetBlock(positional[0], positional[1], flags, values) : wrongArity();
    case "append":
      return positional.length === 2 ? cmdAppend(positional[0], positional[1], flags, values) : wrongArity();
    case "clear-in-flight":
      return positional.length === 1 ? cmdClearInFlight(positional[0], flags, values) : wrongArity();
    case "normalize":
      return positional.length === 1 ? cmdNormalize(positional[0], flags) : wrongArity();
    case "reset":
      return positional.length === 1 ? cmdReset(positional[0], flags, values) : wrongArity();
    default:
      console.error(USAGE);
      return 2;
  }
}

/** Importable for its enums; a CLI when run directly. */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(main(process.argv.slice(2)));
}

export { SCHEMA };
