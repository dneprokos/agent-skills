#!/usr/bin/env node
// Compares two playwright-cli accessibility snapshots (YAML) and decides whether the page changed
// enough to deserve a new screenshot in a user guide.
//
//   node snapshot-diff.mjs <before.yaml> <after.yaml> [--threshold 0.25]
//
// Prints one JSON line: {"shoot":bool,"reason":"...","changeRatio":n,"added":n,"removed":n,"signals":[...]}
// Exit 0 whenever a verdict was produced, 2 on bad input.
//
// It counts lines and roles. It never interprets rendered text — a guide screenshot is decided by how
// much the page moved, not by what it says.

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_THRESHOLD = 0.25;

// Roles whose appearance or disappearance is a visible event on its own, whatever the line count says.
const OVERLAY_ROLES = ["dialog", "alertdialog", "alert", "status"];

// Attributes that change between two snapshots of an unchanged page.
const VOLATILE = [/\s*\[ref=e\d+\]/g, /\s*\[cursor=[^\]]*\]/g, /\s*\[active\]/g];

export function normalize(yaml) {
  return yaml
    .split(/\r?\n/)
    .map((line) => VOLATILE.reduce((l, re) => l.replace(re, ""), line))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function roleOf(line) {
  const m = /^-\s+([a-z]+)/.exec(line);
  return m ? m[1] : null;
}

function countRoles(lines, roles) {
  const counts = Object.fromEntries(roles.map((r) => [r, 0]));
  for (const line of lines) {
    const role = roleOf(line);
    if (role && role in counts) counts[role] += 1;
  }
  return counts;
}

function pageHeadings(lines) {
  // Level 1 and 2 headings name the screen; a change there is a new screen even on the same URL.
  return lines.filter((l) => /^-\s+heading\b.*\[level=[12]\]/.test(l)).sort().join("\n");
}

function multisetDiff(a, b) {
  const counts = new Map();
  for (const l of a) counts.set(l, (counts.get(l) || 0) + 1);
  let added = 0;
  for (const l of b) {
    const n = counts.get(l) || 0;
    if (n > 0) counts.set(l, n - 1);
    else added += 1;
  }
  let removed = 0;
  for (const n of counts.values()) removed += n;
  return { added, removed };
}

export function diffSnapshots(beforeYaml, afterYaml, threshold = DEFAULT_THRESHOLD) {
  const a = normalize(beforeYaml);
  const b = normalize(afterYaml);
  const { added, removed } = multisetDiff(a, b);
  const denom = Math.max(a.length, b.length, 1);
  const changeRatio = Math.round(Math.min(1, (added + removed) / denom) * 1000) / 1000;

  const signals = [];
  const ra = countRoles(a, OVERLAY_ROLES);
  const rb = countRoles(b, OVERLAY_ROLES);
  for (const role of OVERLAY_ROLES) {
    if (rb[role] > ra[role]) signals.push(`${role}:appeared`);
    else if (rb[role] < ra[role]) signals.push(`${role}:closed`);
  }
  if (pageHeadings(a) !== pageHeadings(b)) signals.push("heading:changed");

  let shoot = false;
  let reason = "below-threshold";
  if (added + removed === 0) {
    reason = "identical";
  } else if (signals.length > 0) {
    shoot = true;
    reason = `structural:${signals[0]}`;
  } else if (changeRatio >= threshold) {
    shoot = true;
    reason = `ratio:${changeRatio}`;
  }
  return { shoot, reason, changeRatio, added, removed, signals };
}

function parseArgs(argv) {
  const files = [];
  let threshold = DEFAULT_THRESHOLD;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--threshold") threshold = Number(argv[++i]);
    else if (argv[i].startsWith("--threshold=")) threshold = Number(argv[i].split("=")[1]);
    else files.push(argv[i]);
  }
  return { files, threshold };
}

function main() {
  const { files, threshold } = parseArgs(process.argv.slice(2));
  const fail = (msg) => {
    process.stderr.write(`snapshot-diff: ${msg}\n`);
    process.exit(2);
  };
  if (files.length !== 2) fail("usage: snapshot-diff.mjs <before.yaml> <after.yaml> [--threshold 0.25]");
  if (!(threshold > 0 && threshold <= 1)) fail(`threshold must be in (0, 1], got ${threshold}`);
  for (const f of files) if (!existsSync(f)) fail(`file not found: ${f}`);
  const [before, after] = files.map((f) => readFileSync(f, "utf8"));
  if (!before.trim() || !after.trim()) fail("empty snapshot");
  process.stdout.write(JSON.stringify(diffSnapshots(before, after, threshold)) + "\n");
}

if (process.argv[1] && resolve(fileURLToPath(import.meta.url)) === resolve(process.argv[1])) main();
