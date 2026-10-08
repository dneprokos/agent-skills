import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  arityError,
  deadlineStatus,
  destructiveReason,
  isActivationKey,
  isSameOrigin,
  makeRedactor,
  normalizeUrl,
  originOf,
  pageUrl,
  parseEvalResult,
  parseTabs,
  writtenFiles,
} from "../pw.mjs";

const PW = resolve(dirname(fileURLToPath(import.meta.url)), "..", "pw.mjs");

// ---------- normalizeUrl ----------

test("normalizeUrl strips fragment, sorts query, drops trailing slash", () => {
  assert.equal(normalizeUrl("http://h.test/a/b/?z=1&a=2#top"), "http://h.test/a/b?a=2&z=1");
});

test("normalizeUrl keeps the root as a single slash", () => {
  assert.equal(normalizeUrl("http://h.test"), "http://h.test/");
  assert.equal(normalizeUrl("http://h.test/"), "http://h.test/");
  assert.equal(normalizeUrl("http://h.test/?"), "http://h.test/");
});

test("normalizeUrl treats trailing-slash and query-order variants as one page", () => {
  const a = normalizeUrl("http://h.test/about");
  assert.equal(normalizeUrl("http://h.test/about/"), a);
  assert.equal(normalizeUrl("http://h.test/about#team"), a);
  assert.equal(normalizeUrl("http://h.test/p?b=2&a=1"), normalizeUrl("http://h.test/p?a=1&b=2"));
});

test("normalizeUrl keeps hash routes, they are different pages", () => {
  assert.equal(normalizeUrl("http://h.test/#/admin"), "http://h.test/#/admin");
  assert.equal(normalizeUrl("http://h.test/#!/users"), "http://h.test/#!/users");
  assert.notEqual(normalizeUrl("http://h.test/#/a"), normalizeUrl("http://h.test/#/b"));
});

test("normalizeUrl lowercases the host, drops the default port, strips URL credentials", () => {
  assert.equal(normalizeUrl("HTTP://User:Pw@Host.TEST:80/x"), "http://host.test/x");
  assert.equal(normalizeUrl("https://h.test:443/x"), "https://h.test/x");
  assert.equal(normalizeUrl("http://h.test:8080/x"), "http://h.test:8080/x");
});

test("normalizeUrl resolves relative URLs against a base and collapses repeated slashes", () => {
  assert.equal(normalizeUrl("../c", "http://h.test/a/b/"), "http://h.test/a/c");
  assert.equal(normalizeUrl("http://h.test//a///b"), "http://h.test/a/b");
});

test("normalizeUrl rejects anything that is not http(s)", () => {
  for (const bad of ["mailto:a@b.c", "javascript:alert(1)", "data:text/html,x", "ftp://h.test/", "", "not a url"]) {
    assert.equal(normalizeUrl(bad), null, bad);
  }
});

// ---------- origin ----------

test("origin check compares scheme, host and port", () => {
  const o = originOf("http://h.test:3000/x");
  assert.equal(o, "http://h.test:3000");
  assert.equal(isSameOrigin("http://h.test:3000/other?q=1", o), true);
  assert.equal(isSameOrigin("https://h.test:3000/x", o), false);
  assert.equal(isSameOrigin("http://h.test:3001/x", o), false);
  assert.equal(isSameOrigin("http://www.h.test:3000/x", o), false);
  assert.equal(isSameOrigin("http://h.test.evil.test:3000/x", o), false);
  assert.equal(isSameOrigin("mailto:a@h.test", o), false);
  assert.equal(isSameOrigin("garbage", o), false);
});

// ---------- destructive filter ----------

test("destructiveReason refuses destructive and session-ending names", () => {
  for (const name of ["Delete", "delete account", "Remove item", "Pay", "Pay now", "Purchase", "Send message", "Send", "Logout", "Log out", "Sign out", "Sign-out", "Buy now", "Checkout", "Place order", "Unsubscribe", "Deactivate account"]) {
    assert.ok(destructiveReason({ names: [name] }), name);
  }
});

test("destructiveReason allows ordinary controls", () => {
  for (const name of ["Search", "Sign in", "Log in", "Submit", "Next", "Payment settings", "Save draft", "Cancel", "Contact us", "Products", "Show details"]) {
    assert.equal(destructiveReason({ names: [name] }), null, name);
  }
});

test("destructiveReason inspects link targets and form actions", () => {
  assert.ok(destructiveReason({ hrefs: ["http://h.test/logout"] }));
  assert.ok(destructiveReason({ hrefs: ["/admin/users/5/delete"] }));
  assert.ok(destructiveReason({ hrefs: ["/items?action=remove&id=3"] }));
  assert.ok(destructiveReason({ hrefs: ["/api/session/sign-out"] }));
  assert.equal(destructiveReason({ hrefs: ["/about", "/products/1", "/deleted-items"] }), null);
});

test("destructiveReason reports why", () => {
  assert.match(destructiveReason({ names: ["Delete Widget"] }), /Delete Widget.*delete/);
  assert.match(destructiveReason({ hrefs: ["/logout"] }), /\/logout.*logout/);
});

test("destructiveReason copes with empty input", () => {
  assert.equal(destructiveReason(), null);
  assert.equal(destructiveReason({ names: [null, undefined, ""], hrefs: [""] }), null);
});

// ---------- redaction ----------

test("redactor replaces raw, URL-encoded and JSON-escaped forms", () => {
  const r = makeRedactor([["ADMIN_USER", "ann+qa@corp.test"], ["ADMIN_PASS", 'p"ss w0rd']]);
  assert.equal(r("fill('ann+qa@corp.test')"), "fill('<ADMIN_USER>')");
  assert.equal(r("?u=ann%2Bqa%40corp.test"), "?u=<ADMIN_USER>");
  assert.equal(r('{"p":"p\\"ss w0rd"}'), '{"p":"<ADMIN_PASS>"}');
});

test("redactor replaces the longer value first", () => {
  const r = makeRedactor([["ADMIN_USER", "bob"], ["ADMIN_PASS", "bob-Secret1"]]);
  assert.equal(r("pass bob-Secret1 user bob"), "pass <ADMIN_PASS> user <ADMIN_USER>");
});

test("redactor leaves a credential that is also a URL path segment or part of a word", () => {
  const r = makeRedactor([["ADMIN_USER", "admin"]]);
  assert.equal(r("Page URL: http://h.test/admin/users"), "Page URL: http://h.test/admin/users");
  assert.equal(r("administrator"), "administrator");
  assert.equal(r("Welcome admin!"), "Welcome <ADMIN_USER>!");
  assert.equal(r("fill('admin')"), "fill('<ADMIN_USER>')");
});

test("redactor is inactive and a no-op without values", () => {
  const r = makeRedactor([["ADMIN_USER", null], ["ADMIN_PASS", ""]]);
  assert.equal(r.active, false);
  assert.equal(r("anything"), "anything");
  assert.equal(makeRedactor([["ADMIN_USER", "abc"]]).active, true);
});

test("redactor escapes regex metacharacters in values", () => {
  const r = makeRedactor([["ADMIN_PASS", "a.b*c(d)[e]+?$^|\\"]]);
  assert.equal(r("x a.b*c(d)[e]+?$^|\\ y"), "x <ADMIN_PASS> y");
  assert.equal(r("aXb*c(d)[e]+?$^|\\"), "aXb*c(d)[e]+?$^|\\");
});

// ---------- deadline ----------

test("deadlineStatus", () => {
  assert.deepEqual(deadlineStatus(2000, 1000), { expired: false, remainingMs: 1000 });
  assert.equal(deadlineStatus(1000, 1000).expired, true);
  assert.equal(deadlineStatus(500, 1000).expired, true);
});

// ---------- output parsing ----------

test("parseEvalResult decodes a double-encoded JSON string", () => {
  const out = '### Result\n"{\\"n\\":\\"Home\\",\\"h\\":\\"http://h.test/\\"}"\n### Ran Playwright code\n';
  assert.deepEqual(parseEvalResult(out), { n: "Home", h: "http://h.test/" });
  assert.equal(parseEvalResult('### Result\n"null"\n'), null);
});

test("parseEvalResult returns undefined when there is no usable result", () => {
  assert.equal(parseEvalResult("### Error\nError: Ref e99 not found"), undefined);
  assert.equal(parseEvalResult("### Result\nnot json\n"), undefined);
});

test("pageUrl, parseTabs, writtenFiles", () => {
  const out = "### Page\n- Page URL: http://h.test/a\n- Page Title: A\n### Snapshot\n- [Snapshot](.playwright-cli\\page-1.yml)\n- [Console](.playwright-cli\\console-1.log)";
  assert.equal(pageUrl(out), "http://h.test/a");
  assert.equal(pageUrl("nothing"), null);
  assert.deepEqual(writtenFiles(out), [".playwright-cli/page-1.yml", ".playwright-cli/console-1.log"]);
  const tabs = parseTabs("### Result\n- 0: [Home](http://h.test/)\n- 1: (current) [Ext [x]](https://example.org/)\n");
  assert.deepEqual(tabs, [
    { index: 0, current: false, title: "Home", url: "http://h.test/" },
    { index: 1, current: true, title: "Ext [x]", url: "https://example.org/" },
  ]);
});

// ---------- argument contracts ----------

test("arityError enforces argument counts and element refs", () => {
  assert.equal(arityError("goto", ["http://h.test/"]), null);
  assert.match(arityError("goto", []), /takes 1/);
  assert.match(arityError("goto", ["a", "b"]), /takes 1/);
  assert.equal(arityError("click", ["e5"]), null);
  assert.equal(arityError("click", ["f1e5"]), null);
  assert.match(arityError("click", ["button"]), /element ref/);
  assert.match(arityError("click", ["e5", "right"]), /takes 1/);
  assert.equal(arityError("fill", ["e3", "text"]), null);
  assert.match(arityError("fill", ["e3"]), /takes 2/);
  assert.equal(arityError("snapshot", []), null);
  assert.equal(arityError("dialog-accept", []), null);
  assert.equal(arityError("dialog-accept", ["yes"]), null);
});

test("isActivationKey", () => {
  for (const k of ["Enter", "enter", "NumpadEnter", "Space", " ", "Control+Enter", "Shift+Space"]) assert.equal(isActivationKey(k), true, k);
  for (const k of ["Tab", "Escape", "ArrowDown", "a", "Backspace", "Enterprise"]) assert.equal(isActivationKey(k), false, k);
});

// ---------- the CLI's own refusals (no browser needed: guards run before playwright-cli) ----------

function pw(cwd, ...args) {
  const r = spawnSync(process.execPath, [PW, ...args], { cwd, encoding: "utf8" });
  return { code: r.status, out: (r.stdout || "") + (r.stderr || "") };
}

test("CLI guards", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "et-pw-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const S = "-s=unit";

  await t.test("a session name is required", () => {
    const r = pw(dir, "status");
    assert.equal(r.code, 3);
    assert.match(r.out, /named session is required/);
  });

  await t.test("browser commands need init first", () => {
    const r = pw(dir, S, "snapshot");
    assert.equal(r.code, 3);
    assert.match(r.out, /run init first/);
  });

  await t.test("init validates its input", () => {
    assert.equal(pw(dir, S, "init", "--minutes", "5").code, 3);
    assert.equal(pw(dir, S, "init", "--base-url", "ftp://x", "--minutes", "5").code, 3);
    assert.equal(pw(dir, S, "init", "--base-url", "http://h.test").code, 3);
    assert.equal(pw(dir, S, "init", "--base-url", "http://h.test", "--minutes", "0").code, 3);
    assert.equal(pw(dir, S, "init", "--base-url", "http://h.test", "--minutes", "5", "--creds").code, 3);
    assert.equal(pw(dir, S, "--admin-user", "ab", "--admin-pass", "secret1", "init", "--base-url", "http://h.test", "--minutes", "5", "--creds").code, 3);
  });

  await t.test("init writes state and never the credentials", () => {
    const r = pw(dir, S, "--admin-user", "ann@corp.test", "--admin-pass", "Sup3rSecret!", "init", "--base-url", "http://h.test:3000/", "--minutes", "5", "--creds");
    assert.equal(r.code, 0, r.out);
    assert.doesNotMatch(r.out, /Sup3rSecret|ann@corp/);
    const state = JSON.parse(readFileSync(join(dir, ".playwright-cli", "exploratory-testing", "unit", "state.json"), "utf8"));
    assert.equal(state.origin, "http://h.test:3000");
    assert.equal(state.hasCreds, true);
    const dump = JSON.stringify(state) + readFileSync(join(dir, ".playwright-cli", "exploratory-testing", "unit", "visited.json"), "utf8");
    assert.doesNotMatch(dump, /Sup3rSecret|ann@corp/);
  });

  await t.test("a creds session refuses browser calls without the creds flags", () => {
    const r = pw(dir, S, "goto", "http://h.test:3000/a");
    assert.equal(r.code, 4);
    assert.match(r.out, /BLOCKED creds-missing/);
  });

  await t.test("status needs no creds and reports counters", () => {
    const r = pw(dir, S, "status");
    assert.equal(r.code, 0);
    const s = JSON.parse(r.out);
    assert.equal(s.expired, false);
    assert.equal(s.visited, 0);
    assert.equal(s.blocked, 1);
  });

  await t.test("blocked log records the refusal", () => {
    const r = pw(dir, S, "blocked");
    assert.match(r.out, /creds-missing/);
  });

  const C = ["--admin-user", "ann@corp.test", "--admin-pass", "Sup3rSecret!"];

  await t.test("off-origin, destructive, scheme and unknown commands are refused before any browser call", () => {
    let r = pw(dir, S, ...C, "goto", "https://example.org/");
    assert.equal(r.code, 4);
    assert.match(r.out, /BLOCKED off-origin/);
    r = pw(dir, S, ...C, "goto", "http://h.test:3000/logout");
    assert.match(r.out, /BLOCKED destructive/);
    r = pw(dir, S, ...C, "goto", "javascript:alert(1)");
    assert.match(r.out, /BLOCKED scheme/);
    for (const cmd of ["eval", "run-code", "go-back", "tab-new", "state-load", "cookie-list", "upload"]) {
      r = pw(dir, S, ...C, cmd, "x");
      assert.equal(r.code, 4, cmd);
      assert.match(r.out, /BLOCKED command-not-allowed/, cmd);
    }
  });

  await t.test("a creds flag without --creds at init is rejected", () => {
    pw(dir, "-s=plain", "init", "--base-url", "http://h.test", "--minutes", "5");
    const r = pw(dir, "-s=plain", "--admin-user", "abcd", "--admin-pass", "efgh", "snapshot");
    assert.equal(r.code, 3);
  });

  await t.test("after the deadline every browser command is refused, status still works", () => {
    assert.equal(pw(dir, "-s=late", "init", "--base-url", "http://h.test", "--deadline", "2000-01-01T00:00:00Z").code, 0);
    const r = pw(dir, "-s=late", "goto", "http://h.test/a");
    assert.equal(r.code, 4);
    assert.match(r.out, /BLOCKED deadline/);
    const s = JSON.parse(pw(dir, "-s=late", "status").out);
    assert.equal(s.expired, true);
    assert.equal(s.remainingSeconds, 0);
  });

  await t.test("scrub replaces credentials in a file", () => {
    const f = join(dir, "findings.md");
    writeFileSync(f, "login as ann@corp.test with Sup3rSecret! failed\n");
    const r = pw(dir, S, ...C, "scrub", f);
    assert.equal(r.code, 0);
    assert.equal(readFileSync(f, "utf8"), "login as <ADMIN_USER> with <ADMIN_PASS> failed\n");
    assert.ok(existsSync(f));
  });
});
