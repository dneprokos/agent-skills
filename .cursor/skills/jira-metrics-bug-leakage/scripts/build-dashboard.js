'use strict';

/**
 * Render `.bug-leakage/metrics.json` into a self-contained dashboard page.
 *
 * Every number comes from metrics.json, which `leakage.js` wrote, so the
 * dashboard and the markdown report can never disagree. The page is published
 * as an Artifact; it must therefore be self-contained apart from Google Fonts,
 * which is the one external host the Artifact CSP admits.
 *
 * Usage:
 *   node .claude/skills/jira-metrics-bug-leakage/scripts/build-dashboard.js
 *   node scripts/build-dashboard.js --metrics <file> --out dashboard.html
 */

const {
  loadConfig,
  read,
  writeOut,
  template,
  render,
  pct,
  issueUrlBase,
} = require('./lib');

const USAGE = `
Usage: node .claude/skills/jira-metrics-bug-leakage/scripts/build-dashboard.js [options]

  --metrics <file>   metrics to render (default: <outDir>/metrics.json)
  --out <name>       output file name (default: dashboard.html)
  --help
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
      case '--metrics': opts.metrics = next(); break;
      case '--out': opts.out = next(); break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Escape for HTML text and attribute contexts. Bug summaries contain quotes. */
function esc(s) {
  return String(s === null || s === undefined ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/* ------------------------------------------------------------------ *
 * Pieces
 * ------------------------------------------------------------------ */

/**
 * The headline proportion bar: escaped on the left, caught on the right, with a
 * 2px surface gap between them and the target drawn as a marker across both.
 */
function proportionSegments(m) {
  if (!m.overall.total) return '<div class="prop-seg contained" style="flex:1 1 100%"></div>';
  const leaked = (m.overall.leaked / m.overall.total) * 100;
  const contained = 100 - leaked;
  const tip = (label, n, share) => esc(`<b>${label}</b><br>${plural(n, 'defect', 'defects')} · ${pct(share)}`);

  return [
    m.overall.leaked
      ? `<div class="prop-seg leaked" style="flex:0 0 calc(${leaked.toFixed(2)}% - 1px)" data-tip="${tip('Escaped to production', m.overall.leaked, leaked / 100)}"></div>`
      : '',
    m.overall.contained
      ? `<div class="prop-seg contained" style="flex:0 0 calc(${contained.toFixed(2)}% - 1px)" data-tip="${tip('Caught before release', m.overall.contained, contained / 100)}"></div>`
      : '',
  ].join('');
}

/** The target line across the proportion bar, positioned by the target rate. */
function targetMarker(m) {
  if (m.target === null || m.target === undefined) return '';
  const left = Math.min(100, Math.max(0, m.target * 100));
  return `<div class="prop-target" style="left:${left.toFixed(2)}%" data-label="target ${pct(m.target, 0)}"></div>`;
}

function tile(label, value, sub, cls) {
  return `<div class="tile">
        <div class="tile-label">${esc(label)}</div>
        <div class="tile-value${cls ? ` ${cls}` : ''}">${esc(value)}</div>
        <div class="tile-sub">${sub}</div>
      </div>`;
}

function tiles(m) {
  const weightedGap = m.weighted.rate !== null && m.overall.rate !== null
    ? m.weighted.rate - m.overall.rate
    : null;
  const weightedSub = weightedGap === null
    ? 'by priority weight'
    : Math.abs(weightedGap) < 0.02
      ? 'in line with the raw rate'
      : weightedGap > 0
        ? `${pct(weightedGap)} worse than raw — the serious ones escape`
        : `${pct(-weightedGap)} better than raw — mostly minor escapes`;

  return [
    tile('Containment', pct(m.containmentRate), `${plural(m.overall.contained, 'defect', 'defects')} caught before release`),
    tile('Weighted leakage', pct(m.weighted.rate), weightedSub),
    tile(
      'Open in production',
      String(m.open.leakedOpen),
      m.open.medianAgeDays === null
        ? 'none outstanding'
        : `median age ${plural(m.open.medianAgeDays, 'day', 'days')}`
    ),
    tile(
      'Unclassified',
      String(m.unclassified.length),
      m.unclassified.length ? 'no phase set — excluded from every rate' : 'every defect is classified',
      m.unclassified.length ? 'warn' : ''
    ),
  ].join('\n      ');
}

/** One horizontal bar row: label, fill anchored left with a rounded data end, rate, count. */
function barRows(rows, kind) {
  if (!rows.length) return '<p class="section-note">No data.</p>';
  const max = Math.max(...rows.map((r) => r.rate || 0), 0.0001);

  return rows.map((r) => {
    const width = r.rate ? Math.max(2, (r.rate / max) * 100) : 0;
    const tip = esc(
      `<b>${r.name}</b><br>${plural(r.leaked, 'escape', 'escapes')} of ${r.total}`
      + `<br>leakage ${pct(r.rate)} · caught ${r.contained}`
    );
    return `<div class="bar-row" data-tip="${tip}">
          <div class="bar-name">${esc(r.name)}</div>
          <div class="bar-track"><div class="bar-fill${r.leaked ? '' : ' zero'}" style="width:${r.leaked ? width.toFixed(2) : 100}%"></div></div>
          <div class="bar-pct">${pct(r.rate, 0)}</div>
          <div class="bar-count">${r.leaked}/${r.total}</div>
        </div>`;
  }).join('\n        ') + `\n        <!-- ${kind} -->`;
}

/**
 * The monthly trend, as an area-backed line with an emphasised final point and
 * a dashed target rule.
 *
 * Suppressed below two months: a "trend" drawn through one point is a decoration
 * that invites a conclusion the data cannot support.
 */
function trendSection(m) {
  if (m.byMonth.length < 2) {
    const only = m.byMonth[0];
    return `<section class="panel">
    <h2>Trend</h2>
    <p class="section-note">${
  only
    ? `Every classified defect so far was raised in ${esc(only.name)}, so there is nothing to trend yet. `
        + 'A second month of data turns this into a line.'
    : 'No dated defects yet.'
}</p>
  </section>`;
  }

  const W = 900;
  const H = 260;
  const pad = { top: 22, right: 26, bottom: 34, left: 46 };
  const plotW = W - pad.left - pad.right;
  const plotH = H - pad.top - pad.bottom;

  const points = m.byMonth.map((r) => ({ ...r, value: r.rate === null ? 0 : r.rate }));
  const maxRate = Math.max(...points.map((p) => p.value), m.target || 0, 0.1);
  const yMax = Math.min(1, Math.ceil(maxRate * 10) / 10);

  const x = (i) => pad.left + (points.length === 1 ? plotW / 2 : (i / (points.length - 1)) * plotW);
  const y = (v) => pad.top + plotH - (v / yMax) * plotH;

  const gridLines = [];
  const ticks = 4;
  for (let i = 0; i <= ticks; i += 1) {
    const v = (yMax / ticks) * i;
    const yy = y(v).toFixed(1);
    gridLines.push(`<line class="grid-line" x1="${pad.left}" y1="${yy}" x2="${W - pad.right}" y2="${yy}" />`);
    gridLines.push(`<text class="tick" x="${pad.left - 9}" y="${yy}" text-anchor="end" dominant-baseline="middle">${pct(v, 0)}</text>`);
  }

  const line = points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.top + plotH).toFixed(1)} L${x(0).toFixed(1)},${(pad.top + plotH).toFixed(1)} Z`;

  const dots = points.map((p, i) => {
    const last = i === points.length - 1;
    const tip = esc(`<b>${p.name}</b><br>leakage ${pct(p.rate)}<br>${p.leaked} escaped of ${p.total}`);
    return `<circle class="point${last ? ' point-last' : ''}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="${last ? 6 : 4.5}" data-tip="${tip}"><title>${esc(`${p.name}: ${pct(p.rate)}`)}</title></circle>`;
  }).join('\n      ');

  const xLabels = points.map((p, i) => `<text class="tick" x="${x(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${esc(p.name)}</text>`).join('\n      ');

  const targetY = m.target !== null && m.target <= yMax ? y(m.target) : null;
  const targetLine = targetY === null ? '' : `
      <line class="target-line" x1="${pad.left}" y1="${targetY.toFixed(1)}" x2="${W - pad.right}" y2="${targetY.toFixed(1)}" />
      <text class="tick" x="${W - pad.right}" y="${(targetY - 7).toFixed(1)}" text-anchor="end">target ${pct(m.target, 0)}</text>`;

  const rows = m.byMonth.map((r) => `<tr><td class="key">${esc(r.name)}</td><td class="num">${r.leaked}</td><td class="num">${r.contained}</td><td class="num">${pct(r.rate)}</td></tr>`).join('\n            ');

  return `<section class="panel">
    <h2>Trend</h2>
    <p class="section-note">Leakage rate by the month each defect was raised. The dashed rule is the ${pct(m.target, 0)} target.</p>
    <div class="chart-wrap">
      <svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Leakage rate by month">
      ${gridLines.join('\n      ')}
      <line class="axis-line" x1="${pad.left}" y1="${pad.top + plotH}" x2="${W - pad.right}" y2="${pad.top + plotH}" />${targetLine}
      <path class="series-area" d="${area}" />
      <path class="series-line" d="${line}" />
      ${dots}
      ${xLabels}
      </svg>
    </div>
    <div class="table-wrap" style="margin-top:18px">
      <table>
        <caption>The same figures, as read by a screen reader or copied into a report.</caption>
        <thead><tr><th>Month</th><th class="num">Escaped</th><th class="num">Caught</th><th class="num">Leakage</th></tr></thead>
        <tbody>
            ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

/** The escaped defects that are still open, oldest first. */
function openSection(m, config) {
  if (!m.leakedIssues.length) {
    return `<section class="panel">
    <h2>Escaped defects</h2>
    <p class="section-note">Nothing has been recorded as found in production.</p>
  </section>`;
  }

  const base = issueUrlBase(config);
  const open = m.leakedIssues.filter((i) => !i.resolved);
  const byKey = new Map(m.open.oldest.map((i) => [i.key, i.ageDays]));

  const rows = m.leakedIssues.map((i) => `<tr>
            <td class="key"><a href="${base}/${esc(i.key)}" target="_blank" rel="noopener">${esc(i.key)}</a></td>
            <td><span class="sev p-${esc(i.priority)}">${esc(i.priority)}</span></td>
            <td>${esc(i.area)}</td>
            <td>${esc(i.status)}</td>
            <td class="num">${byKey.has(i.key) ? byKey.get(i.key) : '—'}</td>
            <td>${esc(i.summary)}</td>
          </tr>`).join('\n          ');

  return `<section class="panel">
    <h2>Escaped defects</h2>
    <p class="section-note">${plural(open.length, 'defect is', 'defects are')} still open in production${
  m.open.medianDaysToFix !== null ? `; resolved ones took a median of ${plural(m.open.medianDaysToFix, 'day', 'days')} to fix` : ''
}. Age counts days since the defect was raised.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Key</th><th>Priority</th><th>Area</th><th>Status</th><th class="num">Age</th><th>Summary</th></tr></thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    </div>
  </section>`;
}

/** Data-quality and sample-size warnings, when either applies. */
function noticeSection(m) {
  const notes = [];

  if (m.unclassified.length) {
    const keys = m.unclassified.slice(0, 12).map((i) => esc(i.key)).join(', ');
    notes.push(`<p><b>${plural(m.unclassified.length, 'defect has', 'defects have')} no ${esc(m.meta.phaseField)} set</b>, `
      + 'so they count towards neither side and are excluded from every rate above. '
      + `Setting the field on ${m.unclassified.length === 1 ? 'it' : 'them'} will move the headline.</p>`
      + `<p><code>${keys}${m.unclassified.length > 12 ? ` and ${m.unclassified.length - 12} more` : ''}</code></p>`);
  }

  if (m.meta.smallSample && m.overall.total) {
    notes.push(`<p><b>Small sample.</b> ${plural(m.overall.total, 'classified defect', 'classified defects')} is below the `
      + `${m.meta.minSampleForTrend} this report treats as enough for a stable percentage — one more defect moves the `
      + `headline by ${pct(1 / (m.overall.total + 1))}. Read the counts, not the rate.</p>`);
  }

  if (!notes.length) return '';

  return `<section class="notice">
    <span class="marker">!</span>
    <div>${notes.join('\n      ')}</div>
  </section>`;
}

/* ------------------------------------------------------------------ *
 * Assembly
 * ------------------------------------------------------------------ */

function buildDashboard(m, config) {
  const statusClass = m.status === 'on target' ? 'is-ok' : m.status === 'above target' ? 'is-warn' : 'is-over';

  const standfirst = m.overall.rate === null
    ? `No defect in ${config.projectKey} carries a ${m.meta.phaseField}, so leakage cannot be measured yet.`
    : `${pct(m.overall.rate)} of the defects raised against ${config.projectKey} were found in production rather than `
      + `before release. The target is ${pct(m.target, 0)} or lower.`;

  const weights = Object.entries(config.priorityWeights).map(([k, v]) => `${k} ${v}`).join(', ');

  return render(template('dashboard.template.html'), {
    docTitle: `${config.projectKey} Bug Leakage`,
    project: config.projectKey,
    issueType: config.issueType,
    asOfDate: m.meta.asOf.slice(0, 10),
    headline: 'Where defects are being found',
    standfirst,
    leakagePct: pct(m.overall.rate),
    leakedCount: String(m.overall.leaked),
    containedCount: String(m.overall.contained),
    classifiedCount: String(m.overall.total),
    statusClass,
    statusLabel: m.status,
    proportionSegments: proportionSegments(m),
    targetMarker: targetMarker(m),
    tiles: tiles(m),
    trendSection: trendSection(m),
    priorityBars: barRows(m.byPriority, 'priority'),
    areaBars: barRows(m.byArea, 'area'),
    openSection: openSection(m, config),
    noticeSection: noticeSection(m),
    phaseFieldName: esc(m.meta.phaseField),
    weightSummary: esc(weights),
    sourceLine: esc(
      `${m.meta.jql || 'unknown query'}${m.meta.fetchedAt ? ` — fetched ${m.meta.fetchedAt}` : ''}`
    ),
  });
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  const config = loadConfig();
  const file = opts.metrics || `${config.paths.outDir}/metrics.json`;
  const raw = read(file);
  if (!raw) throw new Error(`No metrics at ${file}. Run leakage.js first.`);

  const html = buildDashboard(JSON.parse(raw), config);
  const target = writeOut(config, opts.out || 'dashboard.html', html);
  process.stdout.write(`dashboard -> ${target}\n`);
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

module.exports = {
  parseArgs,
  esc,
  proportionSegments,
  targetMarker,
  tiles,
  barRows,
  trendSection,
  openSection,
  noticeSection,
  buildDashboard,
  main,
};
