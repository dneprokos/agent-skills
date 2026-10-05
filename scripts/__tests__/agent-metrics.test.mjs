/**
 * Tests for .claude/hooks/agent-metrics.mjs, .claude/hooks/metrics-report.mjs and the transcript
 * summariser they share.
 *
 * The hooks live under .claude/ because that is harness wiring rather than something an agent runs,
 * but their tests belong with every other script test, so this file reaches across. Each case spawns
 * the hook the way the harness does — a JSON payload on stdin — and asserts on the files it wrote.
 *
 * Every case runs against a temporary project directory, never the repository's own `.workflow/`, and
 * against a temporary `CLAUDE_CONFIG_DIR`, never the real `~/.claude` — the transcript the bill is
 * summed from is written by the test, so the expected figures are computed by hand.
 *
 * THE TEST THAT SHOULD HAVE EXISTED FIRST is "a completed Task writes one record". This hook shipped
 * with no coverage at all and, as it turned out, had never written a single record in production —
 * a condition no amount of reading the code revealed, because the code was right and the wiring was
 * not. Every case here asserts on an observable file, not on a return value.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { SUBAGENT_TOOLS } from "../../.claude/hooks/lib/subagent-tools.mjs";
import { summarizeTranscript, locateTranscript } from "../../.claude/hooks/lib/transcript-usage.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const hook = join(repoRoot, ".claude", "hooks", "agent-metrics.mjs");
const report = join(repoRoot, ".claude", "hooks", "metrics-report.mjs");

/** A throwaway project root, marked with a `.git` entry so the repo-root walk stops there. */
function project() {
  const dir = mkdtempSync(join(tmpdir(), "agent-metrics-"));
  writeFileSync(join(dir, ".git"), "gitdir: irrelevant\n", "utf8");
  // Its own Claude config dir too, so no test ever reads a real transcript.
  const config = mkdtempSync(join(tmpdir(), "claude-config-"));
  mkdirSync(join(config, "projects"), { recursive: true });
  writeFileSync(join(dir, ".config-dir"), config, "utf8");
  return dir;
}
const configOf = (dir) => readFileSync(join(dir, ".config-dir"), "utf8");

/**
 * A subagent transcript in the shape the harness writes: one line per content block, every block of a
 * message repeating that message's `usage`, plus the `.meta.json` carrying the `toolUseId`.
 *
 * Each `call` is one API call. `tools` tool_use blocks (each followed by its tool_result) and, on the
 * last call when `complete`, a closing text block. Default: one call of 2 in / 100 out / 1,000 cache
 * read / 500 cache write (5m) on Opus 5 — $0.006135 by hand.
 */
function transcript(dir, opts = {}) {
  const {
    sessionId = "sess-1",
    agentId = "agent_1",
    toolUseId = "toolu_01",
    agentType = "qa-scenario-generator",
    requestShape = "foreground",
    model = "claude-opus-5",
    calls = [{ input: 2, output: 100, cache_read: 1000, cache_write_5m: 500, tools: 1 }],
    startedAt = "2026-08-19T00:00:00Z",
    stepMs = 1000,
    complete = true,
    speed = "standard",
    legacyStop = false,
  } = opts;
  const sub = join(configOf(dir), "projects", "slug-x", sessionId, "subagents");
  mkdirSync(sub, { recursive: true });
  const lines = [];
  let t = Date.parse(startedAt);
  const stamp = () => new Date((t += stepMs)).toISOString();
  calls.forEach((c, i) => {
    const id = `msg_${i}`;
    const usage = {
      input_tokens: c.input ?? 0,
      output_tokens: c.output ?? 0,
      cache_read_input_tokens: c.cache_read ?? 0,
      cache_creation_input_tokens: (c.cache_write_5m ?? 0) + (c.cache_write_1h ?? 0),
      cache_creation: { ephemeral_5m_input_tokens: c.cache_write_5m ?? 0, ephemeral_1h_input_tokens: c.cache_write_1h ?? 0 },
      service_tier: "standard",
      speed: c.speed ?? speed,
    };
    const msg = (content, stop) => ({
      type: "assistant",
      timestamp: stamp(),
      message: { id, model: c.model ?? model, role: "assistant", content: [content], stop_reason: stop, usage },
    });
    for (let k = 0; k < (c.tools ?? 0); k += 1) {
      lines.push(msg({ type: "tool_use", id: `tu_${i}_${k}`, name: "Read", input: {} }, "tool_use"));
      lines.push({ type: "user", timestamp: stamp(), message: { role: "user", content: [{ type: "tool_result", tool_use_id: `tu_${i}_${k}` }] } });
    }
    if (i === calls.length - 1 && complete) lines.push(msg({ type: "text", text: "done" }, legacyStop ? null : "end_turn"));
  });
  writeFileSync(join(sub, `agent-${agentId}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n", "utf8");
  writeFileSync(
    join(sub, `agent-${agentId}.meta.json`),
    JSON.stringify({ agentType, description: "x", toolUseId, spawnDepth: 1, requestShape, model: "opus" }),
    "utf8",
  );
  return join(sub, `agent-${agentId}.jsonl`);
}

/** The hand-computed bill of the default transcript, on Opus 5: 2×5 + 100×25 + 1000×0.5 + 500×6.25 per M. */
const DEFAULT_TOTAL = 1602;
const DEFAULT_USD = (2 * 5 + 100 * 25 + 1000 * 0.5 + 500 * 6.25) / 1e6;

/**
 * A PostToolUse payload for a completed Task. The `tool_response` keys are the ones the harness
 * actually writes for the Task tool — the same object the transcript stores as `toolUseResult`.
 */
function completedPayload(dir, overrides = {}) {
  return {
    session_id: "sess-1",
    transcript_path: join(dir, "transcript.jsonl"),
    cwd: dir,
    hook_event_name: "PostToolUse",
    tool_name: "Task",
    tool_use_id: "toolu_01",
    tool_input: {
      subagent_type: "qa-scenario-generator",
      description: "Generate scenarios",
      prompt: "ticket_id: SCRUM-777\nrequirements_path: requirements/SCRUM-777-requirements.md",
    },
    tool_response: {
      status: "completed",
      agentId: "agent_1",
      agentType: "qa-scenario-generator",
      resolvedModel: "claude-opus-5",
      totalDurationMs: 109_000,
      totalTokens: 63_563,
      totalToolUseCount: 26,
      usage: {
        input_tokens: 2,
        output_tokens: 5872,
        cache_read_input_tokens: 50_682,
        cache_creation_input_tokens: 7007,
      },
      toolStats: { Read: 12 },
    },
    duration_ms: 109_500,
    ...overrides,
  };
}

function fire(dir, mode, payload) {
  const result = spawnSync(process.execPath, [hook, mode], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: configOf(dir) },
  });
  assert.equal(result.error, undefined, `failed to spawn: ${result.error?.message}`);
  // Never failing a tool call is the headline promise; it belongs in every case, not one of them.
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  return result;
}

function runReport(dir, ...args) {
  const result = spawnSync(process.execPath, [report, ...args], {
    encoding: "utf8",
    cwd: dir,
    env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: configOf(dir) },
  });
  assert.equal(result.error, undefined, `failed to spawn: ${result.error?.message}`);
  return result;
}

const records = (dir, ticket) => {
  const file = join(dir, ".workflow", "metrics", `${ticket}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
};

const diagnostics = (dir) => {
  const file = join(dir, ".workflow", "metrics", "_diagnostics.jsonl");
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
};

const pending = (dir) => {
  const dirPath = join(dir, ".workflow", "metrics", "pending");
  return existsSync(dirPath) ? readdirSync(dirPath) : [];
};

const metricsLine = (stdout) => JSON.parse(stdout).hookSpecificOutput.additionalContext;

// ---------------------------------------------------------------------------------------------
// The transcript summariser — the arithmetic every figure in the table rests on
// ---------------------------------------------------------------------------------------------

test("usage is summed once per message, not once per line", () => {
  const dir = project();
  // One API call, two tool_use blocks and a text block: three assistant lines sharing one message id.
  const file = transcript(dir, { calls: [{ input: 2, output: 100, cache_read: 1000, cache_write_5m: 500, tools: 2 }] });
  const billed = summarizeTranscript(file);
  assert.equal(billed.api_calls, 1, "three lines, one call");
  assert.equal(billed.total, DEFAULT_TOTAL, "summing lines would have tripled this");
  assert.equal(billed.tool_uses, 2, "tool uses are counted over lines, because each block is its own line");
  assert.equal(billed.model, "claude-opus-5");
  assert.equal(billed.speed, "standard");
  assert.equal(billed.complete, true);
});

test("the cache-write TTL split is carried, so nothing about the price has to be assumed", () => {
  const dir = project();
  const file = transcript(dir, { calls: [{ cache_write_5m: 300, cache_write_1h: 200, tools: 1 }] });
  const billed = summarizeTranscript(file);
  assert.equal(billed.cache_write, 500);
  assert.equal(billed.cache_write_5m, 300);
  assert.equal(billed.cache_write_1h, 200);
  assert.equal(billed.cache_write_unknown_ttl, 0);
});

test("a run that switched models keeps a per-model split", () => {
  const dir = project();
  const file = transcript(dir, {
    calls: [
      { output: 10, tools: 1, model: "claude-sonnet-5" },
      { output: 20, tools: 1, model: "claude-opus-5" },
    ],
  });
  const billed = summarizeTranscript(file);
  assert.equal(billed.model, "mixed");
  assert.equal(billed.by_model["claude-sonnet-5"].output, 10);
  assert.equal(billed.by_model["claude-opus-5"].output, 20);
  assert.equal(billed.api_calls, 2);
});

test("a transcript ending on a tool call is incomplete; a closing text block is complete under either stop_reason", () => {
  const dir = project();
  assert.equal(summarizeTranscript(transcript(dir, { agentId: "a", complete: false })).complete, false);
  assert.equal(summarizeTranscript(transcript(dir, { agentId: "b", complete: true })).complete, true);
  // Older harness builds wrote `null` on the final block where newer ones write `end_turn`. Shape, not
  // the literal, is what says the agent finished — otherwise every pre-2026-09 run reads as killed.
  assert.equal(summarizeTranscript(transcript(dir, { agentId: "c", complete: true, legacyStop: true })).complete, true);
});

test("duration is the transcript's own span, first line to last", () => {
  const dir = project();
  // 1 tool_use + 1 tool_result + 1 text = 3 stamps at 1s each → 2s between first and last.
  const billed = summarizeTranscript(transcript(dir, { stepMs: 1000 }));
  assert.equal(billed.duration_ms, 2000);
});

test("a transcript is found by agent id, or by tool_use_id through the sibling meta file", () => {
  const dir = project();
  transcript(dir, { agentId: "agent_x", toolUseId: "toolu_x" });
  const projectsDir = join(configOf(dir), "projects");
  assert.ok(locateTranscript({ sessionId: "sess-1", agentId: "agent_x", projectsDir }));
  const byTool = locateTranscript({ sessionId: "sess-1", toolUseId: "toolu_x", projectsDir });
  assert.equal(byTool.agentId, "agent_x", "every row written before the redesign has only a tool_use_id");
  assert.equal(locateTranscript({ sessionId: "sess-other", toolUseId: "toolu_x", projectsDir }), null);
  assert.equal(locateTranscript({ sessionId: null, agentId: "agent_x", projectsDir }), null);
});

// ---------------------------------------------------------------------------------------------
// The hook
// ---------------------------------------------------------------------------------------------

test("a completed Task writes exactly one record, filed under the ticket in its prompt, billed from its transcript", () => {
  const dir = project();
  transcript(dir);
  const { stdout } = fire(dir, "--post", completedPayload(dir));

  const rows = records(dir, "SCRUM-777");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].seq, 1);
  assert.equal(rows[0].agent, "qa-scenario-generator");
  assert.equal(rows[0].ticket_source, "prompt");
  assert.equal(rows[0].duration_ms, 109_000);
  assert.equal(rows[0].billed.total, DEFAULT_TOTAL);
  assert.equal(rows[0].billed.api_calls, 1);
  assert.equal(rows[0].billed.scope, "run");
  assert.equal(rows[0].tool_uses, 26, "the harness count wins over the transcript count when both exist");

  // The line the orchestrator reads straight out of the transcript: the bill, not the final turn.
  const line = metricsLine(stdout);
  assert.match(line, /^AGENT_RUN_METRICS: seq=1 ticket=SCRUM-777/);
  assert.match(line, new RegExp(`tokens=${DEFAULT_TOTAL} cost=\\$${DEFAULT_USD.toFixed(4)} api_calls=1`));
  assert.ok(!line.includes("end_context="), "the final-turn figure never rides the line under any name");
  assert.deepEqual(diagnostics(dir), []);
});

test("the final-turn block is kept under the one name that says what it is", () => {
  const dir = project();
  transcript(dir);
  fire(dir, "--post", completedPayload(dir));
  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.end_context.total, 63_563);
  assert.equal(row.end_context.scope, "final_turn");
  assert.ok(!("tokens" in row), "the legacy duplicate is gone; the reader shim covers old rows");
});

test("a completed Task whose transcript is not on this machine records the completion and no bill", () => {
  const dir = project();
  const { stdout } = fire(dir, "--post", completedPayload(dir));
  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.status, "completed");
  assert.equal(row.billed, null, "no transcript, no bill — never the final turn dressed as one");
  assert.match(metricsLine(stdout), /tokens=unavailable cost=unavailable/);
});

test("usage.iterations is recorded, so a harness that starts reporting the whole run is visible", () => {
  const dir = project();
  const payload = completedPayload(dir);
  payload.tool_response.usage.iterations = [{ output_tokens: 5872, type: "message" }];
  fire(dir, "--post", payload);
  assert.equal(records(dir, "SCRUM-777")[0].end_context.messages, 1);
});

test("an interrupted run keeps no bill and no final-turn block", () => {
  const dir = project();
  transcript(dir, { complete: false });
  fire(dir, "--failed", {
    ...completedPayload(dir),
    hook_event_name: "PostToolUseFailure",
    tool_response: undefined,
    is_interrupt: true,
    duration_ms: 42_000,
  });
  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.billed, null, "a partial sum presented as the run's cost is a different number");
  assert.equal(row.end_context, null, "zero would read as free; absent is the honest record");
});

test("a payload carrying no result writes no record but says why", () => {
  const dir = project();
  const payload = completedPayload(dir);
  delete payload.tool_response;
  const { stdout } = fire(dir, "--post", payload);

  assert.deepEqual(records(dir, "SCRUM-777"), []);
  assert.equal(stdout.trim(), "");
  const diag = diagnostics(dir);
  assert.equal(diag.length, 1);
  assert.equal(diag[0].reason, "no_result");
  assert.equal(diag[0].tool_use_id, "toolu_01");
});

// ---------------------------------------------------------------------------------------------
// Background launches — the bug that erased three real runs, then every run of a ticket
// ---------------------------------------------------------------------------------------------

/**
 * What the harness actually sends when an agent is launched in the background: PostToolUse fires on
 * the *launch*, and the response carries `isAsync`, the `agentId`, the `resolvedModel`, an
 * `outputFile` and no cost whatsoever, because the agent has not stopped.
 */
function asyncLaunchPayload(dir, overrides = {}) {
  const payload = completedPayload(dir, overrides);
  payload.tool_response = {
    isAsync: true,
    status: "async_launched",
    agentId: "agent_async_1",
    description: "Generate scenarios",
    resolvedModel: "claude-opus-5[1m]",
    prompt: payload.tool_input.prompt,
    outputFile: join(dir, "out.jsonl"),
    canReadOutputFile: true,
  };
  return payload;
}

test("a bail never consumes the launch record", () => {
  const dir = project();
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  const payload = completedPayload(dir);
  delete payload.tool_response;
  fire(dir, "--post", payload);

  // The order used to be: take the pending, then discover there is no result, then return. That
  // destroyed the only evidence the run had ever been launched, so the report could not reconcile it
  // and the run left the log entirely. The launch record has to outlive the bail.
  assert.equal(pending(dir).length, 1, "the launch record must survive a bail");
  assert.equal(diagnostics(dir).at(-1).had_pending, true);
});

test("a background launch is recorded as a row carrying the agent id the bill will be found by", () => {
  const dir = project();
  fire(dir, "--pre", asyncLaunchPayload(dir, { hook_event_name: "PreToolUse" }));
  const { stdout } = fire(dir, "--post", asyncLaunchPayload(dir));

  const rows = records(dir, "SCRUM-777");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "background");
  assert.equal(rows[0].agent_id, "agent_async_1", "this id was on the response all along and used to be thrown away");
  assert.equal(rows[0].model, "claude-opus-5[1m]");
  assert.equal(rows[0].billed, null, "nothing has been spent at launch");
  assert.equal(rows[0].started_at_measured, true);
  assert.deepEqual(pending(dir), [], "the row is the record; the launch file has been replaced, not lost");
  assert.match(metricsLine(stdout), /status=background .*tokens=unavailable/);
  assert.deepEqual(diagnostics(dir), [], "a background launch is an event, not a failure to diagnose");
});

test("the report completes a background row from its transcript once the agent has stopped", () => {
  const dir = project();
  fire(dir, "--pre", asyncLaunchPayload(dir, { hook_event_name: "PreToolUse" }));
  fire(dir, "--post", asyncLaunchPayload(dir));
  // The agent runs and finishes; only the transcript records that.
  transcript(dir, { agentId: "agent_async_1", requestShape: "background", calls: [{ output: 1_000_000, tools: 1 }] });

  const { status, stdout } = runReport(dir, "SCRUM-777");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /\| completed \| claude-opus-5 \| 1 \| 1 \| /);
  assert.ok(stdout.includes("$25.00"), stdout); // 1M output tokens on Opus 5
  assert.match(stdout, /Reconciled this run: 1 row\(s\) completed from transcripts/);

  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.status, "completed");
  assert.equal(row.billed.output, 1_000_000);
  assert.equal(row.cost_source, "subagent_transcript");
  assert.equal(row.request_shape, "background");
  assert.equal(row.tool_uses, 1, "the transcript count fills a field the launch could not");

  // Idempotent: a second report changes nothing and reports nothing reconciled.
  const second = runReport(dir, "SCRUM-777");
  assert.ok(!second.stdout.includes("Reconciled this run"), second.stdout);
  assert.equal(records(dir, "SCRUM-777").length, 1);
});

test("a background row whose transcript is nowhere stays visible as unobserved, never as interrupted", () => {
  const dir = project();
  fire(dir, "--post", asyncLaunchPayload(dir));
  const { stdout } = runReport(dir, "SCRUM-777");
  assert.match(stdout, /\| background \|/);
  assert.match(stdout, /1 run\(s\) have no transcript on this machine/);
  assert.ok(!stdout.includes("interrupted"), "a background run is not an interrupt");
  assert.ok(!/\$\d/.test(stdout), "no figure is invented for it");
});

test("a background row whose transcript ends mid-run is priced for what ran and marked incomplete", () => {
  const dir = project();
  fire(dir, "--post", asyncLaunchPayload(dir));
  transcript(dir, { agentId: "agent_async_1", complete: false });
  const { stdout } = runReport(dir, "SCRUM-777");
  assert.match(stdout, /\| incomplete \|/);
  assert.match(stdout, /1 run\(s\) are incomplete: the transcript ends mid-run/);
});

test("malformed and empty input are recorded, not swallowed", () => {
  const dir = project();
  for (const input of ["", "not json at all"]) {
    const result = spawnSync(process.execPath, [hook, "--post"], {
      input,
      encoding: "utf8",
      cwd: dir,
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir, CLAUDE_CONFIG_DIR: configOf(dir) },
    });
    assert.equal(result.status, 0);
  }
  assert.deepEqual(
    diagnostics(dir).map((d) => d.reason),
    ["no_stdin", "bad_json"],
  );
});

test("a payload for some other tool is ignored without a diagnostic", () => {
  const dir = project();
  fire(dir, "--post", {
    ...completedPayload(dir),
    tool_name: "Bash",
    tool_input: { command: "npm run typecheck", description: "type check" },
  });
  assert.deepEqual(records(dir, "SCRUM-777"), []);
  assert.deepEqual(diagnostics(dir), []);
});

test("the subagent tool under either of its names is recorded the same way", () => {
  for (const toolName of SUBAGENT_TOOLS) {
    const dir = project();
    transcript(dir);
    fire(dir, "--pre", completedPayload(dir, { tool_name: toolName, hook_event_name: "PreToolUse" }));
    fire(dir, "--post", completedPayload(dir, { tool_name: toolName }));

    const rows = records(dir, "SCRUM-777");
    assert.equal(rows.length, 1, `${toolName} wrote ${rows.length} record(s)`);
    assert.equal(rows[0].billed.total, DEFAULT_TOTAL);
    assert.equal(rows[0].started_at_measured, true);
    assert.deepEqual(diagnostics(dir), [], `${toolName} should be recognised, not diagnosed`);
  }
});

test("a subagent launch under an unknown tool name is reported, not swallowed", () => {
  const dir = project();
  const { stdout } = fire(dir, "--post", { ...completedPayload(dir), tool_name: "SubagentV3" });
  assert.deepEqual(records(dir, "SCRUM-777"), []);
  assert.equal(stdout.trim(), "");
  const diag = diagnostics(dir);
  assert.equal(diag.length, 1);
  assert.equal(diag[0].reason, "unrecognised_subagent_tool");
  assert.equal(diag[0].tool_name, "SubagentV3");
  assert.equal(diag[0].mode, "post");
});

/**
 * The wiring check. Every failure this hook has had was the script being right and its registration
 * being wrong, and no test of the script alone can see that. This one reads the real settings file.
 */
test("settings.json fires all three modes for every tool name the hook accepts", () => {
  const settings = JSON.parse(readFileSync(join(repoRoot, ".claude", "settings.json"), "utf8"));

  for (const event of ["PreToolUse", "PostToolUse", "PostToolUseFailure"]) {
    const entries = settings.hooks?.[event] ?? [];
    const matchers = entries
      .filter((e) => (e.hooks ?? []).some((h) => String(h.command ?? "").includes("agent-metrics.mjs")))
      .map((e) => e.matcher);
    assert.ok(matchers.length > 0, `${event} does not run agent-metrics.mjs at all`);

    for (const toolName of SUBAGENT_TOOLS) {
      assert.ok(
        matchers.some((m) => new RegExp(`^(?:${m})$`).test(toolName)),
        `${event} matcher ${JSON.stringify(matchers)} does not match tool name ${toolName}`,
      );
    }
  }
});

test("--pre then --post yields one record with the measured start time and no pending file", () => {
  const dir = project();
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  assert.equal(pending(dir).length, 1);

  fire(dir, "--post", completedPayload(dir));
  const rows = records(dir, "SCRUM-777");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].started_at_measured, true);
  assert.deepEqual(pending(dir), []);

  const derived = Date.parse(rows[0].finished_at) - rows[0].duration_ms;
  assert.ok(Date.parse(rows[0].started_at) > derived, "a measured start must precede nothing it excludes");
});

test("--post without a --pre still records, marked as an unmeasured start", () => {
  const dir = project();
  fire(dir, "--post", completedPayload(dir));
  assert.equal(records(dir, "SCRUM-777")[0].started_at_measured, false);
});

test("an interrupted Task is recorded as an event, with no invented cost", () => {
  const dir = project();
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  fire(dir, "--failed", {
    ...completedPayload(dir),
    hook_event_name: "PostToolUseFailure",
    tool_response: undefined,
    error: "Request interrupted by user",
    error_type: "interrupt",
    is_interrupt: true,
    is_timeout: false,
    duration_ms: 42_000,
  });

  const rows = records(dir, "SCRUM-777");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "interrupted");
  assert.equal(rows[0].billed, null, "an agent that never stopped has no bill on record");
  assert.equal(rows[0].duration_ms, 42_000);
  assert.equal(rows[0].started_at_measured, true);
  assert.deepEqual(pending(dir), []);
});

test("two parallel launches of the same agent are correlated by tool_use_id, not by name", () => {
  const dir = project();
  const a = completedPayload(dir, { tool_use_id: "toolu_A" });
  const b = completedPayload(dir, { tool_use_id: "toolu_B" });

  fire(dir, "--pre", { ...a, hook_event_name: "PreToolUse" });
  fire(dir, "--pre", { ...b, hook_event_name: "PreToolUse" });
  assert.equal(pending(dir).length, 2);

  fire(dir, "--post", b);
  assert.equal(pending(dir).length, 1);
  fire(dir, "--post", a);
  assert.deepEqual(pending(dir), []);

  const rows = records(dir, "SCRUM-777");
  assert.deepEqual(rows.map((r) => r.tool_use_id), ["toolu_B", "toolu_A"]);
  assert.deepEqual(rows.map((r) => r.seq), [1, 2]);
});

test("a state file on a non-running status still identifies the ticket", () => {
  const dir = project();
  mkdirSync(join(dir, ".workflow"), { recursive: true });
  writeFileSync(join(dir, ".workflow", "SCRUM-888.yaml"), "ticket_id: SCRUM-888\nstatus: escalated\n", "utf8");

  const payload = completedPayload(dir);
  payload.tool_input = { subagent_type: "qa-scenario-reviewer", description: "review", prompt: "no id here" };
  fire(dir, "--post", payload);

  const rows = records(dir, "SCRUM-888");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ticket_source, "state_file");
});

test("prose inside a findings block does not masquerade as a status line", () => {
  const dir = project();
  mkdirSync(join(dir, ".workflow"), { recursive: true });
  writeFileSync(
    join(dir, ".workflow", "SCRUM-889.yaml"),
    'ticket_id: SCRUM-889\nstatus: completed\ntest_design:\n  review_status: in_progress\n  last_findings: "the run was left in a state: in_progress by the previous session"\n',
    "utf8",
  );

  const payload = completedPayload(dir);
  payload.tool_input = { subagent_type: "qa-scenario-reviewer", description: "review", prompt: "no id here" };
  fire(dir, "--post", payload);

  assert.deepEqual(records(dir, "SCRUM-889"), []);
  assert.equal(records(dir, "unassigned").length, 1);
  assert.equal(diagnostics(dir).at(-1).reason, "ticket_unresolved");
});

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

test("the report renders an interrupted launch, and reconciles it exactly once", () => {
  const dir = project();
  transcript(dir, { toolUseId: "toolu_done", agentId: "agent_done" });
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  fire(dir, "--post", completedPayload(dir, { tool_use_id: "toolu_done", tool_response: { ...completedPayload(dir).tool_response, agentId: "agent_done" } }));
  // toolu_01 never completes and left no transcript.

  const first = runReport(dir, "SCRUM-777");
  assert.equal(first.status, 0, first.stderr);
  // Status, then model, calls, tools, duration, tokens, cost — every one a dash, none of them invented.
  assert.match(first.stdout, /\| interrupted \| — \| — \| — \| — \| — \| — \|/);
  assert.match(first.stdout, /1 run\(s\) were interrupted before the agent stopped/);
  assert.deepEqual(pending(dir), []);

  const second = runReport(dir, "SCRUM-777");
  assert.equal(records(dir, "SCRUM-777").filter((r) => r.status === "interrupted").length, 1);
  // Identical apart from the one line that says something was reconciled — the second run reconciles nothing.
  const stable = (s) => s.replace(/^Reconciled this run:.*\n\n?/m, "");
  assert.equal(stable(second.stdout), stable(first.stdout));
  assert.ok(!second.stdout.includes("Reconciled this run"), second.stdout);
});

test("a launch record whose transcript exists is promoted as a completed, priced run", () => {
  const dir = project();
  // The pre-hook fired, the session died before the post-hook, but the agent itself had finished.
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  transcript(dir);
  const { stdout } = runReport(dir, "SCRUM-777");
  assert.match(stdout, /\| completed \| claude-opus-5 \| 1 \| 1 \|/);
  assert.ok(!stdout.includes("interrupted"), "the transcript is the completion record the hook never got");
  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.billed.total, DEFAULT_TOTAL);
});

test("the step is read off the prompt and printed, and an interrupted run keeps the one it was launched with", () => {
  const dir = project();
  const prompt = "ticket_id: SCRUM-777\nrun_mode: re_review\nstep: 2.2b\nprevious_findings: none";
  const payload = completedPayload(dir);
  payload.tool_input.prompt = prompt;
  fire(dir, "--pre", { ...payload, hook_event_name: "PreToolUse" });
  fire(dir, "--failed", { ...payload, hook_event_name: "PostToolUseFailure", tool_response: undefined, is_interrupt: true, duration_ms: 8_000 });

  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.step, "2.2b");
  assert.match(runReport(dir, "SCRUM-777").stdout, /\| 1 \| 2\.2b \| `qa-scenario-generator` \|/);
});

test("a prompt without a step prints a dash, never a guess", () => {
  const dir = project();
  fire(dir, "--post", completedPayload(dir));
  assert.equal(records(dir, "SCRUM-777")[0].step, null);
  assert.match(runReport(dir, "SCRUM-777").stdout, /\| 1 \| — \| `qa-scenario-generator` \|/);
});

test("--last prints the orchestrator's line for the latest run of an agent, after reconciling", () => {
  const dir = project();
  fire(dir, "--post", asyncLaunchPayload(dir));
  transcript(dir, { agentId: "agent_async_1", requestShape: "background" });
  const { stdout } = runReport(dir, "SCRUM-777", "--last", "qa-scenario-generator");
  assert.match(stdout, new RegExp(`^AGENT_RUN_METRICS: seq=1 ticket=SCRUM-777 agent=qa-scenario-generator .*status=completed .*tokens=${DEFAULT_TOTAL} cost=\\$${DEFAULT_USD.toFixed(4)}`));
  assert.match(runReport(dir, "SCRUM-777", "--last", "nobody").stdout, /^AGENT_RUN_METRICS: unavailable/);
});

test("the report survives a torn line instead of destroying the cost section", () => {
  const dir = project();
  transcript(dir);
  fire(dir, "--post", completedPayload(dir));
  const file = join(dir, ".workflow", "metrics", "SCRUM-777.jsonl");
  writeFileSync(file, `${readFileSync(file, "utf8")}{"seq":2,"agent":"qa-\n`, "utf8");

  const { status, stdout } = runReport(dir, "SCRUM-777");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /1 unreadable line\(s\) skipped/);
  assert.match(stdout, /\*\*1,602\*\*/);
});

test("the report finds the log from a subdirectory", () => {
  const dir = project();
  fire(dir, "--post", completedPayload(dir));
  const nested = join(dir, "tests", "api");
  mkdirSync(nested, { recursive: true });

  const result = spawnSync(process.execPath, [report, "SCRUM-777"], {
    encoding: "utf8",
    cwd: nested,
    env: { ...process.env, CLAUDE_PROJECT_DIR: "", CLAUDE_CONFIG_DIR: configOf(dir) },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Agent run cost — SCRUM-777/);
  assert.ok(!result.stdout.includes("No metrics recorded"), result.stdout);
});

test("the report says so plainly when there is nothing to report", () => {
  const dir = project();
  const { status, stdout } = runReport(dir, "SCRUM-000");
  assert.equal(status, 0);
  assert.match(stdout, /No metrics recorded for SCRUM-000/);
});

test("--json carries the interrupted count and never a fabricated total", () => {
  const dir = project();
  fire(dir, "--pre", completedPayload(dir, { hook_event_name: "PreToolUse" }));
  const { stdout } = runReport(dir, "SCRUM-777", "--json");
  const summary = JSON.parse(stdout);
  assert.equal(summary.runs, 1);
  assert.equal(summary.interrupted, 1);
  assert.equal(summary.billed_runs, 0);
  assert.equal(summary.total.tokens, 0);
  assert.equal(summary.total_usd, null);
  assert.equal(summary.wall_clock_ms, null, "one row with no finish time cannot span a wall clock");
});

test("wall clock spans the latest session, not the calendar between resumes", () => {
  const dir = project();
  const day1 = { started_at: "2026-08-01T10:00:00Z", finished_at: "2026-08-01T10:10:00Z", duration_ms: 600_000 };
  const day9 = { started_at: "2026-08-09T10:00:00Z", finished_at: "2026-08-09T10:05:00Z", duration_ms: 300_000 };
  mkdirSync(join(dir, ".workflow", "metrics"), { recursive: true });
  writeFileSync(
    join(dir, ".workflow", "metrics", "SCRUM-777.jsonl"),
    [
      { seq: 1, ticket: "SCRUM-777", agent: "a", status: "completed", session_id: "s1", ...day1 },
      { seq: 2, ticket: "SCRUM-777", agent: "b", status: "completed", session_id: "s2", ...day9 },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n") + "\n",
    "utf8",
  );
  const { stdout } = runReport(dir, "SCRUM-777", "--no-reconcile");
  assert.match(stdout, /Wall clock \(latest session, 1 of 2 runs; 2 sessions in this log\): 300\.0s/);
});

// ---------------------------------------------------------------------------------------------
// Run mode — declared by the caller, never inferred
// ---------------------------------------------------------------------------------------------

const withPrompt = (dir, prompt, overrides = {}) => {
  const payload = completedPayload(dir, overrides);
  payload.tool_input.prompt = prompt;
  return payload;
};

test("a declared run_mode is recorded, and the prompt size with it", () => {
  const dir = project();
  const prompt = "ticket_id: SCRUM-777\nrun_mode: revision\nreview_findings: [DESIGN-C1] fix the oracle";
  fire(dir, "--post", withPrompt(dir, prompt));

  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.run_mode, "revision");
  assert.equal(row.prompt_chars, prompt.length);
});

test("a prompt with no run_mode records undeclared, never first_run", () => {
  const dir = project();
  fire(dir, "--post", completedPayload(dir));
  assert.equal(records(dir, "SCRUM-777")[0].run_mode, "undeclared");
});

test("a run_mode naming something unknown is flagged rather than dropped", () => {
  const dir = project();
  fire(dir, "--post", withPrompt(dir, "ticket_id: SCRUM-777\nrun_mode: turbo_rewrite"));
  assert.equal(records(dir, "SCRUM-777")[0].run_mode, "unrecognised");
});

test("run_mode is read at launch, so an interrupted run still carries the mode it started in", () => {
  const dir = project();
  const prompt = "ticket_id: SCRUM-777\nrun_mode: re_review\nprevious_findings: |\n  [UI-M2] still open";
  fire(dir, "--pre", withPrompt(dir, prompt, { hook_event_name: "PreToolUse" }));
  fire(dir, "--failed", {
    ...withPrompt(dir, prompt),
    hook_event_name: "PostToolUseFailure",
    tool_response: undefined,
    is_interrupt: true,
    duration_ms: 8_000,
  });

  const row = records(dir, "SCRUM-777")[0];
  assert.equal(row.status, "interrupted");
  assert.equal(row.run_mode, "re_review");
  assert.equal(row.prompt_chars, prompt.length);
});

test("prose mentioning a mode does not set the field", () => {
  const dir = project();
  fire(
    dir,
    "--post",
    withPrompt(dir, "ticket_id: SCRUM-777\nreview_findings: the agent resolved run_mode: revision last time"),
  );
  assert.equal(records(dir, "SCRUM-777")[0].run_mode, "undeclared");
});

test("an indented run_mode still counts — it is a parameter, not a heading", () => {
  const dir = project();
  fire(dir, "--post", withPrompt(dir, "ticket_id: SCRUM-777\nparameters:\n  run_mode: regenerate\n"));
  assert.equal(records(dir, "SCRUM-777")[0].run_mode, "regenerate");
});

test("the report prints the mode and the per-run bill, and --json names the scope of every total", () => {
  const dir = project();
  transcript(dir);
  fire(dir, "--post", withPrompt(dir, "ticket_id: SCRUM-777\nrun_mode: first_run"));

  const table = runReport(dir, "SCRUM-777");
  assert.equal(table.status, 0, table.stderr);
  assert.match(table.stdout, /\| Mode \|/);
  assert.match(table.stdout, /\| first_run \|/);
  assert.match(table.stdout, /Tokens and Cost are the run's bill/);
  assert.ok(!table.stdout.includes("End context"), "the final-turn column is gone from the table");

  const summary = JSON.parse(runReport(dir, "SCRUM-777", "--json").stdout);
  assert.equal(summary.totals_scope, "billed_sum_over_api_calls");
  assert.equal(summary.records.length, 1);
  assert.equal(summary.records[0].run_mode, "first_run");
  assert.equal(summary.records[0].billed.total, DEFAULT_TOTAL);
  assert.equal(summary.records[0].end_context.total, 63_563, "still there for whoever wants it, never priced as the run");
  assert.equal(summary.records[0].tool_uses, 26);
});

test("the report reads a log written before the transcript measure, and does not price its final turn as the run", () => {
  const dir = project();
  // Exactly the shape the 13 real SCRUM-132 records carry: `tokens`, no `end_context`, no `run_mode`,
  // no `session_id` to find a transcript by.
  mkdirSync(join(dir, ".workflow", "metrics"), { recursive: true });
  writeFileSync(
    join(dir, ".workflow", "metrics", "SCRUM-132.jsonl"),
    `${JSON.stringify({
      seq: 1,
      ticket: "SCRUM-132",
      agent: "qa-scenario-classifier",
      status: "completed",
      model: "claude-sonnet-5",
      started_at: "2026-08-09T12:16:49.481Z",
      finished_at: "2026-08-09T12:20:16.981Z",
      duration_ms: 207_500,
      tokens: { total: 76_217, input: 2, output: 957, cache_read: 75_089, cache_creation: 169 },
      tool_uses: 13,
    })}\n`,
    "utf8",
  );

  const { status, stdout } = runReport(dir, "SCRUM-132");
  assert.equal(status, 0, stdout);
  assert.match(stdout, /\| — \| completed \| claude-sonnet-5 \| — \| 13 \| 207\.5s \| — \| — \|/, "duration and tools render; tokens and cost do not");
  assert.match(stdout, /1 row\(s\) carry only the final turn's context/);
  assert.ok(!/\$\d/.test(stdout), "the final turn is never priced into the Cost column");
  const summary = JSON.parse(runReport(dir, "SCRUM-132", "--json").stdout);
  assert.equal(summary.legacy_final_turn_only, 1);
  assert.equal(summary.records[0].end_context.total, 76_217);
  assert.equal(summary.records[0].billed, null);
});
