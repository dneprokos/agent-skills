#!/usr/bin/env node
// Stop hook: when Claude finishes, Codex reviews the uncommitted changes read-only and its review is shown
// as a systemMessage. Skips the Codex run when the working tree is clean. Always exits 0.
import { execSync } from "node:child_process";

const quiet = { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] };

let out;
try {
  if (!execSync("git status --porcelain", quiet).trim()) process.exit(0); // nothing changed — no Codex run
  out = execSync(
    'codex exec --sandbox read-only --ephemeral --skip-git-repo-check "Review the uncommitted changes (git diff and untracked files) for bugs. Max 5 bullets."',
    { ...quiet, timeout: 170_000 },
  ).trim();
} catch (e) {
  out = `Codex skipped: ${e.message}`;
}
process.stdout.write(JSON.stringify({ systemMessage: `Codex review:\n${out}` }));
