'use strict';

/**
 * Print the created bug from `assets/created-bug.template.md`.
 *
 * Run after the MCP create call succeeds. It reads the same draft the preview
 * was built from and stamps the key Jira returned, so the confirmation the user
 * sees is derived from what was actually sent rather than retyped from memory.
 *
 * Usage:
 *   node scripts/render-created.js --key SCRUM-179
 *   node scripts/render-created.js --key SCRUM-179 --duplicate-of SCRUM-167 --draft .jira-bug/draft.json
 */

const path = require('path');
const fs = require('fs');

const {
  REPO_ROOT,
  loadConfig,
  read,
  writeOut,
  template,
  render,
  indentSteps,
  oneLine,
  issueUrl,
} = require('./lib');

const USAGE = `
Usage: node .claude/skills/jira-bug-creator/scripts/render-created.js --key <ISSUE-KEY> [options]

  --key <key>            the key Jira returned, e.g. SCRUM-179   (required)
  --draft <file>         draft to render (default: <outDir>/draft.json)
  --duplicate-of <keys>  comma-separated keys the duplicate check surfaced
  --archive              also copy the draft to <outDir>/<key>.json
  --help
`;

function parseArgs(argv) {
  const opts = { duplicates: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${arg} needs a value`);
      i += 1;
      return v;
    };
    switch (arg) {
      case '--key': opts.key = next(); break;
      case '--draft': opts.draft = next(); break;
      case '--duplicate-of': opts.duplicates = next().split(',').map((s) => s.trim()).filter(Boolean); break;
      case '--archive': opts.archive = true; break;
      case '--help': case '-h': opts.help = true; break;
      default:
        if (arg.startsWith('--')) throw new Error(`Unknown flag: ${arg}`);
    }
  }
  return opts;
}

/**
 * Fill the terminal template.
 * @param {object} draft
 * @param {object} config
 * @param {{key: string, duplicates: string[], draftPath: string}} ctx
 * @returns {string}
 */
function renderCreated(draft, config, ctx) {
  const dedupeBlock = ctx.duplicates.length
    ? `  ⚠ Possible duplicates flagged before filing: ${ctx.duplicates
      .map((k) => `${k} (${issueUrl(config, k)})`)
      .join(', ')}\n`
    : '';

  const inferredBlock = (draft.inferred || []).length
    ? `  ⓘ Inferred, not stated by the input: ${draft.inferred.join('; ')}\n`
    : '';

  return render(template('created-bug.template.md'), {
    key: ctx.key,
    url: issueUrl(config, ctx.key),
    summary: draft.summary,
    projectKey: config.projectKey,
    projectName: config.projectName,
    issueType: config.issueType,
    phase: draft.phase,
    priority: draft.priority,
    labels: (draft.labels || []).join(', ') || '(none)',
    version: draft.version,
    source: draft.source || 'manual',
    stepsIndented: indentSteps(draft.steps),
    expectedOneLine: oneLine(draft.expected),
    actualOneLine: oneLine(draft.actual),
    dedupeBlock,
    inferredBlock,
    draftPath: ctx.draftPath,
  });
}

function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  if (opts.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!opts.key) throw new Error('--key is required. Pass the issue key the create call returned.');
  if (!/^[A-Z][A-Z0-9]+-\d+$/.test(opts.key)) throw new Error(`"${opts.key}" is not an issue key.`);

  const config = loadConfig();
  const draftPath = opts.draft || path.posix.join(config.paths.outDir, 'draft.json');
  const raw = read(draftPath);
  if (!raw) throw new Error(`No draft at ${draftPath}. Pass --draft, or re-run draft-bug.js.`);
  const draft = JSON.parse(raw);

  process.stdout.write(`${renderCreated(draft, config, { key: opts.key, duplicates: opts.duplicates, draftPath })}\n`);

  if (opts.archive) {
    const archived = writeOut(config, `${opts.key}.json`, { key: opts.key, url: issueUrl(config, opts.key), ...draft });
    process.stdout.write(`  Archived to ${archived}\n`);
  }
  void fs;
  void REPO_ROOT;
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

module.exports = { parseArgs, renderCreated, main };
