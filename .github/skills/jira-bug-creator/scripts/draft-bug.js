'use strict';

/**
 * Turn a failure, a scan finding or a set of `--set` values into a complete bug
 * draft, and print it for review.
 *
 * Writes `.jira-bug/draft.json` and prints:
 *   - the rendered bug exactly as it will appear in Jira
 *   - the JQL that finds possible duplicates
 *   - a MISSING block naming any required field the input could not supply
 *
 * Exit codes:
 *   0  the draft is complete and ready to create
 *   2  required fields are missing or invalid — the MISSING/INVALID block says which
 *   1  the input itself could not be read or parsed
 *
 * Nothing here contacts Jira. Creation is an MCP call the agent makes after the
 * user has seen this preview.
 */

const { execFileSync } = require('child_process');

const {
  REPO_ROOT,
  loadConfig,
  read,
  rel,
  writeOut,
  emptyDraft,
  missingFields,
  invalidFields,
  formatSteps,
  renderDescription,
  toCreatePayload,
  dedupeJql,
} = require('./lib');

const USAGE = `
Usage: node .claude/skills/jira-bug-creator/scripts/draft-bug.js <source> [options]

Sources (exactly one):
  --playwright [file]     a Playwright JSON report (default: config paths.playwrightReport)
  --finding <selector>    a static-defect-scan finding: rule id, subject, or index
  --manual                start from an empty draft
  --draft <file>          reload an existing draft to refine it

Options:
  --index <n>             which failure or finding, when the source has several
  --list                  list the candidates in the source and stop
  --findings <file>       override .static-scan/findings.json
  --base-url <url>        the environment the test ran against (drives phase inference)
  --env <name>            production | development — sets the phase explicitly
  --set key=value         set any draft field; repeatable
  --set steps+=text       append one reproduction step
  --set labels+=name      append one label
  --json                  print the draft as JSON instead of the human preview
  --help                  this text

Examples:
  node scripts/draft-bug.js --playwright --list
  node scripts/draft-bug.js --playwright --index 2 --base-url https://retro.example.com
  node scripts/draft-bug.js --finding CM-02 --set phase=Production
  node scripts/draft-bug.js --manual --set summary="Search box ignores quotes"
  node scripts/draft-bug.js --draft .jira-bug/draft.json --set priority=High
`;

/* ------------------------------------------------------------------ *
 * CLI
 * ------------------------------------------------------------------ */

function parseArgs(argv) {
  const opts = { sets: [], index: null, list: false, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--playwright':
        opts.source = 'playwright';
        if (argv[i + 1] && !argv[i + 1].startsWith('--')) opts.file = next();
        break;
      case '--finding': opts.source = 'finding'; opts.selector = next(); break;
      case '--manual': opts.source = 'manual'; break;
      case '--draft': opts.source = 'draft'; opts.file = next(); break;
      case '--findings': opts.findingsFile = next(); break;
      case '--index': opts.index = parseInt(next(), 10); break;
      case '--base-url': opts.baseUrl = next(); break;
      case '--env': opts.env = next().toLowerCase(); break;
      case '--set': opts.sets.push(next()); break;
      case '--list': opts.list = true; break;
      case '--json': opts.json = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/** Current branch and short sha, for the Version field. */
function gitVersion() {
  const git = (args) => {
    try {
      return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    } catch (err) {
      return '';
    }
  };
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const sha = git(['rev-parse', '--short', 'HEAD']);
  return branch && sha ? `${branch} @ ${sha}` : 'unknown';
}

/* ------------------------------------------------------------------ *
 * Source: Playwright JSON report
 * ------------------------------------------------------------------ */

/**
 * Every failed spec in a Playwright JSON report, flattened out of the nested
 * suite tree. Only the last attempt of each spec is reported: with retries on,
 * the earlier attempts are the same failure and would each become a ticket.
 *
 * @param {object} report parsed results.json
 * @returns {Array<object>} one entry per failed spec
 */
function playwrightFailures(report) {
  const out = [];

  const visit = (suites, trail) => {
    for (const suite of suites || []) {
      // Playwright's outermost suite per file is titled with the file name, and
      // repeating it makes the breadcrumb read "search.spec.js > Catalogue
      // search" when only the second half describes any behaviour.
      const isFileSuite = suite.title && suite.file && suite.title === suite.file;
      const here = suite.title && !isFileSuite ? [...trail, suite.title] : trail;
      for (const spec of suite.specs || []) {
        if (spec.ok) continue;
        for (const test of spec.tests || []) {
          const attempts = test.results || [];
          const last = attempts[attempts.length - 1];
          if (!last || last.status === 'passed' || last.status === 'skipped') continue;
          out.push({
            title: spec.title,
            suitePath: here,
            file: spec.file,
            line: spec.line,
            project: test.projectName || '',
            status: last.status,
            retries: attempts.length - 1,
            durationMs: last.duration,
            errors: (last.errors || []).map((e) => e.message || '').filter(Boolean),
            snippet: (last.errors || []).map((e) => e.snippet).filter(Boolean)[0] || '',
            attachments: (last.attachments || []).map((a) => ({ name: a.name, path: a.path })),
            stdout: (last.stdout || []).map((c) => c.text || '').join('').slice(0, 2000),
          });
        }
      }
      visit(suite.suites, here);
    }
  };
  visit(report.suites, []);
  return out;
}

/** Strip the ANSI colouring Playwright writes into error messages. */
function stripAnsi(s) {
  // eslint-disable-next-line no-control-regex
  return String(s || '').replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * The first line of a Playwright error, which is the assertion itself rather
 * than the stack — that is what belongs in a summary.
 */
function errorHeadline(errors) {
  const lines = stripAnsi(errors[0] || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'the test failed with no error message';

  // `expect(received).toHaveCount(expected)` names the matcher and says nothing
  // about the failure. The Expected/Received pair underneath is the fact worth
  // putting in a summary.
  const expected = lines.find((l) => /^Expected:/i.test(l));
  const received = lines.find((l) => /^Received:/i.test(l));
  if (expected && received) {
    return `${expected.replace(/^Expected:\s*/i, 'expected ')}, ${received.replace(/^Received:\s*/i, 'received ')}`;
  }

  const head = lines[0].replace(/^Error:\s*/, '');
  if (/^expect\(/.test(head) && lines[1]) return `${head} — ${lines[1]}`;
  return head;
}

/**
 * Repo-shaped values, with defaults for a project whose config predates the
 * `repo` section. Everything a bug report says about *this* codebase — where
 * the specs live, how to run one, what must be up first — is configuration, not
 * code: the same skill copied into another repository would otherwise file
 * reproduction steps naming directories that do not exist there.
 */
function repoConfig(config) {
  return {
    defaultBaseUrl: 'http://localhost:3000',
    testCommand: 'npx playwright test {file} -g "{title}"',
    testPathPrefix: '',
    playwrightPreconditions: [],
    findingPreconditions: [],
    ...(config.repo || {}),
  };
}

/** Turn one failed spec into a draft. */
function draftFromPlaywright(failure, opts, config) {
  const repo = repoConfig(config);
  const draft = emptyDraft();
  const baseUrl = opts.baseUrl || process.env.BASE_URL || repo.defaultBaseUrl;
  const isProdUrl = !/localhost|127\.0\.0\.1|0\.0\.0\.0/.test(baseUrl);

  draft.source = `Playwright · ${failure.file}:${failure.line} · ${failure.project || 'chromium'}`;
  draft.summary = `${failure.title} — ${errorHeadline(failure.errors)}`.slice(0, 255);
  draft.phase = opts.env
    ? (opts.env.startsWith('prod') ? 'Production' : 'Development')
    : (isProdUrl ? 'Production' : 'Development');
  draft.priority = config.fields.priority.default;
  draft.version = `${gitVersion()} against ${baseUrl}`;

  draft.initialCondition = [
    `- Application running and reachable at ${baseUrl}.`,
    ...repo.playwrightPreconditions,
    `- Suite: \`${failure.file}\`, project \`${failure.project || 'chromium'}\`.`,
  ].join('\n');

  const command = repo.testCommand
    .replace('{file}', failure.file)
    .replace('{title}', failure.title.replace(/"/g, '\\"'));

  draft.steps = [
    'Start the application and confirm the base URL above responds.',
    `Run the failing spec on its own:\n\`\`\`\n${command}\n\`\`\``,
    'Read the assertion the run reports.',
  ];

  draft.expected = `\`${failure.title}\` passes. ${
    failure.suitePath.length ? `It belongs to ${failure.suitePath.join(' › ')}, which describes the behaviour being asserted.` : ''
  }`.trim();

  const body = stripAnsi(failure.errors.join('\n\n')).split('\n').slice(0, 30).join('\n');
  draft.actual = [
    `The spec ends \`${failure.status}\`${failure.retries ? ` after ${failure.retries} retry attempt(s)` : ''}.`,
    '',
    '```',
    body || '(no error text captured)',
    '```',
  ].join('\n');

  const evidence = [];
  if (failure.snippet) evidence.push(['```', stripAnsi(failure.snippet).trim(), '```'].join('\n'));
  const attachments = failure.attachments
    .filter((a) => a.path)
    .map((a) => `- ${a.name}: \`${rel(a.path)}\``);
  if (attachments.length) evidence.push(attachments.join('\n'));
  if (failure.stdout.trim()) {
    evidence.push(`- Captured stdout:\n\`\`\`\n${failure.stdout.trim().slice(0, 800)}\n\`\`\``);
  }
  draft.evidence = evidence.join('\n\n');

  draft.affectedTests = `- \`${repo.testPathPrefix}${failure.file}\` — \`${failure.title}\` (line ${failure.line}) is the failing case.`;
  draft.labels = [...config.sourceLabels.playwright];
  draft.inferred = ['priority', 'initialCondition', 'expected'];
  if (!opts.env) draft.inferred.push('phase');
  if (!opts.baseUrl && !process.env.BASE_URL) draft.inferred.push('version (base URL assumed)');
  return draft;
}

/* ------------------------------------------------------------------ *
 * Source: static-defect-scan finding
 * ------------------------------------------------------------------ */

/**
 * Pick a finding by rule id, subject substring, or 1-based index.
 *
 * The index always applies to the *matched* subset, which is the list the
 * previous run printed. Indexing the whole file instead would silently hand
 * back a different finding than the one the user counted off the screen.
 *
 * @param {object[]} findings
 * @param {string|undefined} selector
 * @param {number|null} index 1-based, within the matches
 * @returns {{picked: object|null, candidates: object[]}}
 */
function selectFinding(findings, selector, index) {
  const needle = String(selector || '').toLowerCase();
  const matches = selector
    ? findings.filter(
      (f) => f.rule.toLowerCase() === needle
        || String(f.subject).toLowerCase().includes(needle)
        || `${f.rule} ${f.subject}`.toLowerCase() === needle
    )
    : findings;

  if (index !== null) {
    if (index < 1 || index > matches.length) {
      throw new Error(`--index ${index} is out of range; ${matches.length} finding(s) matched.`);
    }
    return { picked: matches[index - 1], candidates: [] };
  }
  if (matches.length === 1) return { picked: matches[0], candidates: [] };
  return { picked: null, candidates: matches.length ? matches : findings };
}

/** Turn one scan finding into a draft. */
function draftFromFinding(finding, opts, config) {
  const repo = repoConfig(config);
  const draft = emptyDraft();

  draft.source = `static-defect-scan · ${finding.rule} · ${finding.confidence}`;
  draft.summary = `${finding.subject}: ${finding.title}`.slice(0, 255);
  draft.phase = opts.env && opts.env.startsWith('prod') ? 'Production' : 'Development';
  draft.priority = config.severityToPriority[finding.severity] || config.fields.priority.default;
  draft.version = gitVersion();

  draft.initialCondition = repo.findingPreconditions.join('\n');

  draft.steps = finding.repro
    ? [finding.repro, 'Compare the response status and body with the expectation below.']
    : [];

  draft.expected = `The rule the code already declares is enforced where the caller can see it. ${finding.fix || ''}`.trim();
  draft.actual = finding.consequence;

  draft.rootCause = (finding.layers || [])
    .map((l) => `- \`${l.file}${l.line ? `:${l.line}` : ''}\` — ${l.layer}: ${l.detail}`)
    .join('\n');

  draft.affectedTests = 'See section 7 of `.static-scan/scan-report.md` for the coverage gap behind this finding.';
  draft.labels = [...config.sourceLabels.finding, finding.rule, finding.pack];
  draft.inferred = ['initialCondition', 'affectedTests'];
  if (!finding.repro) draft.inferred.push('steps (the finding carried no reproduction)');
  if (finding.confidence === 'suspected') {
    draft.inferred.push('the finding is "suspected" — confirm against the source before filing');
  }
  return draft;
}

/* ------------------------------------------------------------------ *
 * --set
 * ------------------------------------------------------------------ */

/**
 * Apply `--set key=value`, `--set steps+=text` and `--set labels+=name`.
 * `\n` in a value becomes a real newline so multi-line fields can be passed on
 * one command line.
 */
function applySets(draft, sets) {
  for (const raw of sets) {
    const append = raw.includes('+=') && raw.indexOf('+=') < (raw.indexOf('=') === -1 ? Infinity : raw.indexOf('=') + 1);
    const sep = append ? '+=' : '=';
    const at = raw.indexOf(sep);
    if (at === -1) throw new Error(`--set needs key=value or key+=value, got "${raw}"`);
    const key = raw.slice(0, at).trim();
    const value = raw.slice(at + sep.length).replace(/\\n/g, '\n');

    if (!(key in draft)) throw new Error(`Unknown draft field "${key}". Known: ${Object.keys(draft).join(', ')}`);
    if (append) {
      if (!Array.isArray(draft[key])) throw new Error(`"${key}" is not a list, use ${key}= instead of ${key}+=`);
      draft[key].push(value);
    } else if (Array.isArray(draft[key])) {
      draft[key] = value === '' ? [] : value.split('|').map((s) => s.trim());
    } else {
      draft[key] = value;
    }
    // A field the user set is no longer an inference.
    draft.inferred = (draft.inferred || []).filter((i) => !i.startsWith(key));
  }
  return draft;
}

/* ------------------------------------------------------------------ *
 * Output
 * ------------------------------------------------------------------ */

function printPreview(draft, config, missing, invalid, draftPath) {
  const out = [];
  const rule = '─'.repeat(72);

  out.push(rule);
  out.push('BUG DRAFT — not filed yet');
  out.push(rule);
  out.push('');
  out.push(`  Summary   ${draft.summary || '(missing)'}`);
  out.push(`  Project   ${config.projectKey} / ${config.issueType}`);
  out.push(`  Phase     ${draft.phase || '(missing)'}   [${config.fields.detectionPhase.name}]`);
  out.push(`  Priority  ${draft.priority || '(missing)'}`);
  out.push(`  Labels    ${(draft.labels || []).join(', ') || '(none)'}`);
  out.push(`  Source    ${draft.source}`);
  out.push('');
  out.push(rule);
  out.push('DESCRIPTION AS IT WILL APPEAR IN JIRA');
  out.push(rule);
  out.push('');
  out.push(renderDescription(draft));
  out.push(rule);

  if (draft.inferred && draft.inferred.length) {
    out.push('');
    out.push('INFERRED — the input did not state these; check them before filing:');
    for (const i of draft.inferred) out.push(`  · ${i}`);
  }

  if (invalid.length) {
    out.push('');
    out.push('INVALID:');
    for (const p of invalid) out.push(`  · ${p}`);
  }

  if (missing.length) {
    out.push('');
    out.push('MISSING — ask the user for each of these, then re-run with --set:');
    for (const f of missing) out.push(`  · ${f.key}: ${f.ask}`);
    out.push('');
    out.push(`  node .claude/skills/jira-bug-creator/scripts/draft-bug.js --draft ${draftPath} \\`);
    out.push(`    ${missing.map((f) => `--set ${f.key}="…"`).join(' \\\n    ')}`);
  } else {
    out.push('');
    out.push('READY — every required field is present.');
    out.push(`Duplicate check: ${draft.dedupeJql}`);
  }

  out.push('');
  out.push(`Draft saved to ${draftPath}`);
  return out.join('\n');
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help || !opts.source) {
    process.stdout.write(USAGE);
    return opts.help ? 0 : 1;
  }

  const config = loadConfig();
  let draft;

  if (opts.source === 'playwright') {
    const file = opts.file || config.paths.playwrightReport;
    const raw = read(file);
    if (!raw) throw new Error(`No Playwright report at ${file}. Run the suite, or pass the path.`);
    let report;
    try {
      report = JSON.parse(raw);
    } catch (err) {
      throw new Error(`${file} is not valid JSON: ${err.message}`);
    }

    const failures = playwrightFailures(report);
    if (!failures.length) {
      process.stdout.write(
        `No failed specs in ${rel(file)} — ${report.stats ? `${report.stats.expected} passed, ${report.stats.unexpected} failed` : 'the report records no failures'}.\n`
        + 'Nothing to file. Use --manual if you are filing something the suite did not catch.\n'
      );
      return 1;
    }
    if (opts.list || (failures.length > 1 && opts.index === null)) {
      const lines = failures.map((f, i) => `  ${i + 1}. ${f.title}\n     ${f.file}:${f.line} — ${errorHeadline(f.errors)}`);
      process.stdout.write(`${failures.length} failed spec(s) in ${rel(file)}:\n${lines.join('\n')}\n\nRe-run with --index <n>.\n`);
      return opts.list ? 0 : 2;
    }
    const chosen = failures[(opts.index || 1) - 1];
    if (!chosen) throw new Error(`--index ${opts.index} is out of range; the report has ${failures.length} failure(s).`);
    draft = draftFromPlaywright(chosen, opts, config);
  } else if (opts.source === 'finding') {
    const file = opts.findingsFile || config.paths.scanFindings;
    const raw = read(file);
    if (!raw) throw new Error(`No findings at ${file}. Run \`npm run scan\` first.`);
    const findings = JSON.parse(raw).findings || [];
    if (!findings.length) throw new Error(`${rel(file)} contains no findings.`);

    const { picked, candidates } = selectFinding(findings, opts.selector, opts.index);
    if (!picked) {
      const lines = candidates.slice(0, 25).map((f, i) => `  ${i + 1}. [${f.severity}/${f.confidence}] ${f.rule} ${f.subject}`);
      process.stdout.write(
        `"${opts.selector}" matched ${candidates.length} finding(s):\n${lines.join('\n')}\n\nRe-run with --index <n>.\n`
      );
      return 2;
    }
    draft = draftFromFinding(picked, opts, config);
  } else if (opts.source === 'draft') {
    const raw = read(opts.file);
    if (!raw) throw new Error(`No draft at ${opts.file}.`);
    draft = { ...emptyDraft(), ...JSON.parse(raw) };
  } else {
    draft = emptyDraft();
    draft.version = gitVersion();
    draft.priority = config.fields.priority.default;
    draft.labels = [...config.sourceLabels.manual];
    draft.inferred = ['priority', 'version'];
  }

  applySets(draft, opts.sets);
  draft.dedupeJql = dedupeJql(draft, config);

  const missing = missingFields(draft);
  const invalid = invalidFields(draft, config);
  const draftPath = writeOut(config, 'draft.json', draft);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({ draft, missing, invalid, createPayload: toCreatePayload(draft, config) }, null, 2)}\n`);
  } else {
    process.stdout.write(`${printPreview(draft, config, missing, invalid, draftPath)}\n`);
  }

  return missing.length || invalid.length ? 2 : 0;
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
  playwrightFailures,
  errorHeadline,
  stripAnsi,
  draftFromPlaywright,
  selectFinding,
  draftFromFinding,
  repoConfig,
  applySets,
  printPreview,
  main,
};
