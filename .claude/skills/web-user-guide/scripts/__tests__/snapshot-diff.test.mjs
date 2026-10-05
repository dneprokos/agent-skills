import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { diffSnapshots, normalize } from "../snapshot-diff.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fx = (name) => join(here, "__fixtures__", name);
const read = (name) => readFileSync(fx(name), "utf8");
const script = join(here, "..", "snapshot-diff.mjs");

test("identical snapshots never shoot", () => {
  const v = diffSnapshots(read("login.yaml"), read("login.yaml"));
  assert.equal(v.shoot, false);
  assert.equal(v.reason, "identical");
});

test("ref and cursor churn is not a change", () => {
  assert.deepEqual(normalize(read("login.yaml")), normalize(read("login-rerender.yaml")));
  const v = diffSnapshots(read("login.yaml"), read("login-rerender.yaml"));
  assert.equal(v.shoot, false);
  assert.equal(v.reason, "identical");
});

test("filling one field stays below the threshold", () => {
  const v = diffSnapshots(read("login.yaml"), read("login-filled.yaml"));
  assert.equal(v.shoot, false);
  assert.equal(v.reason, "below-threshold");
  assert.equal(v.added, 1);
});

test("an alert appearing shoots even though the line change is tiny", () => {
  const v = diffSnapshots(read("login.yaml"), read("login-alert.yaml"));
  assert.equal(v.shoot, true);
  assert.equal(v.reason, "structural:alert:appeared");
});

test("a dialog appearing shoots, and closing it shoots again", () => {
  assert.equal(diffSnapshots(read("login.yaml"), read("login-dialog.yaml")).reason, "structural:dialog:appeared");
  assert.equal(diffSnapshots(read("login-dialog.yaml"), read("login.yaml")).reason, "structural:dialog:closed");
});

test("a different screen is detected by its page heading", () => {
  const v = diffSnapshots(read("login.yaml"), read("owner.yaml"));
  assert.equal(v.shoot, true);
  assert.ok(v.signals.includes("heading:changed"));
});

test("a large content change with no structural signal shoots by ratio", () => {
  const v = diffSnapshots(read("owner.yaml"), read("owner-many-rows.yaml"));
  assert.deepEqual(v.signals, []);
  assert.equal(v.shoot, true);
  assert.match(v.reason, /^ratio:/);
});

test("the threshold is honoured", () => {
  const v = diffSnapshots(read("owner.yaml"), read("owner-many-rows.yaml"), 0.9);
  assert.equal(v.shoot, false);
  assert.equal(v.reason, "below-threshold");
});

test("CLI prints one JSON verdict and exits 0", () => {
  const r = spawnSync(process.execPath, [script, fx("login.yaml"), fx("login-alert.yaml")], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(JSON.parse(r.stdout).shoot, true);
});

test("CLI exits 2 on a missing file, an empty file, a bad threshold or a wrong arity", () => {
  const run = (...args) => spawnSync(process.execPath, [script, ...args], { encoding: "utf8" }).status;
  assert.equal(run(fx("login.yaml"), fx("nope.yaml")), 2);
  assert.equal(run(fx("login.yaml"), fx("empty.yaml")), 2);
  assert.equal(run(fx("login.yaml"), fx("login.yaml"), "--threshold", "5"), 2);
  assert.equal(run(fx("login.yaml")), 2);
});
