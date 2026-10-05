'use strict';

/**
 * Compute bug leakage from a Jira export and write the report.
 *
 * Reads `.bug-leakage/issues.json` — which the agent produces by running the
 * printed JQL over MCP — and writes:
 *   .bug-leakage/metrics.json        every number, for the dashboard
 *   .bug-leakage/leakage-report.md   the written report
 * and prints a terminal summary.
 *
 * Nothing here contacts Jira; the export is the input. That keeps the maths
 * reproducible and keeps credentials out of a tracked script.
 */

const {
  loadConfig,
  read,
  rel,
  writeOut,
  computeMetrics,
  pct,
  bar,
  exportJql,
  exportFields,
} = require('./lib');

const USAGE = `
Usage: node .claude/skills/jira-metrics-bug-leakage/scripts/leakage.js [options]

  --issues <file>    export to read (default: .bug-leakage/issues.json)
  --since <days>     only bugs created in the last N days
  --as-of <iso>      fix the clock, so ageing is reproducible
  --jql              print the JQL and fields to fetch, then stop
  --json             print metrics.json to stdout instead of the report
  --help

Typical run:
  1. node scripts/leakage.js --jql          # what to fetch
  2. <agent runs the JQL over MCP and writes .bug-leakage/issues.json>
  3. node scripts/leakage.js                # report
`;

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--issues': opts.issues = next(); break;
      case '--since': opts.sinceDays = parseInt(next(), 10); break;
      case '--as-of': opts.asOf = next(); break;
      case '--jql': opts.jqlOnly = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/* ------------------------------------------------------------------ *
 * Markdown report
 * ------------------------------------------------------------------ */

function ratesTable(rows, firstColumn) {
  const out = [
    `| ${firstColumn} | Contained | Leaked | Total | Leakage |`,
    '|---|---:|---:|---:|---:|',
  ];
  for (const r of rows) {
    out.push(`| ${r.name} | ${r.contained} | ${r.leaked} | ${r.total} | ${pct(r.rate)} |`);
  }
  return out.join('\n');
}

function renderReport(m, config) {
  const L = [];
  const p = (s = '') => L.push(s);

  p('# Bug leakage');
  p();
  p(`Project **${m.meta.project}**, measured on the **${m.meta.phaseField}** field. `
    + `${m.overall.total} classified bug(s) as of ${m.meta.asOf.slice(0, 10)}.`);
  p();

  p('## Headline');
  p();
  p(`| Metric | Value |`);
  p('|---|---|');
  p(`| **Leakage rate** | **${pct(m.overall.rate)}** (${m.overall.leaked} of ${m.overall.total}) |`);
  p(`| Containment rate | ${pct(m.containmentRate)} (${m.overall.contained} caught before release) |`);
  p(`| Target | ${pct(m.target, 0)} or lower — **${m.status}** |`);
  p(`| Severity-weighted leakage | ${pct(m.weighted.rate)} (${m.weighted.leaked} of ${m.weighted.total} weight) |`);
  p(`| Leaked and still open | ${m.open.leakedOpen}${m.open.medianAgeDays !== null ? `, median age ${m.open.medianAgeDays} day(s)` : ''} |`);
  p();
  p(`Leakage counts a defect as escaped when its ${m.meta.phaseField} is `
    + `"${config.detectionPhase.leaked}" — found in live use rather than before release. `
    + `Containment is its complement.`);
  p();

  if (m.weighted.rate !== null && m.overall.rate !== null) {
    const gap = m.weighted.rate - m.overall.rate;
    if (Math.abs(gap) >= 0.05) {
      p(gap > 0
        ? `> The weighted rate is ${pct(gap)} higher than the raw rate: the bugs that escape are more serious than the ones caught.`
        : `> The weighted rate is ${pct(-gap)} lower than the raw rate: what escapes is mostly low-priority.`);
      p();
    }
  }

  if (m.meta.smallSample) {
    p(`> **Small sample.** ${m.overall.total} classified bugs is below the ${m.meta.minSampleForTrend} `
      + 'this report treats as enough for a stable percentage. One more bug moves the headline by '
      + `${pct(1 / (m.overall.total + 1))}. Read the counts, not the trend.`);
    p();
  }

  p('## By priority');
  p();
  p(ratesTable(m.byPriority, 'Priority'));
  p();

  p('## By area');
  p();
  p('A bug counts once, under the first area label it carries.');
  p();
  p(ratesTable(m.byArea, 'Area'));
  p();

  p('## Trend');
  p();
  if (m.byMonth.length < 2) {
    p('_Not enough months to show a trend._');
  } else {
    p(ratesTable(m.byMonth, 'Month'));
  }
  p();

  p('## Leaked defects still open');
  p();
  if (!m.open.leakedOpen) {
    p('_None — every escaped defect is resolved._');
  } else {
    p(`${m.open.leakedOpen} open, ${m.open.leakedResolved} resolved`
      + `${m.open.medianDaysToFix !== null ? `, median ${m.open.medianDaysToFix} day(s) to fix once found` : ''}.`);
    p();
    p('| Key | Priority | Age (days) | Status | Summary |');
    p('|---|---|---:|---|---|');
    for (const i of m.open.oldest) {
      p(`| ${i.key} | ${i.priority} | ${i.ageDays ?? '—'} | ${i.status} | ${i.summary} |`);
    }
  }
  p();

  p('## Every leaked defect');
  p();
  p('| Key | Priority | Area | Status | Summary |');
  p('|---|---|---|---|---|');
  for (const i of m.leakedIssues) {
    p(`| ${i.key} | ${i.priority} | ${i.area} | ${i.status} | ${i.summary} |`);
  }
  p();

  if (m.unclassified.length) {
    p('## Excluded — no detection phase set');
    p();
    p(`${m.unclassified.length} bug(s) carry no ${m.meta.phaseField}, so they count towards neither `
      + 'side and are left out of every rate above. Setting the field on these changes the headline.');
    p();
    for (const i of m.unclassified) p(`- ${i.key} — ${i.summary}`);
    p();
  }

  p('## How to read this');
  p();
  p('- Leakage is measured on **where a defect was found**, not where it was introduced. A bug '
    + 'written a year ago and found in production today counts against this month.');
  p('- The phase field is set by hand, so the number inherits that discipline. A rising containment '
    + 'rate can mean better testing, or it can mean nobody is filling in the field for production issues.');
  p('- Weighted leakage exists because one escaped Highest is not the same event as one escaped Low.');
  p();
  p(`Source: \`${m.meta.jql || 'unknown JQL'}\`${m.meta.fetchedAt ? `, fetched ${m.meta.fetchedAt}` : ''}.`);

  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * Terminal summary
 * ------------------------------------------------------------------ */

function renderTerminal(m) {
  const L = [];
  const p = (s = '') => L.push(s);
  const pad = (s, n) => String(s).padEnd(n);

  p('');
  p('  BUG LEAKAGE — ' + m.meta.project);
  p('  ' + '─'.repeat(58));
  p('');
  p(`  Leakage      ${pct(m.overall.rate)}  (${m.overall.leaked} of ${m.overall.total} found in production)`);
  p(`  ${bar(m.overall.rate)}`);
  p('');
  p(`  Containment  ${pct(m.containmentRate)}  (${m.overall.contained} caught before release)`);
  p(`  Weighted     ${pct(m.weighted.rate)}  (by priority)`);
  p(`  Target       ${pct(m.target, 0)}  — ${m.status}`);
  p('');

  if (m.byPriority.length) {
    p('  By priority');
    for (const r of m.byPriority) {
      p(`    ${pad(r.name, 9)} ${bar(r.rate, 12)} ${pad(pct(r.rate, 0), 6)} ${r.leaked}/${r.total}`);
    }
    p('');
  }

  const leakyAreas = m.byArea.filter((a) => a.leaked > 0).slice(0, 5);
  if (leakyAreas.length) {
    p('  Leakiest areas');
    for (const r of leakyAreas) {
      p(`    ${pad(r.name, 16)} ${bar(r.rate, 12)} ${pad(pct(r.rate, 0), 6)} ${r.leaked}/${r.total}`);
    }
    p('');
  }

  if (m.open.leakedOpen) {
    p(`  Still open in production: ${m.open.leakedOpen}`
      + `${m.open.medianAgeDays !== null ? `, median age ${m.open.medianAgeDays}d` : ''}`);
    for (const i of m.open.oldest.slice(0, 3)) {
      p(`    ${pad(i.key, 11)} ${pad(i.priority, 8)} ${String(i.ageDays ?? '?').padStart(3)}d  ${i.summary.slice(0, 44)}`);
    }
    p('');
  }

  if (m.unclassified.length) {
    p(`  ⚠ ${m.unclassified.length} bug(s) have no detection phase and are excluded from every rate.`);
    p('');
  }
  if (m.meta.smallSample) {
    p(`  ⓘ Small sample (${m.overall.total} < ${m.meta.minSampleForTrend}) — read the counts, not the percentage.`);
    p('');
  }

  return L.join('\n');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const config = loadConfig();

  if (opts.jqlOnly) {
    process.stdout.write(
      `Run this over MCP, then write the result to ${config.paths.issues}:\n\n`
      + `  cloudId: ${config.cloudId}\n`
      + `  jql:     ${exportJql(config, opts)}\n`
      + `  fields:  ${JSON.stringify(exportFields(config))}\n\n`
      + 'Write it as {"fetchedAt": "<iso>", "jql": "<jql>", "issues": [ ...the issues array... ]}.\n'
    );
    return 0;
  }

  const file = opts.issues || config.paths.issues;
  const raw = read(file);
  if (!raw) {
    throw new Error(
      `No export at ${file}. Run with --jql to get the query, fetch it over MCP, and write the result there.`
    );
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${rel(file)} is not valid JSON: ${err.message}`);
  }

  const issues = Array.isArray(payload) ? payload : payload.issues;
  if (!Array.isArray(issues)) {
    throw new Error(`${rel(file)} has no "issues" array.`);
  }
  if (!issues.length) {
    throw new Error(`${rel(file)} contains no bugs — nothing to measure.`);
  }

  const metrics = computeMetrics(issues, config, {
    asOf: opts.asOf,
    jql: payload.jql,
    fetchedAt: payload.fetchedAt,
  });

  if (opts.json) {
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return 0;
  }

  const metricsPath = writeOut(config, 'metrics.json', metrics);
  const reportPath = writeOut(config, 'leakage-report.md', renderReport(metrics, config));

  process.stdout.write(`${renderTerminal(metrics)}\n`);
  process.stdout.write(`  Report  ${reportPath}\n  Metrics ${metricsPath}\n`);
  return 0;
}

if (require.main === module) {
  try {
    process.exitCode = main();
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { parseArgs, ratesTable, renderReport, renderTerminal, main };
