import { test } from "node:test";
import assert from "node:assert/strict";
import { framingFor } from "../pw.mjs";

test("an overlay that appeared is framed on itself, even after a navigation", () => {
  assert.equal(framingFor({ navigated: true, signals: ["status:appeared"] }), "role:status");
  assert.equal(framingFor({ signals: ["dialog:appeared", "heading:changed"] }), "role:dialog");
});

test("a new screen prefers the focused form, then the top", () => {
  assert.equal(framingFor({ navigated: true, signals: [] }), "form|top");
  assert.equal(framingFor({ navigated: false, signals: ["heading:changed"] }), "form|top");
});

test("a first shot, a filled form or a ratio change prefers the focused form, then stays put", () => {
  assert.equal(framingFor({ reason: "no-baseline", signals: [] }), "form|keep");
  assert.equal(framingFor({ reason: "ratio:0.4", signals: [] }), "form|keep");
  assert.equal(framingFor(null), "form|keep");
});

test("a closed overlay is not something to scroll to", () => {
  assert.equal(framingFor({ signals: ["dialog:closed"] }), "form|keep");
});

test("an explicit override always wins", () => {
  assert.equal(framingFor({ navigated: true, signals: ["alert:appeared"] }, "keep"), "keep");
  assert.equal(framingFor({ signals: [] }, "top"), "top");
});
