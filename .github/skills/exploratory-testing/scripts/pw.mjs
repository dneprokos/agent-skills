#!/usr/bin/env node
// Guarded wrapper around playwright-cli for the exploratory-testing skill. The guardrails live here, in
// code, so an agent cannot talk its way past them:
//
//   origin       open/goto/click/press that would land off the base origin is refused or undone, and logged.
//   visited      a normalized URL is entered once; a second visit is refused (WARN when a click lands on one).
//   deadline     every browser command after the deadline is refused, so the final report gets written.
//   destructive  clicks (and Enter/Space on a focused control) whose accessible name, link target or form
//                action looks like delete / remove / pay / send / logout ... are refused.
//   redaction    admin credentials arrive as flags on every call (never stored in any file) and are replaced
//                by <ADMIN_USER> / <ADMIN_PASS> in all output and in every snapshot/console/network file.
//   allow-list   only the playwright-cli commands below are reachable. Raw `eval`, `run-code`, `go-back`,
//                `tab-new`, `state-load` ... are not, because each of them can bypass a guard above.
//
// Usage (the session flag is required; it names the browser and the state folder):
//   node pw.mjs -s=<session> init --base-url <url> (--minutes <n> | --deadline <iso>) [--creds] [creds flags]
//   node pw.mjs -s=<session> [creds flags] open|goto <url>
//   node pw.mjs -s=<session> [creds flags] click|hover|check|uncheck <ref>
//   node pw.mjs -s=<session> [creds flags] fill <ref> <text> | select <ref> <value> | press <key> | type <text>
//   node pw.mjs -s=<session> [creds flags] snapshot | console | network | screenshot | reload | resize <w> <h>
//   node pw.mjs -s=<session> [creds flags] dialog-accept [text] | dialog-dismiss | tab-list
//   node pw.mjs -s=<session> [creds flags] links | audit
//   node pw.mjs -s=<session> status | visited | blocked | close | list
//   node pw.mjs -s=<session> [creds flags] scrub <file> [<file> ...]
// creds flags: --admin-user <value> --admin-pass <value>   (required on every browser call after `init --creds`)
// `{{ADMIN_USER}}` / `{{ADMIN_PASS}}` in an argument expand to those values at call time.
//
// Exit codes: playwright-cli's own for pass-through; 3 usage/env error; 4 guard refusal.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, rmSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const STATE_ROOT = join(".playwright-cli", "exploratory-testing");
export const EXIT_USAGE = 3;
export const EXIT_BLOCKED = 4;
const MIN_SECRET_LENGTH = 3;
// One playwright-cli call that takes longer than this is a hung page, not a slow one.
const CLI_TIMEOUT_MS = 90_000;

// ---------------------------------------------------------------------------------------------------------
// Pure logic. Exported and unit-tested; nothing below this banner touches the filesystem or a browser.
// ---------------------------------------------------------------------------------------------------------

// A URL reduced to the form that decides "have I been here". Fragment dropped (except a hash-route such as
// `#/admin`, which IS the page in a hash-routed SPA), query sorted, trailing slash dropped, credentials in
// the URL stripped. Returns null for anything that is not an http(s) URL.
export function normalizeUrl(raw, base) {
  let u;
  try {
    u = new URL(String(raw).trim(), base);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  u.username = "";
  u.password = "";
  const hash = /^#!?\//.test(u.hash) ? u.hash : "";
  u.hash = "";
  u.searchParams.sort();
  let path = u.pathname.replace(/\/{2,}/g, "/");
  if (path.length > 1) path = path.replace(/\/+$/, "");
  return `${u.origin}${path}${u.search === "?" ? "" : u.search}${hash}`;
}

export function originOf(raw) {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

export function isSameOrigin(raw, baseOrigin) {
  const o = originOf(raw);
  return o !== null && o === baseOrigin;
}

// Accessible-name words that mean "this click changes or destroys something, or leaves the session".
// Over-blocking is the safe direction: a refused click is reported, never silently skipped.
const NAME_DENY =
  /\b(?:delet\w*|remov\w*|purchas\w*|destroy\w*|erase\w*|deactivat\w*|unsubscrib\w*|send\w*|buy\w*|pay|checkout|place\s+order|log\s*-?\s*out|sign\s*-?\s*out)\b/i;
const HREF_DENY = /(?:^|[/?&=_.-])(?:logout|log-out|signout|sign-out|delete|destroy|remove)(?:$|[/?&=_.-])/i;

// `candidate`: { names: string[], hrefs: string[] }. names = every label the control exposes; hrefs = link
// target and form action. Returns a human-readable reason, or null when the control is allowed.
export function destructiveReason({ names = [], hrefs = [] } = {}) {
  for (const n of names) {
    const text = String(n ?? "").trim();
    const m = text && NAME_DENY.exec(text);
    if (m) return `name "${text.slice(0, 60)}" matches deny word "${m[0].toLowerCase()}"`;
  }
  for (const h of hrefs) {
    if (!h) continue;
    let target = String(h);
    try {
      const u = new URL(target, "http://x.invalid");
      target = u.pathname + u.search;
    } catch {}
    const m = HREF_DENY.exec(target);
    if (m) return `target "${target.slice(0, 80)}" matches deny word "${m[0].replace(/^[/?&=_.-]|[/?&=_.-]$/g, "").toLowerCase()}"`;
  }
  return null;
}

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// pairs: [[label, value], ...]. Replaces the raw, URL-encoded and JSON-escaped form of every value.
// Longest first so a password that contains the username is not half replaced. A value is replaced as a
// whole token only: never inside a longer word (`admin` in `administrator`) and never as a URL path segment
// (`/admin`), so a credential that is also an ordinary route name does not blind the explorer to the URLs.
export function makeRedactor(pairs) {
  const variants = [];
  for (const [label, value] of pairs) {
    if (!value) continue;
    const forms = new Set([value, encodeURIComponent(value), JSON.stringify(value).slice(1, -1)]);
    for (const f of forms) {
      if (f.length < MIN_SECRET_LENGTH) continue;
      const pattern =
        (/^[A-Za-z0-9]/.test(f) ? "(?<![A-Za-z0-9])" : "") + "(?<!/)" + escapeRegExp(f) + (/[A-Za-z0-9]$/.test(f) ? "(?![A-Za-z0-9])" : "");
      variants.push([label, f.length, new RegExp(pattern, "g")]);
    }
  }
  variants.sort((a, b) => b[1] - a[1]);
  const redact = (text) => variants.reduce((t, [label, , re]) => t.replace(re, `<${label}>`), String(text));
  redact.active = variants.length > 0;
  return redact;
}

export function deadlineStatus(deadlineMs, now = Date.now()) {
  const remainingMs = deadlineMs - now;
  return { expired: remainingMs <= 0, remainingMs };
}

export function pageUrl(out) {
  const m = /Page URL:\s*(\S+)/.exec(out);
  return m ? m[1] : null;
}

// `eval` prints the result as a JSON-quoted string under "### Result"; a function that returns
// JSON.stringify(x) therefore comes back double encoded.
export function parseEvalResult(out) {
  const m = /### Result\s*\n([^\n]*)/.exec(out);
  if (!m) return undefined;
  try {
    const first = JSON.parse(m[1]);
    return typeof first === "string" ? JSON.parse(first) : first;
  } catch {
    return undefined;
  }
}

export function parseTabs(out) {
  const tabs = [];
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*-\s*(\d+):(\s*\(current\))?\s*\[(.*)\]\(([^)]*)\)\s*$/.exec(line);
    if (m) tabs.push({ index: Number(m[1]), current: Boolean(m[2]), title: m[3], url: m[4] });
  }
  return tabs;
}

export function writtenFiles(out) {
  const files = [];
  for (const m of out.matchAll(/\]\(([^)\s]+\.(?:ya?ml|log|txt|md|json))\)/g)) files.push(m[1].replace(/\\/g, "/"));
  return files;
}

// Commands that reach playwright-cli untouched (apart from the redaction and the landing check that every
// command gets). Anything not here, and not handled explicitly in main(), is refused.
export const PASS_THROUGH = new Set([
  "snapshot", "console", "network", "screenshot", "reload", "resize", "hover", "fill", "type", "select",
  "check", "uncheck", "dialog-accept", "dialog-dismiss", "tab-list",
]);

// Argument-count contract per command, so a flag or an extra positional cannot smuggle behaviour in.
const ARITY = {
  open: [1, 1], goto: [1, 1], click: [1, 1], press: [1, 1], hover: [1, 1], check: [1, 1], uncheck: [1, 1],
  fill: [2, 2], select: [2, 2], type: [1, 1], snapshot: [0, 0], console: [0, 0], network: [0, 0],
  screenshot: [0, 0], reload: [0, 0], resize: [2, 2], "dialog-accept": [0, 1], "dialog-dismiss": [0, 0],
  "tab-list": [0, 0], links: [0, 0], audit: [0, 0],
};

export function arityError(cmd, args) {
  const a = ARITY[cmd];
  if (!a) return null;
  if (args.length < a[0] || args.length > a[1]) return `${cmd} takes ${a[0] === a[1] ? a[0] : `${a[0]}-${a[1]}`} argument(s), got ${args.length}`;
  if (["click", "hover", "check", "uncheck", "fill", "select"].includes(cmd) && !/^[A-Za-z]*\d*e\d+$/.test(args[0])) {
    return `${cmd} needs an element ref from the latest snapshot (e5), got "${args[0]}"`;
  }
  return null;
}

// Keys that activate whatever has focus. Everything else is typing or navigation inside the page.
export function isActivationKey(key) {
  const k = String(key);
  return k === " " || /(?:^|\+)(?:enter|numpadenter|space)$/i.test(k.trim());
}

// ---------------------------------------------------------------------------------------------------------
// In-page scripts (strings evaluated by playwright-cli). Kept dependency-free and returning JSON.
// ---------------------------------------------------------------------------------------------------------

const NAMES_FN = `(el) => {
  const t = (s) => (s || '').toString().replace(/\\s+/g, ' ').trim().slice(0, 200);
  const labelled = (el.getAttribute && el.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean)
    .map((id) => { const n = document.getElementById(id); return n ? t(n.textContent) : ''; }).join(' ');
  const img = el.querySelector && el.querySelector('img[alt], svg title');
  const link = el.closest && el.closest('a[href]');
  const form = el.form || (el.closest && el.closest('form'));
  const submitters = form ? [...form.querySelectorAll('button:not([type=button]):not([type=reset]), input[type=submit], input[type=image]')] : [];
  const names = (n) => [t(n.getAttribute('aria-label')), t(n.innerText), t(n.value), t(n.title), t(n.getAttribute('alt')), t(n.textContent)];
  const actionOf = (n) => (n.getAttribute && n.getAttribute('formaction')) ? n.formAction : (n.form && n.form.getAttribute('action') ? n.form.action : '');
  // Enter inside a text field submits the form through its first submit button; nothing else does.
  const isField = /^(INPUT|SELECT)$/.test(el.tagName) && !/^(submit|button|image|reset|checkbox|radio)$/.test(el.type);
  const defaultSubmit = isField ? submitters[0] : null;
  return {
    tag: el.tagName, type: el.type || '',
    names: [...names(el), labelled, img ? t(img.getAttribute && img.getAttribute('alt') || img.textContent) : ''].filter(Boolean),
    linkHref: link ? link.href : '',
    hrefs: [link ? link.href : '', actionOf(el), form && form.getAttribute('action') ? form.action : ''].filter(Boolean),
    submitNames: defaultSubmit ? names(defaultSubmit).filter(Boolean) : [],
    submitActions: defaultSubmit ? [actionOf(defaultSubmit)].filter(Boolean) : [],
    target: link ? link.target : '',
  };
}`;

// eval prints an object result over several lines; a JSON string is one line and parses reliably.
const NAMES_CALL = `(el) => JSON.stringify((${NAMES_FN})(el))`;

const LINKS_FN = `() => JSON.stringify([...document.querySelectorAll('a[href]')].map((a) => ({
  href: a.href, raw: a.getAttribute('href'), text: (a.innerText || a.getAttribute('aria-label') || a.title || '').replace(/\\s+/g, ' ').trim().slice(0, 80),
  target: a.target, nav: Boolean(a.closest('nav, header, [role=navigation]')),
})))`;

const NAV_STATUS_FN = `() => { const n = performance.getEntriesByType('navigation')[0]; return JSON.stringify({ status: n && n.responseStatus ? n.responseStatus : null }); }`;

const ACTIVE_FN = `() => { const fn = ${NAMES_FN}; const a = document.activeElement; if (!a || a === document.body) return JSON.stringify(null); return JSON.stringify(fn(a)); }`;

const AUDIT_FN = `() => {
  const cap = (a) => a.slice(0, 25);
  const label = (el) => (el.labels && el.labels.length) || el.getAttribute('aria-label') || el.getAttribute('aria-labelledby') || el.title;
  const vis = (el) => el.getClientRects().length > 0;
  const idCount = {}; document.querySelectorAll('[id]').forEach((e) => { idCount[e.id] = (idCount[e.id] || 0) + 1; });
  const heads = [...document.querySelectorAll('h1,h2,h3,h4,h5,h6')].map((h) => Number(h.tagName[1]));
  const skipped = heads.some((h, i) => i > 0 && h - heads[i - 1] > 1);
  return JSON.stringify({
    title: document.title, lang: document.documentElement.lang || null,
    viewportMeta: Boolean(document.querySelector('meta[name=viewport]')),
    h1Count: document.querySelectorAll('h1').length, headingLevelsSkipped: skipped,
    brokenImages: cap([...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => i.currentSrc || i.src)),
    imagesWithoutAlt: cap([...document.images].filter((i) => i.getAttribute('alt') === null).map((i) => i.currentSrc || i.src)),
    inputsWithoutLabel: cap([...document.querySelectorAll('input:not([type=hidden]):not([type=submit]):not([type=button]), select, textarea')].filter((e) => vis(e) && !label(e)).map((e) => e.tagName.toLowerCase() + (e.name ? '[name=' + e.name + ']' : '') + (e.type ? '[type=' + e.type + ']' : ''))),
    buttonsWithoutName: cap([...document.querySelectorAll('button, [role=button]')].filter((e) => vis(e) && !(e.innerText || e.getAttribute('aria-label') || e.title || e.value || '').trim()).map((e) => e.outerHTML.slice(0, 80))),
    linksWithoutName: cap([...document.querySelectorAll('a[href]')].filter((e) => vis(e) && !(e.innerText || e.getAttribute('aria-label') || e.title || (e.querySelector('img[alt]') || {}).alt || '').trim()).map((e) => e.getAttribute('href'))),
    deadLinks: cap([...document.querySelectorAll('a')].filter((e) => !e.getAttribute('href') || e.getAttribute('href') === '#').map((e) => (e.innerText || '').trim().slice(0, 40) || e.outerHTML.slice(0, 60))),
    duplicateIds: cap(Object.keys(idCount).filter((k) => idCount[k] > 1)),
    positiveTabindex: document.querySelectorAll('[tabindex]:not([tabindex="0"]):not([tabindex^="-"])').length,
    horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth,
    forms: cap([...document.forms].map((f) => ({
      action: f.getAttribute('action'), method: (f.method || 'get').toLowerCase(), novalidate: f.noValidate,
      fields: cap([...f.elements].filter((e) => e.name || e.id).map((e) => ({
        name: e.name || e.id, type: e.type || e.tagName.toLowerCase(), required: Boolean(e.required),
        maxlength: e.maxLength > 0 ? e.maxLength : null, min: e.min || null, max: e.max || null, pattern: e.pattern || null,
      }))),
    }))),
  });
}`;

// Blurs whatever shows a credential, so a screenshot taken for evidence cannot carry one.
function maskScript(values) {
  return `() => {
    const secrets = ${JSON.stringify(values)};
    const blur = (el) => { el.style.setProperty('filter', 'blur(10px)', 'important'); return 1; };
    let n = 0;
    document.querySelectorAll('input, textarea').forEach((el) => {
      if (el.type === 'password' || (el.value && secrets.some((s) => el.value.includes(s)))) n += blur(el);
    });
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const t = walker.currentNode;
      if (t.parentElement && secrets.some((s) => t.textContent.includes(s))) n += blur(t.parentElement);
    }
    return n;
  }`;
}

// ---------------------------------------------------------------------------------------------------------
// Everything below runs only when the file is executed, never on import.
// ---------------------------------------------------------------------------------------------------------

function die(msg, code = EXIT_USAGE) {
  process.stderr.write(`pw: ${msg}\n`);
  process.exit(code);
}

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

let CLI_ENTRY;
function runCli(args) {
  CLI_ENTRY ??= findCliEntry();
  const opts = { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: CLI_TIMEOUT_MS, killSignal: "SIGKILL" };
  const r = CLI_ENTRY
    ? spawnSync(process.execPath, [CLI_ENTRY, ...args], opts)
    : spawnSync("playwright-cli", args, { ...opts, shell: process.platform === "win32" });
  if (r.error && r.error.code === "ETIMEDOUT") return { status: 1, out: `### Error
Error: playwright-cli ${args.filter((a) => !a.startsWith("-s=")).join(" ").slice(0, 60)} timed out after ${CLI_TIMEOUT_MS / 1000}s
` };
  if (r.error) die(`could not run playwright-cli: ${r.error.message}`);
  return { status: r.status ?? 1, out: (r.stdout || "") + (r.stderr || "") };
}

function readJson(file, fallback) {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function parseArgs(argv) {
  const o = { session: null, adminUser: null, adminPass: null, rest: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!o.session && /^(-s|--session)=/.test(a)) o.session = a.split("=").slice(1).join("=");
    else if (a === "--admin-user") o.adminUser = argv[++i] ?? "";
    else if (a.startsWith("--admin-user=")) o.adminUser = a.slice("--admin-user=".length);
    else if (a === "--admin-pass") o.adminPass = argv[++i] ?? "";
    else if (a.startsWith("--admin-pass=")) o.adminPass = a.slice("--admin-pass=".length);
    else o.rest.push(a);
  }
  return o;
}

// Pulls `--name value` / `--name=value` out of an argument list. Returns [value|true|undefined, remaining].
function takeFlag(args, name, { boolean = false } = {}) {
  const out = [];
  let value;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === `--${name}`) value = boolean ? true : args[++i];
    else if (a.startsWith(`--${name}=`)) value = a.slice(name.length + 3);
    else out.push(a);
  }
  return [value, out];
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.session) die("a named session is required: -s=<name>");
  if (!/^[A-Za-z0-9_-]+$/.test(opts.session)) die(`session name must be [A-Za-z0-9_-]+, got "${opts.session}"`);
  if (opts.rest.length === 0) die("nothing to run");

  const session = opts.session;
  const stateDir = join(STATE_ROOT, session);
  const stateFile = join(stateDir, "state.json");
  const visitedFile = join(stateDir, "visited.json");
  const logFile = join(stateDir, "actions.log");

  for (const [flag, v] of [["--admin-user", opts.adminUser], ["--admin-pass", opts.adminPass]]) {
    if (v !== null && v.length < MIN_SECRET_LENGTH) die(`${flag} must be at least ${MIN_SECRET_LENGTH} characters, otherwise it cannot be redacted reliably`);
  }
  const redact = makeRedactor([["ADMIN_PASS", opts.adminPass], ["ADMIN_USER", opts.adminUser]]);
  const secretValues = [opts.adminUser, opts.adminPass].filter(Boolean);

  const [cmd, ...rawArgs] = opts.rest;
  const say = (text) => process.stdout.write(redact(text.endsWith("\n") ? text : text + "\n"));
  const log = (kind, reason, detail) => {
    mkdirSync(stateDir, { recursive: true });
    appendFileSync(logFile, redact(JSON.stringify({ t: new Date().toISOString(), kind, reason, detail })) + "\n");
  };
  const refuse = (reason, detail, hint = "") => {
    log("blocked", reason, detail);
    say(`BLOCKED ${reason}: ${detail}${hint ? `\n${hint}` : ""}`);
    process.exit(EXIT_BLOCKED);
  };
  const scrubFiles = (out) => {
    if (!redact.active) return;
    for (const f of writtenFiles(out)) {
      if (!existsSync(f)) continue;
      const before = readFileSync(f, "utf8");
      const after = redact(before);
      if (after !== before) writeFileSync(f, after);
    }
  };

  // ---- commands that need no state ------------------------------------------------------------------
  if (cmd === "list") {
    const r = runCli(["list"]);
    process.stdout.write(r.out);
    process.exit(r.status);
  }
  if (cmd === "scrub") {
    if (!redact.active) die("scrub needs --admin-user and/or --admin-pass");
    if (rawArgs.length === 0) die("scrub needs at least one file");
    for (const f of rawArgs) {
      if (!existsSync(f)) die(`no such file: ${f}`);
      const before = readFileSync(f, "utf8");
      const after = redact(before);
      if (after !== before) {
        writeFileSync(f, after);
        say(`scrubbed ${f}`);
      } else say(`clean ${f}`);
    }
    process.exit(0);
  }
  if (cmd === "init") {
    let [baseUrl, a1] = takeFlag(rawArgs, "base-url");
    let [minutes, a2] = takeFlag(a1, "minutes");
    let [deadline, a3] = takeFlag(a2, "deadline");
    const [creds, a4] = takeFlag(a3, "creds", { boolean: true });
    if (a4.length) die(`init: unexpected argument(s): ${a4.join(" ")}`);
    const base = baseUrl && normalizeUrl(baseUrl);
    if (!base) die("init needs --base-url <http(s) url>");
    let deadlineMs;
    if (deadline) {
      deadlineMs = Date.parse(deadline);
      if (Number.isNaN(deadlineMs)) die(`--deadline must be an ISO timestamp, got "${deadline}"`);
    } else if (minutes) {
      if (!(Number(minutes) > 0)) die(`--minutes must be a positive number, got "${minutes}"`);
      deadlineMs = Date.now() + Number(minutes) * 60_000;
    } else die("init needs --minutes <n> or --deadline <iso>");
    if (creds && !(opts.adminUser && opts.adminPass)) die("init --creds needs both --admin-user and --admin-pass");
    if (!creds && (opts.adminUser || opts.adminPass)) die("creds flags given without --creds; pass --creds to enable the redaction requirement");
    rmSync(stateDir, { recursive: true, force: true });
    mkdirSync(stateDir, { recursive: true });
    const state = { baseUrl: base, origin: originOf(base), deadlineMs, hasCreds: Boolean(creds), current: null, startedAt: Date.now() };
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(visitedFile, "[]");
    say(JSON.stringify({ session, origin: state.origin, deadline: new Date(deadlineMs).toISOString(), hasCreds: state.hasCreds }));
    process.exit(0);
  }

  const state = readJson(stateFile, null);
  if (!state) die(`no state for session "${session}"; run init first`);
  const visited = new Set(readJson(visitedFile, []));
  const saveState = () => {
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(visitedFile, JSON.stringify([...visited].sort()));
  };
  const readLog = () =>
    existsSync(logFile) ? readFileSync(logFile, "utf8").split("\n").filter(Boolean).map((l) => readJson_(l)) : [];
  function readJson_(line) {
    try {
      return JSON.parse(line);
    } catch {
      return { raw: line };
    }
  }

  if (cmd === "status") {
    const d = deadlineStatus(state.deadlineMs);
    const entries = readLog();
    say(JSON.stringify({
      session, origin: state.origin, expired: d.expired, remainingSeconds: Math.max(0, Math.round(d.remainingMs / 1000)),
      deadline: new Date(state.deadlineMs).toISOString(), visited: visited.size,
      blocked: entries.filter((e) => e.kind === "blocked").length, warnings: entries.filter((e) => e.kind === "warn").length,
      current: state.current, hasCreds: state.hasCreds,
    }));
    process.exit(0);
  }
  if (cmd === "visited") {
    say(JSON.stringify([...visited].sort(), null, 1));
    process.exit(0);
  }
  if (cmd === "blocked") {
    for (const e of readLog()) say(JSON.stringify(e));
    process.exit(0);
  }

  // ---- everything below drives the browser ----------------------------------------------------------
  if (cmd === "close") {
    const r = runCli([`-s=${session}`, "close"]);
    process.stdout.write(redact(r.out));
    process.exit(r.status);
  }

  if (state.hasCreds && !(opts.adminUser && opts.adminPass)) {
    refuse("creds-missing", "this session was created with --creds; every browser call must repeat --admin-user and --admin-pass so output can be redacted", "Nothing was run.");
  }
  if (!state.hasCreds && (opts.adminUser || opts.adminPass)) die("creds flags given but the session was created without --creds");
  if (deadlineStatus(state.deadlineMs).expired) {
    refuse("deadline", `time budget ended at ${new Date(state.deadlineMs).toISOString()}`, "Stop exploring. Write the final report with what is covered and list the rest as not covered. Only `close` still works.");
  }

  const args = rawArgs.map((a) => a.split("{{ADMIN_USER}}").join(opts.adminUser ?? "{{ADMIN_USER}}").split("{{ADMIN_PASS}}").join(opts.adminPass ?? "{{ADMIN_PASS}}"));
  if (args.some((a) => /\{\{ADMIN_(?:USER|PASS)\}\}/.test(a))) die("{{ADMIN_USER}} / {{ADMIN_PASS}} used but the matching creds flag is missing");

  const known = PASS_THROUGH.has(cmd) || ["open", "goto", "click", "press", "links", "audit"].includes(cmd);
  if (!known) {
    refuse("command-not-allowed", `"${cmd}" is not available in a guarded session`, `Allowed: open, goto, click, press, ${[...PASS_THROUGH].join(", ")}, links, audit, status, visited, blocked, scrub, close, list.`);
  }
  const bad = arityError(cmd, args);
  if (bad) die(bad);

  // The run helpers --------------------------------------------------------------------------------------
  const cli = (...a) => runCli([`-s=${session}`, ...a]);
  const evalJson = (fn, ref) => {
    const r = cli("eval", fn, ...(ref ? [ref] : []));
    return { r, value: parseEvalResult(r.out), failed: /### Error/.test(r.out) || r.status !== 0 };
  };

  const offOrigin = (url) => Boolean(url) && url !== "about:blank" && !isSameOrigin(url, state.origin);

  // Undo a landing on another origin. Off-origin tabs are closed; if no same-origin tab is left, step back
  // in history, and if that still does not help park the browser on a blank page.
  const leaveOffOrigin = (landed) => {
    const tabs = parseTabs(cli("tab-list").out);
    const bad = tabs.filter((t) => offOrigin(t.url));
    const good = tabs.filter((t) => !offOrigin(t.url));
    if (good.length > 0) {
      for (const t of [...bad].sort((a, b) => b.index - a.index)) cli("tab-close", String(t.index));
      const keep = good.find((t) => t.url !== "about:blank") ?? good[0];
      const after = parseTabs(cli("tab-list").out);
      const idx = after.findIndex((t) => t.url === keep.url);
      if (idx >= 0) cli("tab-select", String(idx));
    } else {
      cli("go-back");
      const here = parseTabs(cli("tab-list").out).find((t) => t.current)?.url;
      if (offOrigin(here) || !here) cli("goto", "about:blank");
    }
    refuse("off-origin", `landed on ${landed}; base origin is ${state.origin}`, "Browser was moved back. Record it as: external, not followed.");
  };

  // Runs after every browser command. Enforces origin on every tab, then keeps the visited set and current URL.
  // Read-only commands cannot open a tab or navigate, so they skip the tab sweep.
  const NO_TAB_SWEEP = new Set(["snapshot", "console", "network", "screenshot", "resize", "tab-list", "fill", "type", "hover"]);
  const afterCommand = (out, command) => {
    const landed = pageUrl(out);
    if (!landed) return { landed: null };
    if (offOrigin(landed)) leaveOffOrigin(landed);
    if (!NO_TAB_SWEEP.has(command)) {
      const bad = parseTabs(cli("tab-list").out).filter((t) => offOrigin(t.url));
      if (bad.length) leaveOffOrigin(bad[0].url);
    }
    const n = normalizeUrl(landed);
    const prev = state.current ? normalizeUrl(state.current) : null;
    let revisit = false;
    if (n && n !== prev) {
      if (visited.has(n)) {
        revisit = true;
        log("warn", "already-visited", `landed on ${n}`);
      } else visited.add(n);
    }
    state.current = landed;
    saveState();
    return { landed, normalized: n, revisit };
  };

  const checkTarget = (rawUrl) => {
    const n = normalizeUrl(rawUrl, state.current || state.baseUrl);
    if (!n) refuse("scheme", `"${String(rawUrl).slice(0, 80)}" is not an http(s) URL`);
    if (!isSameOrigin(n, state.origin)) refuse("off-origin", `${n} is outside ${state.origin}`, "Record it as: external, not followed.");
    const why = destructiveReason({ hrefs: [n] });
    if (why) refuse("destructive", why, "Record it as: skipped, destructive.");
    if (visited.has(n)) refuse("already-visited", `${n} was already visited`, "No page is analyzed twice. Move on to the next unvisited page.");
    return n;
  };

  const checkControl = (info, via) => {
    if (!info) return;
    const hrefs = [...(info.hrefs || [])];
    // Ticking a checkbox or radio ("Send me the newsletter") changes a form value, not the world.
    const names = /^(?:checkbox|radio)$/.test(info.type) ? [] : [...(info.names || [])];
    // Enter on a field submits the form through its default button, so that button's name and action count.
    if (via === "enter") {
      names.push(...(info.submitNames || []));
      hrefs.push(...(info.submitActions || []));
    }
    const why = destructiveReason({ names, hrefs });
    if (why) refuse("destructive", why, "Record it as: skipped, destructive.");
    for (const h of info.hrefs || []) {
      if (!h) continue;
      if (/^(?:javascript|data|vbscript):/i.test(h)) refuse("scheme", `link target ${h.slice(0, 40)} is a script/data URL`);
      const o = originOf(h);
      if (/^[a-z][a-z0-9+.-]*:/i.test(h) && o === null) refuse("scheme", `link target ${h.slice(0, 40)} is not an http(s) URL`, "Record it as: external, not followed.");
      if (o !== null && o !== state.origin) refuse("off-origin", `link target ${h} is outside ${state.origin}`, "Record it as: external, not followed.");
    }
    // A plain link to an already visited page is refused before the click; a form action is not a page.
    if (info.linkHref) {
      const n = normalizeUrl(info.linkHref);
      const current = state.current ? normalizeUrl(state.current) : null;
      if (n && visited.has(n) && n !== current) refuse("already-visited", `${n} was already visited`, "No page is analyzed twice. Move on to the next unvisited page.");
    }
  };

  const finish = (r, command) => {
    scrubFiles(r.out);
    process.stdout.write(redact(r.out));
    const post = afterCommand(r.out, command);
    if (post.landed && post.revisit) say(`WARN already-visited: landed on ${post.normalized}; do not analyze it again.`);
    return post;
  };

  // ---- dispatch ---------------------------------------------------------------------------------------
  if (cmd === "open" || cmd === "goto") {
    const target = checkTarget(args[0]);
    const r = cmd === "open" ? cli("open", args[0]) : cli("goto", args[0]);
    scrubFiles(r.out);
    if (r.status !== 0 || /### Error/.test(r.out)) {
      process.stdout.write(redact(r.out));
      process.exit(r.status || 1);
    }
    process.stdout.write(redact(r.out));
    const post = afterCommand(r.out, cmd);
    const nav = evalJson(NAV_STATUS_FN);
    say(
      `PW ${JSON.stringify({
        requested: target,
        landed: post.normalized ?? null,
        redirected: Boolean(post.normalized && post.normalized !== target),
        status: nav.value?.status ?? null,
        visited: visited.size,
      })}`,
    );
    process.exit(0);
  }

  if (cmd === "click" || cmd === "press") {
    const via = cmd === "press" ? (isActivationKey(args[0]) ? (/space| /i.test(args[0]) ? "space" : "enter") : null) : "click";
    if (via) {
      const probe = cmd === "click" ? evalJson(NAMES_CALL, args[0]) : evalJson(ACTIVE_FN);
      if (probe.failed) {
        say(probe.r.out.trim());
        process.exit(1);
      }
      // Fail closed: a control that could not be read is a control that was not checked.
      const readable = cmd === "click" ? probe.value && typeof probe.value === "object" : probe.value === null || (probe.value && typeof probe.value === "object");
      if (!readable) refuse("unreadable-control", "could not read the accessible name and target of the element, so it was not clicked", "Take a fresh snapshot and use a current ref.");
      checkControl(probe.value, via);
    }
    const r = cli(cmd, args[0]);
    finish(r, cmd);
    process.exit(r.status);
  }

  if (cmd === "links") {
    const { r, value, failed } = evalJson(LINKS_FN);
    if (failed || !Array.isArray(value)) {
      say(r.out.trim());
      process.exit(1);
    }
    const internal = new Map();
    const external = new Map();
    const other = [];
    for (const l of value) {
      const n = normalizeUrl(l.href);
      if (!n) {
        other.push({ href: l.raw, text: l.text });
      } else if (!isSameOrigin(n, state.origin)) {
        if (!external.has(n)) external.set(n, { url: n, text: l.text });
      } else if (!internal.has(n)) {
        internal.set(n, { url: n, text: l.text, nav: l.nav, visited: visited.has(n), skip: destructiveReason({ names: [l.text], hrefs: [n] }) ? "destructive" : undefined });
      }
    }
    const page = state.current ? normalizeUrl(state.current) : null;
    say(JSON.stringify({ page, internal: [...internal.values()], external: [...external.values()], other }));
    process.exit(0);
  }

  if (cmd === "audit") {
    const { r, value, failed } = evalJson(AUDIT_FN);
    if (failed || !value) {
      say(r.out.trim());
      process.exit(1);
    }
    say(JSON.stringify({ page: state.current ? normalizeUrl(state.current) : null, ...value }));
    process.exit(0);
  }

  if (cmd === "screenshot" && secretValues.length) {
    cli("eval", maskScript(secretValues));
  }

  const r = cli(cmd, ...args);
  finish(r, cmd);
  process.exit(r.status);
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
