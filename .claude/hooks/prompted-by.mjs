#!/usr/bin/env node
// Stop hook: after each prompt run, tells the user who prompted it. Cosmetic only — always exits 0.
import { execSync } from "node:child_process";

function userName() {
  try {
    const name = execSync("git config user.name", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    if (name) return name;
  } catch {}
  return process.env.USERNAME || process.env.USER || "anonymous hero";
}

try {
  process.stdout.write(JSON.stringify({ systemMessage: `@Prompted by ${userName()}` }));
} catch {}
process.exit(0);
