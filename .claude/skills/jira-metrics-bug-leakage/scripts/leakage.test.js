'use strict';

/**
 * Tests for the jira-metrics-bug-leakage maths and reporting.
 *
 * Every case runs against a hand-built export, never against the live Jira
 * project. A test asserting "leakage is 41.7%" would fail the moment someone
 * files a bug, which measures the project rather than the code.
 *
 * The clock is always pinned with `asOf`, so ageing is reproducible.
 *
 * Run: npm run leakage:test
 */

const test = require('node:test');
const assert = require('node:assert');

const lib = require('./lib');
const report = require('./leakage');

const config = lib.loadConfig();
const AS_OF = '2026-08-21T12:00:00.000Z';

/* ------------------------------------------------------------------ *
 * Fixtures
 * ------------------------------------------------------------------ */

/** A raw Jira issue, shaped exactly as the search API returns one. */
function raw(key, over = {}) {
  const phase = over.phase === null ? null : { value: over.phase || 'Development' };
  return {
    key,
    fields: {
      summary: over.summary || `${key} summary`,
      customfield_10203: phase,
      created: over.created || '2026-08-01T09:00:00.000Z',
      resolutiondate: over.resolutiondate || null,
      priority: { name: over.priority || 'Medium' },
      status: {
        name: over.status || 'To Do',
        statusCategory: { key: over.resolved ? 'done' : 'new' },
      },
      labels: over.labels || [],
    },
  };
}

/** Two leaked, two contained: a 50% baseline that is easy to reason about. */
const balanced = [
  raw('P-1', { phase: 'Production' }),
  raw('P-2', { phase: 'Production' }),
  raw('D-1', { phase: 'Development' }),
  raw('D-2', { phase: 'Development' }),
];

const metricsOf = (issues, ctx = {}) => lib.computeMetrics(issues, config, { asOf: AS_OF, ...ctx });

/* ------------------------------------------------------------------ *
 * Normalising
 * ------------------------------------------------------------------ */

test('normalizeIssue flattens the fields the metrics need out of a raw issue', () => {
  const n = lib.normalizeIssue(raw('SCRUM-1', { phase: 'Production', priority: 'High', labels: ['security'] }), config);
  assert.strictEqual(n.key, 'SCRUM-1');
  assert.strictEqual(n.phase, 'Production');
  assert.strictEqual(n.priority, 'High');
  assert.deepStrictEqual(n.labels, ['security']);
  assert.strictEqual(n.resolved, false);
});

test('normalizeIssue reads resolved from the status category, not the status name', () => {
  assert.strictEqual(lib.normalizeIssue(raw('A', { resolved: true, status: 'Shipped' }), config).resolved, true);
  assert.strictEqual(lib.normalizeIssue(raw('B', { status: 'In Progress' }), config).resolved, false);
});

test('normalizeIssue reports an unset detection phase rather than guessing one', () => {
  assert.strictEqual(lib.normalizeIssue(raw('A', { phase: null }), config).phase, lib.UNSET);
});

test('normalizeIssue passes an already flattened record straight through', () => {
  const flat = { key: 'X', phase: 'Production', priority: 'High', labels: [], resolved: false, created: null };
  assert.strictEqual(lib.normalizeIssue(flat, config), flat);
});

test('normalizeIssue survives an issue with no fields at all', () => {
  const n = lib.normalizeIssue({ key: 'X' }, config);
  assert.strictEqual(n.phase, lib.UNSET);
  assert.strictEqual(n.priority, lib.UNSET);
  assert.deepStrictEqual(n.labels, []);
});

/* ------------------------------------------------------------------ *
 * Small helpers
 * ------------------------------------------------------------------ */

test('areaOf takes the first configured label so one bug counts once', () => {
  const issue = { labels: ['security', 'validation'] };
  assert.strictEqual(lib.areaOf(issue, config), 'validation', 'config order decides, not label order');
  assert.strictEqual(lib.areaOf({ labels: ['mvp'] }, config), lib.UNLABELLED);
});

test('monthOf takes the year and month of an ISO timestamp', () => {
  assert.strictEqual(lib.monthOf('2026-08-21T15:50:26.447+0200'), '2026-08');
  assert.strictEqual(lib.monthOf(null), lib.UNSET);
});

test('daysBetween counts whole days and never goes negative', () => {
  assert.strictEqual(lib.daysBetween('2026-08-01T00:00:00Z', '2026-08-11T00:00:00Z'), 10);
  assert.strictEqual(lib.daysBetween('2026-08-11T00:00:00Z', '2026-08-01T00:00:00Z'), 0);
  assert.strictEqual(lib.daysBetween('nonsense', '2026-08-01T00:00:00Z'), null);
});

test('rateOf returns null rather than NaN when there is nothing to divide', () => {
  assert.deepStrictEqual(lib.rateOf(0, 0), { leaked: 0, contained: 0, total: 0, rate: null });
  assert.strictEqual(lib.rateOf(1, 4).rate, 0.25);
});

test('median handles odd, even and empty lists', () => {
  assert.strictEqual(lib.median([3, 1, 2]), 2);
  assert.strictEqual(lib.median([1, 2, 3, 4]), 3);
  assert.strictEqual(lib.median([]), null);
});

test('pct formats a rate and shows a dash for an undefined one', () => {
  assert.strictEqual(lib.pct(0.4167), '41.7%');
  assert.strictEqual(lib.pct(0.2, 0), '20%');
  assert.strictEqual(lib.pct(null), '—');
});

test('bar draws a proportional bar and an empty one for no data', () => {
  assert.strictEqual(lib.bar(1, 4), '████');
  assert.strictEqual(lib.bar(0, 4), '░░░░');
  assert.strictEqual(lib.bar(0.5, 4), '██░░');
  assert.strictEqual(lib.bar(null, 4), '░░░░');
});

/* ------------------------------------------------------------------ *
 * The headline
 * ------------------------------------------------------------------ */

test('leakage is the share of bugs whose detection phase is Production', () => {
  const m = metricsOf(balanced);
  assert.strictEqual(m.overall.leaked, 2);
  assert.strictEqual(m.overall.contained, 2);
  assert.strictEqual(m.overall.rate, 0.5);
});

test('containment is the complement of leakage', () => {
  assert.strictEqual(metricsOf(balanced).containmentRate, 0.5);
});

test('a bug with no detection phase counts towards neither side', () => {
  // Counting it either way would move the headline without any evidence.
  const m = metricsOf([...balanced, raw('U-1', { phase: null }), raw('U-2', { phase: null })]);
  assert.strictEqual(m.overall.total, 4, 'unclassified bugs are excluded from the rate');
  assert.strictEqual(m.overall.rate, 0.5);
  assert.strictEqual(m.unclassified.length, 2);
  assert.strictEqual(m.unclassified[0].phase, lib.UNSET);
});

test('an unknown phase value is treated as unclassified, not as contained', () => {
  const m = metricsOf([raw('A', { phase: 'Staging' }), raw('B', { phase: 'Production' })]);
  assert.strictEqual(m.overall.total, 1);
  assert.strictEqual(m.unclassified.length, 1);
});

test('an empty classified set yields a null rate rather than a crash', () => {
  const m = metricsOf([raw('A', { phase: null })]);
  assert.strictEqual(m.overall.rate, null);
  assert.strictEqual(m.containmentRate, null);
  assert.strictEqual(m.status, 'unknown');
});

/* ------------------------------------------------------------------ *
 * Weighting
 * ------------------------------------------------------------------ */

test('weighted leakage rises above the raw rate when the serious bugs escape', () => {
  const m = metricsOf([
    raw('P-1', { phase: 'Production', priority: 'Highest' }),
    raw('D-1', { phase: 'Development', priority: 'Low' }),
  ]);
  assert.strictEqual(m.overall.rate, 0.5);
  assert.strictEqual(m.weighted.leaked, 5);
  assert.strictEqual(m.weighted.total, 7);
  assert.ok(m.weighted.rate > m.overall.rate);
});

test('weighted leakage falls below the raw rate when only trivia escapes', () => {
  const m = metricsOf([
    raw('P-1', { phase: 'Production', priority: 'Lowest' }),
    raw('D-1', { phase: 'Development', priority: 'Highest' }),
  ]);
  assert.ok(m.weighted.rate < m.overall.rate);
});

test('an unknown priority is weighted 1 rather than dropped', () => {
  const m = metricsOf([raw('P-1', { phase: 'Production', priority: 'Cosmic' })]);
  assert.strictEqual(m.weighted.total, 1);
});

/* ------------------------------------------------------------------ *
 * Breakdowns
 * ------------------------------------------------------------------ */

test('the trend groups by creation month, oldest first', () => {
  const m = metricsOf([
    raw('A', { phase: 'Production', created: '2026-07-05T00:00:00Z' }),
    raw('B', { phase: 'Development', created: '2026-06-05T00:00:00Z' }),
    raw('C', { phase: 'Development', created: '2026-07-20T00:00:00Z' }),
  ]);
  assert.deepStrictEqual(m.byMonth.map((r) => r.name), ['2026-06', '2026-07']);
  assert.strictEqual(m.byMonth[1].rate, 0.5);
});

test('the priority breakdown follows the configured severity order', () => {
  const m = metricsOf([
    raw('A', { phase: 'Production', priority: 'Low' }),
    raw('B', { phase: 'Development', priority: 'Highest' }),
    raw('C', { phase: 'Development', priority: 'Medium' }),
  ]);
  assert.deepStrictEqual(m.byPriority.map((r) => r.name), ['Highest', 'Medium', 'Low']);
});

test('the area breakdown leads with the leakiest area', () => {
  const m = metricsOf([
    raw('A', { phase: 'Production', labels: ['catalogue'] }),
    raw('B', { phase: 'Production', labels: ['validation'] }),
    raw('C', { phase: 'Development', labels: ['validation'] }),
  ]);
  assert.strictEqual(m.byArea[0].name, 'catalogue');
  assert.strictEqual(m.byArea[0].rate, 1);
  assert.strictEqual(m.byArea[1].rate, 0.5);
});

test('area totals add up to the classified count, so no bug is double counted', () => {
  const issues = [
    raw('A', { phase: 'Production', labels: ['security', 'validation', 'api'] }),
    raw('B', { phase: 'Development', labels: ['catalogue', 'filtering'] }),
    raw('C', { phase: 'Development', labels: [] }),
  ];
  const m = metricsOf(issues);
  assert.strictEqual(m.byArea.reduce((n, a) => n + a.total, 0), m.overall.total);
});

/* ------------------------------------------------------------------ *
 * Ageing
 * ------------------------------------------------------------------ */

test('open leaked bugs are aged against the pinned clock, oldest first', () => {
  const m = metricsOf([
    raw('OLD', { phase: 'Production', created: '2026-07-01T12:00:00Z' }),
    raw('NEW', { phase: 'Production', created: '2026-08-19T12:00:00Z' }),
  ]);
  assert.strictEqual(m.open.leakedOpen, 2);
  assert.deepStrictEqual(m.open.oldest.map((i) => i.key), ['OLD', 'NEW']);
  assert.strictEqual(m.open.oldest[0].ageDays, 51);
  assert.strictEqual(m.open.medianAgeDays, 27);
});

test('a resolved leaked bug is not counted as open and feeds time-to-fix instead', () => {
  const m = metricsOf([
    raw('FIXED', {
      phase: 'Production',
      created: '2026-08-01T12:00:00Z',
      resolutiondate: '2026-08-11T12:00:00Z',
      resolved: true,
    }),
  ]);
  assert.strictEqual(m.open.leakedOpen, 0);
  assert.strictEqual(m.open.leakedResolved, 1);
  assert.strictEqual(m.open.medianDaysToFix, 10);
});

test('the oldest list is capped at five so the report stays readable', () => {
  const many = Array.from({ length: 9 }, (_, i) => raw(`P-${i}`, { phase: 'Production' }));
  assert.strictEqual(metricsOf(many).open.oldest.length, 5);
  assert.strictEqual(metricsOf(many).open.leakedOpen, 9);
});

/* ------------------------------------------------------------------ *
 * Status and sample size
 * ------------------------------------------------------------------ */

test('status compares the rate against the target and the warning threshold', () => {
  const at = (leaked, total) => metricsOf([
    ...Array.from({ length: leaked }, (_, i) => raw(`P${i}`, { phase: 'Production' })),
    ...Array.from({ length: total - leaked }, (_, i) => raw(`D${i}`, { phase: 'Development' })),
  ]).status;
  assert.strictEqual(at(1, 10), 'on target');       // 10% <= 20%
  assert.strictEqual(at(2, 10), 'on target');       // 20% == target
  assert.strictEqual(at(3, 10), 'above target');    // 30% <= warnAt
  assert.strictEqual(at(5, 10), 'well above target');
});

test('a sample below the configured minimum is flagged as unstable', () => {
  assert.strictEqual(metricsOf(balanced).meta.smallSample, true);
  const many = Array.from({ length: 25 }, (_, i) => raw(`D-${i}`, { phase: 'Development' }));
  assert.strictEqual(metricsOf(many).meta.smallSample, false);
});

test('the same export always produces the same metrics', () => {
  assert.deepStrictEqual(metricsOf(balanced), metricsOf(balanced));
});

/* ------------------------------------------------------------------ *
 * Export query
 * ------------------------------------------------------------------ */

test('exportJql scopes to the project and issue type, and can window by age', () => {
  assert.strictEqual(lib.exportJql(config), 'project = SCRUM AND issuetype = Bug ORDER BY created ASC');
  assert.match(lib.exportJql(config, { sinceDays: 90 }), /created >= -90d/);
});

test('exportFields asks for the detection phase custom field', () => {
  const fields = lib.exportFields(config);
  assert.ok(fields.includes('customfield_10203'));
  for (const f of ['created', 'resolutiondate', 'priority', 'labels', 'status']) {
    assert.ok(fields.includes(f), `the export must request ${f}`);
  }
});

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

test('the markdown report carries every section', () => {
  const md = report.renderReport(metricsOf(balanced), config);
  for (const heading of ['# Bug leakage', '## Headline', '## By priority', '## By area',
    '## Trend', '## Leaked defects still open', '## Every leaked defect', '## How to read this']) {
    assert.ok(md.includes(heading), `missing ${heading}`);
  }
});

test('the report states the headline rate and the counts behind it', () => {
  const md = report.renderReport(metricsOf(balanced), config);
  assert.match(md, /\*\*Leakage rate\*\* \| \*\*50\.0%\*\* \(2 of 4\)/);
  assert.match(md, /Containment rate \| 50\.0%/);
});

test('the report warns when the sample is too small to read as a percentage', () => {
  assert.match(report.renderReport(metricsOf(balanced), config), /Small sample/);
});

test('the report calls out when what escapes is more serious than what is caught', () => {
  const m = metricsOf([
    raw('P-1', { phase: 'Production', priority: 'Highest' }),
    raw('D-1', { phase: 'Development', priority: 'Low' }),
  ]);
  assert.match(report.renderReport(m, config), /more serious than the ones caught/);
});

test('the report lists the bugs excluded for having no phase', () => {
  const m = metricsOf([...balanced, raw('U-1', { phase: null })]);
  const md = report.renderReport(m, config);
  assert.match(md, /## Excluded — no detection phase set/);
  assert.match(md, /U-1/);
});

test('the report omits the excluded section when every bug is classified', () => {
  assert.ok(!report.renderReport(metricsOf(balanced), config).includes('## Excluded'));
});

test('the report says so rather than drawing a trend from one month', () => {
  assert.match(report.renderReport(metricsOf(balanced), config), /Not enough months/);
});

test('the terminal summary leads with the rate and a bar', () => {
  const out = report.renderTerminal(metricsOf(balanced));
  assert.match(out, /Leakage {6}50\.0% {2}\(2 of 4 found in production\)/);
  assert.match(out, /█/);
  assert.match(out, /Target {7}20% {2}— well above target/);
});

test('the terminal summary flags unclassified bugs and small samples', () => {
  const out = report.renderTerminal(metricsOf([...balanced, raw('U-1', { phase: null })]));
  assert.match(out, /1 bug\(s\) have no detection phase/);
  assert.match(out, /Small sample/);
});

test('ratesTable renders one row per group with its rate', () => {
  const md = report.ratesTable([{ name: 'validation', contained: 2, leaked: 2, total: 4, rate: 0.5 }], 'Area');
  assert.match(md, /\| Area \| Contained \| Leaked \| Total \| Leakage \|/);
  assert.match(md, /\| validation \| 2 \| 2 \| 4 \| 50\.0% \|/);
});

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

test('parseArgs reads every flag and rejects an unknown one', () => {
  const opts = report.parseArgs(['--issues', 'a.json', '--since', '90', '--as-of', AS_OF, '--json']);
  assert.strictEqual(opts.issues, 'a.json');
  assert.strictEqual(opts.sinceDays, 90);
  assert.strictEqual(opts.asOf, AS_OF);
  assert.strictEqual(opts.json, true);
  assert.throws(() => report.parseArgs(['--bogus']), /Unknown flag/);
  assert.throws(() => report.parseArgs(['--issues']), /needs a value/);
});

test('main refuses an export that is missing or empty rather than reporting zero', () => {
  assert.throws(() => report.main(['--issues', '.bug-leakage/does-not-exist.json']), /No export at/);
});

/* ------------------------------------------------------------------ *
 * Dashboard
 * ------------------------------------------------------------------ */

const dash = require('./build-dashboard');

test('esc neutralises the quotes and angle brackets bug summaries contain', () => {
  assert.strictEqual(dash.esc('a "b" <c> & \'d\''), 'a &quot;b&quot; &lt;c&gt; &amp; &#39;d&#39;');
});

test('the proportion bar splits by the leaked share and leaves a gap between fills', () => {
  const html = dash.proportionSegments(metricsOf(balanced));
  assert.match(html, /prop-seg leaked[^>]*calc\(50\.00% - 1px\)/);
  assert.match(html, /prop-seg contained[^>]*calc\(50\.00% - 1px\)/);
});

test('the proportion bar omits a segment that has no defects in it', () => {
  const allLeaked = dash.proportionSegments(metricsOf([raw('P', { phase: 'Production' })]));
  assert.ok(allLeaked.includes('prop-seg leaked'));
  assert.ok(!allLeaked.includes('prop-seg contained'));
});

test('the target marker sits at the target rate', () => {
  assert.match(dash.targetMarker(metricsOf(balanced)), /left:20\.00%/);
  assert.match(dash.targetMarker(metricsOf(balanced)), /data-label="target 20%"/);
});

test('the weighted tile says which way the weighting moved the number', () => {
  const worse = dash.tiles(metricsOf([
    raw('P', { phase: 'Production', priority: 'Highest' }),
    raw('D', { phase: 'Development', priority: 'Low' }),
  ]));
  assert.match(worse, /the serious ones escape/);

  const better = dash.tiles(metricsOf([
    raw('P', { phase: 'Production', priority: 'Lowest' }),
    raw('D', { phase: 'Development', priority: 'Highest' }),
  ]));
  assert.match(better, /mostly minor escapes/);
});

test('the unclassified tile is flagged only when something is unclassified', () => {
  assert.match(dash.tiles(metricsOf([...balanced, raw('U', { phase: null })])), /tile-value warn/);
  assert.ok(!dash.tiles(metricsOf(balanced)).includes('tile-value warn'));
});

test('a bar row shows the rate, the counts and a hover tooltip', () => {
  const html = dash.barRows([{ name: 'validation', leaked: 2, contained: 2, total: 4, rate: 0.5 }], 'area');
  assert.match(html, /bar-name">validation/);
  assert.match(html, /bar-pct">50%/);
  assert.match(html, /bar-count">2\/4/);
  assert.match(html, /data-tip=/);
});

test('a group with no escapes renders the zero state, not an invisible bar', () => {
  const html = dash.barRows([{ name: 'Low', leaked: 0, contained: 3, total: 3, rate: 0 }], 'priority');
  assert.match(html, /bar-fill zero/);
});

test('the trend is suppressed below two months and says why', () => {
  const html = dash.trendSection(metricsOf(balanced));
  assert.match(html, /nothing to trend yet/);
  assert.ok(!html.includes('<svg'), 'a line through one point invites a false conclusion');
});

test('the trend renders a line, an emphasised last point and a table with two months', () => {
  const m = metricsOf([
    raw('A', { phase: 'Production', created: '2026-06-05T00:00:00Z' }),
    raw('B', { phase: 'Development', created: '2026-07-05T00:00:00Z' }),
  ]);
  const html = dash.trendSection(m);
  assert.match(html, /<svg class="chart"/);
  assert.match(html, /class="series-line"/);
  assert.match(html, /point point-last/);
  assert.match(html, /target-line/);
  assert.match(html, /<table>/, 'the figures must also exist as text');
  assert.match(html, /2026-06/);
});

test('the escaped-defects table links each key to Jira', () => {
  const html = dash.openSection(metricsOf([raw('P-1', { phase: 'Production' })]), config);
  assert.match(html, /href="https:\/\/dneprokos-test\.atlassian\.net\/browse\/P-1"/);
});

test('the escaped-defects section says so when nothing escaped', () => {
  const html = dash.openSection(metricsOf([raw('D-1', { phase: 'Development' })]), config);
  assert.match(html, /Nothing has been recorded as found in production/);
});

test('the notice appears for unclassified defects and lists their keys', () => {
  const html = dash.noticeSection(metricsOf([...balanced, raw('U-1', { phase: null })]));
  assert.match(html, /no Defect Detection Phase set/);
  assert.match(html, /U-1/);
});

test('the notice is omitted when the data is clean and the sample is large', () => {
  const many = Array.from({ length: 25 }, (_, i) => raw(`D-${i}`, { phase: 'Development' }));
  assert.strictEqual(dash.noticeSection(metricsOf(many)), '');
});

test('the built page fills every placeholder', () => {
  const html = dash.buildDashboard(metricsOf(balanced), config);
  assert.ok(!/\{\{\w+\}\}/.test(html), 'an unfilled placeholder would render as literal braces');
});

test('the built page defines the full palette on bare :root, not only behind a theme', () => {
  const html = dash.buildDashboard(metricsOf(balanced), config);
  const rootBlock = html.slice(html.indexOf(':root {'), html.indexOf('@media (prefers-color-scheme: dark)'));
  for (const token of ['--plane', '--surface', '--ink', '--leaked', '--contained', '--grid']) {
    assert.ok(rootBlock.includes(token), `${token} must have a light value outside any media query`);
  }
  assert.match(html, /:root:not\(\[data-theme="light"\]\)/, 'OS dark must not beat an explicit light choice');
  assert.match(html, /:root\[data-theme="dark"\]/, 'the theme toggle must win too');
  assert.match(html, /body\s*\{[^}]*background:\s*var\(--plane\)/, 'a transparent body borrows the host ground');
});

test('the built page is self-contained apart from Google Fonts', () => {
  const html = dash.buildDashboard(metricsOf(balanced), config);
  const hosts = (html.match(/https?:\/\/[^"'\s)]+/g) || [])
    .map((u) => u.split('/')[2])
    .filter((h) => h && !h.endsWith('atlassian.net'));
  assert.deepStrictEqual([...new Set(hosts)].sort(), ['fonts.googleapis.com', 'fonts.gstatic.com']);
});

test('the built page carries a specific title and no doctype wrapper', () => {
  const html = dash.buildDashboard(metricsOf(balanced), config);
  assert.match(html, /<title>SCRUM Bug Leakage<\/title>/);
  assert.ok(!/<!doctype/i.test(html));
  assert.ok(!/<html[\s>]/i.test(html));
});
