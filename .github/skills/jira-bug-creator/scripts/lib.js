'use strict';

/**
 * Shared helpers for the jira-bug-creator scripts.
 *
 * The scripts never talk to Jira. They parse input, hold the field contract,
 * validate a draft and render templates; the authenticated write is an MCP call
 * the agent makes. That split is deliberate — a script with Jira credentials in
 * this repo would be a secret in a tracked file, which is a defect this project
 * already files bugs about.
 *
 * No npm dependencies: Node stdlib only.
 */

const fs = require('fs');
const path = require('path');

/** Repository root, resolved from .claude/skills/jira-bug-creator/scripts/. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_DIR = path.resolve(__dirname, '..');

/** Load config.json. Every Jira-specific value lives there, not in the scripts. */
function loadConfig() {
  const raw = fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8');
  return JSON.parse(raw);
}

/** Read a file relative to the repo root, or null when it does not exist. */
function read(p) {
  const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return null;
  }
}

/** Repo-relative posix path. */
function rel(p) {
  const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

/** Write into the configured output directory; returns the repo-relative path. */
function writeOut(config, name, data) {
  const dir = path.join(REPO_ROOT, config.paths.outDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const body = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(target, body, 'utf8');
  return rel(target);
}

/** Load a template from assets/. */
function template(name) {
  return fs.readFileSync(path.join(SKILL_DIR, 'assets', name), 'utf8');
}

/**
 * Substitute `{{key}}` placeholders. Values are inserted verbatim — these
 * templates produce Jira markdown and terminal output, not HTML, so there is
 * nothing to escape and escaping would corrupt the code blocks in a repro.
 *
 * An unknown placeholder renders as the empty string rather than throwing, so a
 * template can carry an optional block without the caller having to supply it.
 *
 * @param {string} tpl
 * @param {Record<string, string>} values
 * @returns {string}
 */
function render(tpl, values) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/* ------------------------------------------------------------------ *
 * The draft contract
 * ------------------------------------------------------------------ */

/**
 * Fields a bug must carry before it is worth filing. Jira itself only demands
 * summary, project, issue type and the detection phase; the rest are required
 * here because a ticket without reproduction steps costs the next person more
 * time than it saves.
 */
const REQUIRED = [
  { key: 'summary', ask: 'A one-line summary: what breaks, not which rule fired.' },
  { key: 'phase', ask: 'Defect Detection Phase — Development or Production.' },
  { key: 'priority', ask: 'Priority — Highest, High, Medium, Low or Lowest.' },
  { key: 'version', ask: 'Version: the branch, commit or environment the defect was seen on.' },
  { key: 'initialCondition', ask: 'Initial Condition: the state the system must be in before step 1.' },
  { key: 'steps', ask: 'Steps to Reproduce: numbered, each one action.' },
  { key: 'expected', ask: 'Expected Results: what should happen.' },
  { key: 'actual', ask: 'Actual Results: what happens instead, with the observed status or message.' },
  { key: 'affectedTests', ask: 'Affected Tests: the suites that cover this, or the gap if none do.' },
];

const OPTIONAL = ['rootCause', 'evidence', 'labels', 'source', 'inferred', 'dedupeJql'];

/** An empty draft, so every consumer sees the same keys. */
function emptyDraft() {
  const draft = { labels: [], inferred: [], source: 'manual' };
  for (const f of REQUIRED) draft[f.key] = f.key === 'steps' ? [] : '';
  for (const k of OPTIONAL) if (!(k in draft)) draft[k] = '';
  return draft;
}

/**
 * Which required fields are still missing, and the question to ask for each.
 * @param {object} draft
 * @returns {Array<{key: string, ask: string}>}
 */
function missingFields(draft) {
  return REQUIRED.filter((f) => {
    const v = draft[f.key];
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || String(v).trim() === '';
  });
}

/**
 * Field-value problems that are not about absence: a phase or priority outside
 * the allowed set would be rejected by Jira with an unhelpful error, so catch
 * it here where the allowed values can be printed.
 * @param {object} draft
 * @param {object} config
 * @returns {string[]}
 */
function invalidFields(draft, config) {
  const problems = [];
  const phase = config.fields.detectionPhase;
  if (draft.phase && !phase.values.includes(draft.phase)) {
    problems.push(`phase "${draft.phase}" is not one of: ${phase.values.join(', ')}`);
  }
  const priority = config.fields.priority;
  if (draft.priority && !priority.values.includes(draft.priority)) {
    problems.push(`priority "${draft.priority}" is not one of: ${priority.values.join(', ')}`);
  }
  if (draft.summary && draft.summary.length > 255) {
    problems.push(`summary is ${draft.summary.length} characters; Jira caps it at 255`);
  }
  for (const label of draft.labels || []) {
    if (/\s/.test(label)) problems.push(`label "${label}" contains a space, which Jira rejects`);
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */

/** Steps as a numbered markdown list. Accepts an array or an existing string. */
function formatSteps(steps) {
  if (typeof steps === 'string') return steps;
  return (steps || []).map((s, i) => `${i + 1}. ${s}`).join('\n');
}

/** Steps indented for the terminal summary box. */
function indentSteps(steps, prefix = '  │  ') {
  return formatSteps(steps)
    .split('\n')
    .map((l) => `${prefix}${l}`)
    .join('\n');
}

/** Collapse a multi-line value onto one line for the summary box. */
function oneLine(text, max = 66) {
  const flat = String(text || '').replace(/```[\s\S]*?```/g, '<code>').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render the description from the asset template. */
function renderDescription(draft) {
  return render(template('bug-description.template.md'), {
    version: draft.version,
    initialCondition: draft.initialCondition,
    steps: formatSteps(draft.steps),
    expected: draft.expected,
    actual: draft.actual,
    evidenceBlock: draft.evidence ? `\n**Evidence:**\n${draft.evidence}\n` : '',
    rootCauseBlock: draft.rootCause ? `\n**Root cause:**\n${draft.rootCause}\n` : '',
    affectedTests: draft.affectedTests,
  });
}

/**
 * The fields object for the MCP create call, so the agent does not have to
 * remember which custom field id carries the detection phase.
 * @param {object} draft
 * @param {object} config
 */
function toCreatePayload(draft, config) {
  return {
    cloudId: config.cloudId,
    projectKey: config.projectKey,
    issueTypeName: config.issueType,
    summary: draft.summary,
    contentFormat: 'markdown',
    description: renderDescription(draft),
    additional_fields: {
      [config.fields.detectionPhase.id]: { value: draft.phase },
      priority: { name: draft.priority },
      labels: draft.labels || [],
    },
  };
}

/* ------------------------------------------------------------------ *
 * Duplicate search
 * ------------------------------------------------------------------ */

/**
 * A JQL query that finds bugs already describing this problem.
 *
 * Built from the distinctive words of the summary rather than the whole string:
 * two people never phrase the same defect identically, so an exact match finds
 * nothing and a full-text match on every word finds everything.
 *
 * @param {object} draft
 * @param {object} config
 * @returns {string}
 */
function dedupeJql(draft, config) {
  const { minWordLength, maxTerms, stopWords, lookbackDays } = config.dedupe;
  const stop = new Set(stopWords.map((w) => w.toLowerCase()));

  // An auto-drafted summary reads "<what failed> — <assertion text>". The
  // assertion half is matcher vocabulary that every failing test shares, so
  // searching on it matches unrelated bugs and misses related ones.
  const subject = String(draft.summary || '').split(' — ')[0];

  const terms = subject
    .toLowerCase()
    .replace(/[^a-z0-9/\s-]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= minWordLength && !stop.has(w))
    .filter((w, i, all) => all.indexOf(w) === i)
    .slice(0, maxTerms);

  const clauses = [
    `project = ${config.projectKey}`,
    `issuetype = ${config.issueType}`,
    `created >= -${lookbackDays}d`,
  ];

  const or = [];
  if (terms.length) or.push(`summary ~ "${terms.join(' ')}"`);
  const labels = (draft.labels || []).filter((l) => /^[A-Z]{2,3}-\d{2}$/.test(l));
  if (labels.length) or.push(`labels in (${labels.map((l) => `"${l}"`).join(', ')})`);
  if (or.length) clauses.push(`(${or.join(' OR ')})`);

  return `${clauses.join(' AND ')} ORDER BY created DESC`;
}

/** Browse URL for an issue key. */
function issueUrl(config, key) {
  return `${config.site.replace(/\/$/, '')}/browse/${key}`;
}

module.exports = {
  REPO_ROOT,
  SKILL_DIR,
  REQUIRED,
  OPTIONAL,
  loadConfig,
  read,
  rel,
  writeOut,
  template,
  render,
  emptyDraft,
  missingFields,
  invalidFields,
  formatSteps,
  indentSteps,
  oneLine,
  renderDescription,
  toCreatePayload,
  dedupeJql,
  issueUrl,
};
