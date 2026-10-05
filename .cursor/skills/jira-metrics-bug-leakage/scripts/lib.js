'use strict';

/**
 * Bug-leakage maths, kept apart from the reporting so both the markdown report
 * and the dashboard are rendered from one set of numbers.
 *
 * Leakage is the share of defects that were found in production rather than
 * before release. It is read off one field — Defect Detection Phase — so the
 * number is only ever as honest as that field's hygiene. Everything here is
 * pure: no clock, no filesystem, no network, so the same export always yields
 * the same report.
 */

const fs = require('fs');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..', '..');
const SKILL_DIR = path.resolve(__dirname, '..');

function loadConfig() {
  return JSON.parse(fs.readFileSync(path.join(SKILL_DIR, 'config.json'), 'utf8'));
}

function read(p) {
  const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  try {
    return fs.readFileSync(abs, 'utf8');
  } catch (err) {
    return null;
  }
}

function rel(p) {
  const abs = path.isAbsolute(p) ? p : path.join(REPO_ROOT, p);
  return path.relative(REPO_ROOT, abs).split(path.sep).join('/');
}

function writeOut(config, name, data) {
  const dir = path.join(REPO_ROOT, config.paths.outDir);
  fs.mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  const body = typeof data === 'string' ? data : `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(target, body, 'utf8');
  return rel(target);
}

function template(name) {
  return fs.readFileSync(path.join(SKILL_DIR, 'assets', name), 'utf8');
}

function render(tpl, values) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = values[key];
    return v === undefined || v === null ? '' : String(v);
  });
}

/* ------------------------------------------------------------------ *
 * Normalising the export
 * ------------------------------------------------------------------ */

const UNSET = '(not set)';
const UNLABELLED = '(no area label)';

/**
 * Flatten a raw Jira issue into the handful of values the metrics need.
 *
 * Accepts both a raw search result (`{key, fields: {...}}`) and an already
 * flattened record, so a hand-built fixture and a live export go down the same
 * path.
 *
 * @param {object} issue
 * @param {object} config
 * @returns {object}
 */
function normalizeIssue(issue, config) {
  if (issue && issue.phase !== undefined && issue.fields === undefined) return issue;

  const f = (issue && issue.fields) || {};
  const phaseField = f[config.detectionPhase.id];
  const statusCategory = (f.status && f.status.statusCategory && f.status.statusCategory.key) || '';

  return {
    key: issue.key,
    summary: f.summary || '',
    phase: (phaseField && phaseField.value) || UNSET,
    priority: (f.priority && f.priority.name) || UNSET,
    labels: f.labels || [],
    status: (f.status && f.status.name) || UNSET,
    // Jira's status categories are new / indeterminate / done.
    resolved: statusCategory === 'done',
    created: f.created || null,
    resolutionDate: f.resolutiondate || null,
  };
}

/**
 * The area a bug belongs to, from its labels.
 *
 * A bug can carry several area labels; the first match in the configured order
 * wins so that one bug counts once. Counting it in every matching area would
 * make the column totals exceed the bug count and quietly overstate leakage in
 * whichever area appears alongside others.
 */
function areaOf(issue, config) {
  for (const area of config.areaLabels) {
    if (issue.labels.includes(area)) return area;
  }
  return UNLABELLED;
}

/** `YYYY-MM` of an ISO timestamp. */
function monthOf(iso) {
  return typeof iso === 'string' && iso.length >= 7 ? iso.slice(0, 7) : UNSET;
}

/** Whole days between two ISO timestamps. */
function daysBetween(fromIso, toIso) {
  const from = Date.parse(fromIso);
  const to = Date.parse(toIso);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

/* ------------------------------------------------------------------ *
 * Metrics
 * ------------------------------------------------------------------ */

/** Leaked / total, plus the raw counts. Total 0 yields a null rate, not NaN. */
function rateOf(leaked, total) {
  return { leaked, contained: total - leaked, total, rate: total ? leaked / total : null };
}

/**
 * Group issues by a key function and compute the leakage rate of each group.
 * @returns {Array<{name: string, leaked: number, contained: number, total: number, rate: number|null}>}
 */
function groupRates(issues, keyFn, config) {
  const groups = new Map();
  for (const issue of issues) {
    const name = keyFn(issue);
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(issue);
  }
  return [...groups.entries()].map(([name, members]) => ({
    name,
    ...rateOf(members.filter((i) => isLeaked(i, config)).length, members.length),
  }));
}

function isLeaked(issue, config) {
  return issue.phase === config.detectionPhase.leaked;
}

function isContained(issue, config) {
  return issue.phase === config.detectionPhase.contained;
}

/** Median of a numeric list, or null when empty. */
function median(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

/**
 * Every metric the report and the dashboard need.
 *
 * @param {object[]} rawIssues raw or flattened issues
 * @param {object} config
 * @param {{asOf?: string, jql?: string, fetchedAt?: string}} [ctx] asOf fixes
 *   the clock so ageing is reproducible; tests depend on this.
 * @returns {object}
 */
function computeMetrics(rawIssues, config, ctx = {}) {
  const asOf = ctx.asOf || new Date().toISOString();
  const issues = rawIssues.map((i) => normalizeIssue(i, config));

  // A bug with no phase set cannot be counted as leaked or contained. Dropping
  // it silently would flatter whichever side is smaller, so it is excluded from
  // the rates and reported separately as a data-quality problem.
  const classified = issues.filter((i) => isLeaked(i, config) || isContained(i, config));
  const unclassified = issues.filter((i) => !isLeaked(i, config) && !isContained(i, config));

  const leakedIssues = classified.filter((i) => isLeaked(i, config));
  const overall = rateOf(leakedIssues.length, classified.length);

  const weightOf = (i) => config.priorityWeights[i.priority] || 1;
  const weightTotal = classified.reduce((n, i) => n + weightOf(i), 0);
  const weightLeaked = leakedIssues.reduce((n, i) => n + weightOf(i), 0);

  const byMonth = groupRates(classified, (i) => monthOf(i.created), config)
    .sort((a, b) => a.name.localeCompare(b.name));

  const priorityOrder = Object.keys(config.priorityWeights);
  const byPriority = groupRates(classified, (i) => i.priority, config)
    .sort((a, b) => priorityOrder.indexOf(a.name) - priorityOrder.indexOf(b.name));

  const byArea = groupRates(classified, (i) => areaOf(i, config), config)
    .sort((a, b) => (b.rate || 0) - (a.rate || 0) || b.total - a.total);

  const openLeaked = leakedIssues
    .filter((i) => !i.resolved)
    .map((i) => ({ ...i, ageDays: daysBetween(i.created, asOf) }))
    .sort((a, b) => (b.ageDays || 0) - (a.ageDays || 0));

  const resolvedLeaked = leakedIssues.filter((i) => i.resolved);
  const timeToFix = resolvedLeaked
    .map((i) => daysBetween(i.created, i.resolutionDate))
    .filter((d) => d !== null);

  const target = config.targets.leakageRate;
  const warn = config.targets.warnAt;
  let status = 'unknown';
  if (overall.rate !== null) {
    if (overall.rate <= target) status = 'on target';
    else if (overall.rate <= warn) status = 'above target';
    else status = 'well above target';
  }

  return {
    meta: {
      asOf,
      fetchedAt: ctx.fetchedAt || null,
      jql: ctx.jql || null,
      project: config.projectKey,
      phaseField: config.detectionPhase.name,
      smallSample: classified.length < config.targets.minSampleForTrend,
      minSampleForTrend: config.targets.minSampleForTrend,
    },
    overall,
    containmentRate: overall.rate === null ? null : 1 - overall.rate,
    target,
    status,
    weighted: {
      leaked: weightLeaked,
      total: weightTotal,
      rate: weightTotal ? weightLeaked / weightTotal : null,
    },
    byMonth,
    byPriority,
    byArea,
    open: {
      leakedOpen: openLeaked.length,
      leakedResolved: resolvedLeaked.length,
      medianAgeDays: median(openLeaked.map((i) => i.ageDays).filter((d) => d !== null)),
      oldest: openLeaked.slice(0, 5).map((i) => ({
        key: i.key, summary: i.summary, priority: i.priority, ageDays: i.ageDays, status: i.status,
      })),
      medianDaysToFix: median(timeToFix),
    },
    leakedIssues: leakedIssues.map((i) => ({
      key: i.key, summary: i.summary, priority: i.priority, status: i.status,
      resolved: i.resolved, created: i.created, area: areaOf(i, config),
    })),
    unclassified: unclassified.map((i) => ({ key: i.key, summary: i.summary, phase: i.phase })),
  };
}

/* ------------------------------------------------------------------ *
 * Presentation helpers
 * ------------------------------------------------------------------ */

/** A rate as a percentage string, or an em dash when it is undefined. */
function pct(rate, digits = 1) {
  return rate === null || rate === undefined ? '—' : `${(rate * 100).toFixed(digits)}%`;
}

/** A fixed-width bar for the terminal. */
function bar(rate, width = 22, filled = '█', empty = '░') {
  if (rate === null || rate === undefined) return empty.repeat(width);
  const n = Math.max(0, Math.min(width, Math.round(rate * width)));
  return filled.repeat(n) + empty.repeat(width - n);
}

/** Base URL for issue links, without a trailing slash. */
function issueUrlBase(config) {
  return `${config.site.replace(/\/$/, '')}/browse`;
}

/** The JQL that produces the export this skill expects. */
function exportJql(config, opts = {}) {
  const clauses = [`project = ${config.projectKey}`, `issuetype = ${config.issueType}`];
  if (opts.sinceDays) clauses.push(`created >= -${opts.sinceDays}d`);
  return `${clauses.join(' AND ')} ORDER BY created ASC`;
}

/** The fields the export must request for every metric to be computable. */
function exportFields(config) {
  return ['summary', 'priority', 'labels', 'status', 'created', 'resolutiondate', config.detectionPhase.id];
}

module.exports = {
  REPO_ROOT,
  SKILL_DIR,
  UNSET,
  UNLABELLED,
  loadConfig,
  read,
  rel,
  writeOut,
  template,
  render,
  normalizeIssue,
  areaOf,
  monthOf,
  daysBetween,
  rateOf,
  groupRates,
  isLeaked,
  isContained,
  median,
  computeMetrics,
  pct,
  bar,
  issueUrlBase,
  exportJql,
  exportFields,
};
