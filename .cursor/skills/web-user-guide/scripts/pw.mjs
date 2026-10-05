#!/usr/bin/env node
// Wrapper around playwright-cli for the web-user-guide skill. Three jobs:
//
//   1. Secrets never reach the transcript. `{{ENV_NAME}}` in any argument is replaced by that variable's
//      value (process env first, then ./.env), and every known secret value is replaced by `<ENV_NAME>` in
//      the command output AND in any snapshot file the command wrote — playwright-cli echoes the code it
//      ran (`fill('real@email')`) and snapshots record typed text, so both would otherwise leak.
//   2. `shot <png>` — mask identity fields, take the screenshot, and store the page's snapshot as the
//      baseline the next `check` is measured against.
//   3. `check` — snapshot the page now and print a JSON verdict: is it different enough from the last
//      screenshot to deserve a new one?
//
// Usage (session flag is required, it names the browser and the state folder):
//   node pw.mjs -s=<session> [--secrets A,B] <any playwright-cli args>
//   node pw.mjs -s=<session> [--secrets A,B] shot <path/to/NN-name.png> [--top | --keep-scroll] [--full-page]
//   node pw.mjs -s=<session> [--secrets A,B] check [--threshold 0.25]
//
// Exit codes: playwright-cli's own for pass-through; 0/1 for shot and check; 3 for a usage or env error.

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, DEFAULT_THRESHOLD } from "./snapshot-diff.mjs";

const STATE_ROOT = join(".playwright-cli", "web-user-guide");
const PLACEHOLDER = /\{\{([A-Z][A-Z0-9_]*)\}\}/g;

function die(msg, code = 3) {
  process.stderr.write(`pw: ${msg}\n`);
  process.exit(code);
}

// ---------- secrets ----------

let dotenvCache = null;
function dotenv() {
  if (dotenvCache) return dotenvCache;
  dotenvCache = {};
  const file = resolve(".env");
  if (!existsSync(file)) return dotenvCache;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    dotenvCache[m[1]] = v;
  }
  return dotenvCache;
}

// `{{GEN_<ANYTHING>}}` is a secret the run invents — a password for a demo user it creates. It is generated
// once per session, kept only in the session's state folder, and redacted like any env secret, so an
// invented password never reaches the transcript or a snapshot file either.
let generated = {};
function loadGenerated(stateDir) {
  try {
    generated = JSON.parse(readFileSync(join(stateDir, "generated.json"), "utf8"));
  } catch {
    generated = {};
  }
}
function generate(stateDir, name) {
  if (!generated[name]) {
    generated[name] = `Gd-${randomBytes(9).toString("base64url")}-9a`;
    mkdirSync(stateDir, { recursive: true });
    writeFileSync(join(stateDir, "generated.json"), JSON.stringify(generated));
  }
  return generated[name];
}

function envValue(name) {
  if (name.startsWith("GEN_")) return generated[name];
  const v = process.env[name] ?? dotenv()[name];
  return v === undefined || v === "" ? undefined : v;
}

function loadSecretNames(stateDir) {
  const f = join(stateDir, "secrets.json");
  try {
    return new Set(JSON.parse(readFileSync(f, "utf8")));
  } catch {
    return new Set();
  }
}

function saveSecretNames(stateDir, names) {
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, "secrets.json"), JSON.stringify([...names].sort()));
}

function makeRedactor(names) {
  // Longest value first, so a password containing the e-mail is not half-replaced.
  const pairs = [...names]
    .map((n) => [n, envValue(n)])
    .filter(([, v]) => v && v.length >= 3)
    .sort((a, b) => b[1].length - a[1].length);
  const redact = (text) => pairs.reduce((t, [n, v]) => t.split(v).join(`<${n}>`), text);
  redact.values = pairs.map(([, v]) => v);
  return redact;
}

function redactFile(file, redact) {
  if (!existsSync(file)) return;
  const before = readFileSync(file, "utf8");
  const after = redact(before);
  if (after !== before) writeFileSync(file, after);
}

// ---------- running playwright-cli ----------

function findCliEntry() {
  if (process.env.PLAYWRIGHT_CLI_JS && existsSync(process.env.PLAYWRIGHT_CLI_JS)) return process.env.PLAYWRIGHT_CLI_JS;
  const rel = join("node_modules", "@playwright", "cli", "playwright-cli.js");
  for (const dir of [resolve("."), ...(process.env.PATH || "").split(delimiter)]) {
    if (!dir) continue;
    const candidate = join(dir, rel);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

const CLI_ENTRY = findCliEntry();

function runCli(args) {
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 };
  const r = CLI_ENTRY
    ? spawnSync(process.execPath, [CLI_ENTRY, ...args], opts)
    : spawnSync("playwright-cli", args, { ...opts, shell: process.platform === "win32" });
  if (r.error) die(`could not run playwright-cli: ${r.error.message}`);
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function writtenSnapshots(out) {
  const files = [];
  for (const m of out.matchAll(/\]\(([^)\s]+\.ya?ml)\)/g)) files.push(m[1].replace(/\\/g, "/"));
  return files;
}

function pageUrl(out) {
  const m = /Page URL:\s*(\S+)/.exec(out);
  return m ? m[1] : null;
}

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.hash;
  } catch {
    return url;
  }
}

// ---------- commands ----------

function maskScript(values) {
  // Blurs identity fields and any element showing a secret value. Values arrive inside the evaluated code,
  // which playwright-cli echoes back — that echo goes through the redactor like every other output.
  const selectors = [
    "input[type=email]",
    "input[autocomplete~=username]",
    "input[autocomplete~=email]",
  ].join(",");
  return `() => {
    const secrets = ${JSON.stringify(values)};
    const blur = (el) => { el.style.setProperty('filter', 'blur(10px)', 'important'); return 1; };
    let n = 0;
    document.querySelectorAll(${JSON.stringify(selectors)}).forEach((el) => { n += blur(el); });
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.type !== 'password' && secrets.some((s) => el.value && el.value.includes(s))) n += blur(el);
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t.parentElement && secrets.some((s) => t.textContent.includes(s))) n += blur(t.parentElement);
    }
    return n;
  }`;
}

function snapshotTo(session, file, redact) {
  mkdirSync(dirname(file), { recursive: true });
  const r = runCli([`-s=${session}`, "snapshot", `--filename=${file}`]);
  redactFile(file, redact);
  for (const f of writtenSnapshots(r.out)) redactFile(f, redact);
  return r;
}

// Where the viewport should be when the picture is taken. An SPA keeps the scroll position across a route
// change, and a click near the bottom of a form leaves the page scrolled there — so without this a
// "new screen" shot shows the middle of the new screen, and a success message at the top is out of frame.
export function framingFor(verdict, override) {
  if (override) return override;
  const signals = verdict?.signals || [];
  const appeared = signals.find((s) => s.endsWith(":appeared"));
  if (appeared) return `role:${appeared.split(":")[0]}`;
  // A form the reader just filled is the subject of the picture — frame it whole, even when it arrived with
  // a new heading (an inline "Add …" panel). With no focused form, a new screen — by URL or by its page
  // heading — is read from the top, and anything else is left where the reader was looking.
  const newScreen = verdict?.navigated || signals.includes("heading:changed");
  return newScreen ? "form|top" : "form|keep";
}

function frameScript(framing) {
  if (framing === "top") return "() => { window.scrollTo(0, 0); return 'top'; }";
  if (framing.startsWith("form|")) {
    const fallback = framing.split("|")[1];
    return `() => {
      const a = document.activeElement;
      const form = a && a.closest && a.closest('form');
      if (form && form.getClientRects().length) {
        const fits = form.getBoundingClientRect().height <= window.innerHeight;
        form.scrollIntoView({ block: fits ? 'center' : 'start' });
        return fits ? 'form' : 'form-top';
      }
      if (${JSON.stringify(fallback)} === 'top') { window.scrollTo(0, 0); return 'top'; }
      return 'keep';
    }`;
  }
  const role = framing.slice("role:".length);
  const selector = { dialog: "[role=dialog],dialog[open]", status: "[role=status],output" }[role] || `[role=${role}]`;
  return `() => {
    const els = [...document.querySelectorAll(${JSON.stringify(selector)})].filter((e) => e.getClientRects().length);
    const el = els[els.length - 1];
    if (!el) { window.scrollTo(0, 0); return 'top (no ${role} found)'; }
    el.scrollIntoView({ block: 'center' });
    return '${role}';
  }`;
}

function cmdShot(session, stateDir, redact, rest) {
  let png = null;
  let override = null;
  let fullPage = false;
  for (const a of rest) {
    if (a === "--top") override = "top";
    else if (a === "--keep-scroll") override = "keep";
    else if (a === "--full-page") fullPage = true;
    else if (!png) png = a;
  }
  if (!png || !/\.png$/i.test(png)) die("shot needs a .png path, e.g. shot docs/user-guides/login/images/02-login-form.png");
  mkdirSync(dirname(resolve(png)), { recursive: true });

  const verdictFile = join(stateDir, "last-verdict.json");
  let verdict = null;
  try {
    verdict = JSON.parse(readFileSync(verdictFile, "utf8"));
  } catch {}
  let framing = framingFor(verdict, override);
  if (framing !== "keep") {
    const f = runCli([`-s=${session}`, "eval", frameScript(framing)]);
    framing = (/### Result\s*\n\s*"?([^"\n]+)"?/.exec(f.out) || [])[1] || framing;
  }

  const mask = runCli([`-s=${session}`, "eval", maskScript(redact.values)]);
  const maskedCount = Number((/### Result\s*\n\s*(\d+)/.exec(mask.out) || [])[1] ?? NaN);

  const shot = runCli([`-s=${session}`, "screenshot", `--filename=${png}`, ...(fullPage ? ["--full-page"] : [])]);
  if (shot.status !== 0 || !existsSync(png)) {
    process.stdout.write(redact(shot.out));
    die(`screenshot failed for ${png}`, 1);
  }

  const snap = snapshotTo(session, join(stateDir, "baseline.yaml"), redact);
  const url = pageUrl(snap.out);
  writeFileSync(join(stateDir, "baseline-url.txt"), url || "");
  rmSync(verdictFile, { force: true });
  process.stdout.write(
    JSON.stringify({
      shot: png,
      url: url && redact(url),
      framing: fullPage ? `${framing}+full-page` : framing,
      masked: Number.isNaN(maskedCount) ? "unknown" : maskedCount,
    }) + "\n",
  );
}

function cmdCheck(session, stateDir, redact, rest) {
  let threshold = DEFAULT_THRESHOLD;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === "--threshold") threshold = Number(rest[++i]);
    else if (rest[i].startsWith("--threshold=")) threshold = Number(rest[i].split("=")[1]);
  }
  if (!(threshold > 0 && threshold <= 1)) die(`threshold must be in (0, 1], got ${threshold}`);

  const current = join(stateDir, "current.yaml");
  const snap = snapshotTo(session, current, redact);
  if (snap.status !== 0 || !existsSync(current)) {
    process.stdout.write(redact(snap.out));
    die("snapshot failed", 1);
  }
  const url = pageUrl(snap.out);
  const baselineFile = join(stateDir, "baseline.yaml");
  if (!existsSync(baselineFile)) {
    const first = { shoot: true, reason: "no-baseline", navigated: false, signals: [], url: url && redact(url) };
    writeFileSync(join(stateDir, "last-verdict.json"), JSON.stringify(first));
    process.stdout.write(JSON.stringify(first) + "\n");
    return;
  }
  const baseUrl = readFileSync(join(stateDir, "baseline-url.txt"), "utf8").trim();
  const verdict = diffSnapshots(readFileSync(baselineFile, "utf8"), readFileSync(current, "utf8"), threshold);
  const navigated = Boolean(url && baseUrl && pathOf(url) !== pathOf(baseUrl));
  if (navigated) {
    verdict.shoot = true;
    verdict.reason = `navigation:${redact(pathOf(baseUrl))}->${redact(pathOf(url))}`;
  }
  const out = { ...verdict, navigated, url: url && redact(url) };
  writeFileSync(join(stateDir, "last-verdict.json"), JSON.stringify(out));
  process.stdout.write(JSON.stringify(out) + "\n");
}

function main() {
  const argv = process.argv.slice(2);
  let session = null;
  let extraSecrets = [];
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!session && /^(-s|--session)=/.test(a)) session = a.split("=").slice(1).join("=");
    else if (a === "--secrets") extraSecrets = (argv[++i] || "").split(",").filter(Boolean);
    else if (a.startsWith("--secrets=")) extraSecrets = a.slice(10).split(",").filter(Boolean);
    else rest.push(a);
  }
  if (!session) die("a named session is required: -s=<name>");
  if (!/^[A-Za-z0-9_-]+$/.test(session)) die(`session name must be [A-Za-z0-9_-]+, got "${session}"`);
  if (rest.length === 0) die("nothing to run");

  const stateDir = join(STATE_ROOT, session);
  loadGenerated(stateDir);
  const names = loadSecretNames(stateDir);
  for (const n of extraSecrets) names.add(n);

  // Substitute {{NAME}} placeholders; every name used becomes a secret for the rest of the session.
  const args = rest.map((a) =>
    a.replace(PLACEHOLDER, (_, name) => {
      const v = name.startsWith("GEN_") ? generate(stateDir, name) : envValue(name);
      if (v === undefined) die(`environment variable ${name} is not set (checked process env and ./.env)`);
      names.add(name);
      return v;
    }),
  );
  for (const n of names) if (envValue(n) === undefined) die(`secret ${n} is not set (checked process env and ./.env)`);
  if (names.size) saveSecretNames(stateDir, names);
  const redact = makeRedactor(names);

  const [cmd, ...cmdRest] = args;
  if (cmd === "shot") return cmdShot(session, stateDir, redact, cmdRest);
  // `check e12` is playwright-cli's tick-a-checkbox; bare `check` (or `check --threshold …`) is ours.
  if (cmd === "check" && !(cmdRest[0] && /^e\d+$/.test(cmdRest[0]))) return cmdCheck(session, stateDir, redact, cmdRest);

  const r = runCli([`-s=${session}`, ...args]);
  for (const f of writtenSnapshots(r.out)) redactFile(f, redact);
  process.stdout.write(redact(r.out));
  if (cmd === "close") rmSync(stateDir, { recursive: true, force: true });
  process.exit(r.status);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
