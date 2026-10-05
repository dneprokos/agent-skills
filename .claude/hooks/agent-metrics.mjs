#!/usr/bin/env node
/**
 * The subagent lifecycle hook — one script, three modes.
 *
 * An agent cannot measure itself, and the caller only ever sees the agent's text. This hook records
 * every subagent run from the outside, and the report reads each run's real cost off the transcript
 * the harness writes for it.
 *
 *   --pre     PreToolUse         records that a run was launched, with a measured start time
 *   --post    PostToolUse        records the completion — or, for a background agent, the launch —
 *                                and sums the run's bill from its transcript when that is on disk
 *   --failed  PostToolUseFailure records that it was interrupted or failed, and clears the same
 *
 * WHY THREE. A `PostToolUse` hook cannot fire for a run that never completed, so on its own it
 * cannot distinguish "no agent ran" from "an agent ran and the session was killed underneath it".
 * The pre-record is what survives that: an unreconciled launch is an interrupted run, and the report
 * prints it as one. `--failed` is the common case of the same thing — an interrupt is an event, not
 * an absence, and it arrives with a real duration attached.
 *
 * Records are correlated by `tool_use_id`, which every one of the three payloads carries and which
 * is unique per tool call. Two streams launched in parallel therefore never collide, whether or not
 * they happen to be different agents.
 *
 * WHERE THE COST COMES FROM. Not from the tool response. `result.usage` describes the subagent's
 * *final* message — `usage.iterations` is a single-element array identical to it — so a record
 * showing 115 tool calls against 1,214 output tokens is the last turn of an expensive run, not a cheap
 * one. That block is still kept, as `end_context`, because it is what the harness hands over directly.
 * The run's actual bill is summed from the agent's own transcript under `~/.claude/projects/`, one
 * `usage` per API call with the cache split and the model on each — see `lib/transcript-usage.mjs`.
 * For an agent that ran to completion inside the tool call, this hook sums it right here; for a
 * background agent the transcript is still being written when the post hook fires, so the row is
 * written as `status: background` with the `agentId` the launch response carries, and
 * `metrics-report.mjs` finishes it from the transcript later.
 *
 * WHAT IS STILL NOT CAPTURED, and the report says so rather than guessing:
 *   - the tokens an interrupted agent spent. The transcript stops where the agent did, and a partial
 *     sum presented as the run's cost would be a different number wearing its clothes. An interrupted
 *     row carries its duration and nothing else.
 *   - a kill in the window between the launch and this hook writing its pre-record. Milliseconds
 *     wide, and unrecoverable by construction: a hook cannot record an event that precedes it.
 *   - a run whose session directory is no longer on this machine. The cost existed; it is not here.
 *
 * NEVER FAILS A TOOL CALL. Every path exits 0. But silence is no longer one of the paths: every
 * early return writes a line to `.workflow/metrics/_diagnostics.jsonl` saying which one it was. The
 * previous version returned silently on four different conditions and wrapped everything in an empty
 * `catch {}`, which is why nobody noticed it had never written a single record.
 *
 * The tool-name guard was the fifth such condition and outlived the other four. It compared against
 * the literal `"Task"` and returned without a diagnostic, on the reasoning that the matcher upstream
 * had already filtered — so when the harness renamed the tool to `Agent`, the matcher stopped matching
 * and the guard stopped accepting, and the log stayed empty with nothing anywhere saying why. Both
 * names are accepted now, from a list the tests check the matcher against, and an unrecognised tool
 * carrying a subagent-shaped payload writes a diagnostic instead of vanishing.
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveProjectDir,
  metricsDir,
  metricsFile,
  pendingDir,
  pendingFile,
  diagnosticsFile,
} from "./lib/paths.mjs";
import { isSubagentTool, looksLikeSubagentLaunch } from "./lib/subagent-tools.mjs";
import { parseRunMode, parseStep, promptChars } from "./lib/run-mode.mjs";
import { billedForRun } from "./lib/transcript-usage.mjs";
import { priceBilled, formatUsd } from "./lib/pricing.mjs";
import { LIVE_STATUSES } from "../../scripts/workflow-state.mjs";

const TICKET_RE = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const UNASSIGNED = "unassigned";
const DIAGNOSTICS_CAP = 200;
const DIAGNOSTICS_KEEP = 100;

function readStdin() {
  try {
    return readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

/**
 * Say why nothing was recorded. Its own try/catch, and capped — a hook must not grow a log without
 * limit, and a diagnostics write that failed must not become the reason a tool call fails.
 */
function writeDiag(projectDir, entry) {
  try {
    const file = diagnosticsFile(projectDir);
    mkdirSync(path.dirname(file), { recursive: true });
    let lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter((l) => l.trim()) : [];
    lines.push(JSON.stringify({ ts: new Date().toISOString(), ...entry }));
    if (lines.length > DIAGNOSTICS_CAP) lines = lines.slice(-DIAGNOSTICS_KEEP);
    writeFileSync(file, `${lines.join("\n")}\n`, "utf8");
  } catch {
    /* a diagnostic that cannot be written is not worth failing a run over */
  }
}

function bail(projectDir, reason, payload, extra = {}) {
  writeDiag(projectDir, {
    reason,
    mode: extra.mode ?? null,
    tool_name: payload?.tool_name ?? null,
    tool_use_id: payload?.tool_use_id ?? null,
    payload_keys: payload && typeof payload === "object" ? Object.keys(payload) : [],
    result_keys:
      payload?.tool_response && typeof payload.tool_response === "object"
        ? Object.keys(payload.tool_response)
        : [],
    ...extra,
  });
}

/** The harness may hand the result back as the object, as `{ toolUseResult }`, or as raw content. */
function resolveResult(payload) {
  const candidates = [payload?.tool_response, payload?.toolUseResult, payload?.tool_result];
  for (const c of candidates) {
    if (c && typeof c === "object" && !Array.isArray(c) && ("totalTokens" in c || "usage" in c)) return c;
  }
  return null;
}

/**
 * A response object under any of the same keys, cost or no cost. `resolveResult` deliberately accepts
 * only a *costed* result; this is how the post hook can still tell "the harness sent nothing" from
 * "the harness sent a launch acknowledgement", which are different events.
 */
function anyResponse(payload) {
  for (const c of [payload?.tool_response, payload?.toolUseResult, payload?.tool_result]) {
    if (c && typeof c === "object" && !Array.isArray(c)) return c;
  }
  return null;
}

/**
 * A background launch, not a finished run.
 *
 * An agent started in the background returns from the tool call immediately, so `PostToolUse` fires
 * on the *launch* and the response carries `isAsync`, an `agentId`, a `resolvedModel`, an `outputFile`
 * and no cost at all — the agent is still running. The real completion arrives later as a task
 * notification, which is not a tool call and fires no hook.
 *
 * This cost three whole runs on SCRUM-132 and then every run of SCRUM-115, in two stages. First the
 * bail consumed the launch record, so the run left the log entirely. Then the launch record was kept
 * but the response was thrown away because it carried no `usage` — and the `agentId` on it was the one
 * thing that would have let the report find the transcript and price the run. The launch is recorded
 * now as a row of its own, carrying that id, and the report completes it.
 */
function isAsyncLaunch(response) {
  return Boolean(response && response.isAsync === true);
}

/**
 * Fallback: the transcript has it. Only the entry for *this* tool call, though — taking the last
 * `totalTokens` in the file would file the previous agent's cost under this agent's name, because at
 * PostToolUse time the current result has not necessarily been flushed yet.
 */
function resultFromTranscript(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId || !existsSync(transcriptPath)) return null;
  for (const line of readFileSync(transcriptPath, "utf8").split("\n")) {
    if (!line.includes("totalTokens") || !line.includes(toolUseId)) continue;
    try {
      const entry = JSON.parse(line);
      const r = entry?.toolUseResult;
      const id =
        entry?.tool_use_id ??
        entry?.toolUseID ??
        entry?.message?.content?.find?.((c) => c?.tool_use_id)?.tool_use_id;
      if (r && typeof r === "object" && "totalTokens" in r && (!id || id === toolUseId)) return r;
    } catch {
      /* partial write, ignore */
    }
  }
  return null;
}

/**
 * The hook is not told which ticket is in flight. The orchestrator names it in every prompt it
 * sends, so the prompt is the primary source; an active state file is the fallback.
 *
 * The state-file regex is anchored, because an unanchored one also matches `review_status:` and any
 * prose inside a `last_findings` block — and those blocks run to thousands of characters. The status
 * list comes from the schema rather than being retyped here, so a state sitting on `escalated` or
 * `blocked` is still recognised as a live run.
 */
function resolveTicket(payload, projectDir) {
  const fromPrompt = String(payload?.tool_input?.prompt ?? "").match(TICKET_RE);
  if (fromPrompt) return { ticket: fromPrompt[1], source: "prompt" };

  const fromDesc = String(payload?.tool_input?.description ?? "").match(TICKET_RE);
  if (fromDesc) return { ticket: fromDesc[1], source: "description" };

  try {
    const workflowDir = path.join(projectDir, ".workflow");
    const live = new RegExp(`^status:\\s*(${LIVE_STATUSES.join("|")})\\b`, "m");
    const states = readdirSync(workflowDir)
      .filter((f) => f.endsWith(".yaml"))
      .map((f) => ({ f, m: readFileSync(path.join(workflowDir, f), "utf8") }))
      .filter((s) => live.test(s.m));
    if (states.length === 1) return { ticket: path.basename(states[0].f, ".yaml"), source: "state_file" };
  } catch {
    /* no state yet */
  }
  return { ticket: UNASSIGNED, source: "unresolved" };
}

function countLines(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim()).length;
}

function agentName(payload, result) {
  return result?.agentType ?? payload?.tool_input?.subagent_type ?? "unknown";
}

/**
 * The prompt the delegation was launched with.
 *
 * `tool_input.prompt` is what the caller sent and is present on all three payloads; the result object
 * echoes it back as `result.prompt`, which is the fallback for a post that arrives without its input.
 * Either one is the same text, so whichever is present answers the mode, the step and the size.
 */
function launchPrompt(payload, result = null) {
  const fromInput = payload?.tool_input?.prompt;
  if (typeof fromInput === "string" && fromInput) return fromInput;
  const fromResult = result?.prompt;
  return typeof fromResult === "string" ? fromResult : "";
}

/** The launch record for one tool call, or null when there is none (an unhooked or lost pre). */
function takePending(projectDir, toolUseId) {
  if (!toolUseId) return null;
  const file = pendingFile(projectDir, toolUseId);
  if (!existsSync(file)) return null;
  try {
    const pending = JSON.parse(readFileSync(file, "utf8"));
    unlinkSync(file);
    return pending;
  } catch {
    try {
      unlinkSync(file);
    } catch {
      /* it will be reconciled by the report instead */
    }
    return null;
  }
}

function appendRecord(projectDir, ticket, record) {
  const file = metricsFile(projectDir, ticket);
  mkdirSync(metricsDir(projectDir), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ seq: countLines(file) + 1, ...record })}\n`, "utf8");
  return file;
}

function emit(line) {
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: line } }),
  );
}

/**
 * The one line the orchestrator reads. Same shape from every mode and from the report's `--last`, so
 * the label that lands in `history` is the label the log carries. `tokens=` and `cost=` are the run's
 * bill from the transcript, or `unavailable` — never the final-turn figure under a friendlier name.
 */
export function metricsLine(record, ticket) {
  const billed = record.billed ?? null;
  const price = billed ? priceBilled(billed, record.started_at) : null;
  const dur = typeof record.duration_ms === "number" ? `${(record.duration_ms / 1000).toFixed(1)}s` : "unavailable";
  return (
    `AGENT_RUN_METRICS: seq=${record.seq} ticket=${ticket} agent=${record.agent} ` +
    `step=${record.step ?? "—"} mode=${record.run_mode} status=${record.status} ` +
    `model=${billed?.model ?? record.model ?? "unavailable"} duration=${dur} ` +
    `tokens=${billed ? billed.total : "unavailable"} ` +
    `cost=${price?.usd != null ? formatUsd(price.usd) : "unavailable"} ` +
    `api_calls=${billed ? billed.api_calls : "unavailable"} ` +
    `tool_uses=${record.tool_uses ?? "unavailable"} ` +
    `prompt_chars=${record.prompt_chars ?? "unavailable"} log=.workflow/metrics/${ticket}.jsonl`
  );
}

// ---------------------------------------------------------------------------------------------
// Modes
// ---------------------------------------------------------------------------------------------

function runPre(payload, projectDir) {
  const { ticket, source } = resolveTicket(payload, projectDir);
  const toolUseId = payload?.tool_use_id;
  if (!toolUseId) {
    bail(projectDir, "no_tool_use_id", payload, { mode: "pre" });
    return;
  }
  const prompt = launchPrompt(payload);
  mkdirSync(pendingDir(projectDir), { recursive: true });
  writeFileSync(
    pendingFile(projectDir, toolUseId),
    JSON.stringify({
      tool_use_id: toolUseId,
      ticket,
      ticket_source: source,
      agent: agentName(payload, null),
      description: payload?.tool_input?.description ?? "",
      // Read at launch, so an interrupted run is still recorded with the mode and step it was launched
      // in — which is the run you most want to know those of.
      step: parseStep(prompt),
      run_mode: parseRunMode(prompt),
      prompt_chars: promptChars(prompt),
      started_at: new Date().toISOString(),
      session_id: payload?.session_id ?? null,
    }),
    "utf8",
  );
  // No stdout: a launch is not news, and PreToolUse output would land ahead of the agent's own.
}

/** The fields every row shares, taken from the launch record when there is one. */
function head(payload, projectDir, pending, result) {
  const { ticket, source } = pending
    ? { ticket: pending.ticket, source: pending.ticket_source }
    : resolveTicket(payload, projectDir);
  const prompt = pending ? null : launchPrompt(payload, result);
  return {
    ticket,
    ticket_source: source,
    tool_use_id: payload?.tool_use_id ?? null,
    agent: pending?.agent ?? agentName(payload, result),
    description: payload?.tool_input?.description ?? pending?.description ?? "",
    step: pending?.step ?? parseStep(prompt),
    run_mode: pending?.run_mode ?? parseRunMode(prompt),
    prompt_chars: pending?.prompt_chars ?? promptChars(prompt),
  };
}

/**
 * A background agent has just been launched. Nothing has been spent yet, but the response names the
 * agent, and that name is the key to its transcript — so the row is written now, marked `background`,
 * and the report fills in the bill once the agent has stopped.
 */
function runBackgroundLaunch(payload, response, projectDir) {
  const toolUseId = payload?.tool_use_id;
  const pending = takePending(projectDir, toolUseId);
  const startedAt = pending?.started_at ?? new Date().toISOString();
  const record = {
    ...head(payload, projectDir, pending, response),
    status: "background",
    model: response.resolvedModel ?? null,
    agent_id: response.agentId ?? null,
    output_file: response.outputFile ?? null,
    started_at: startedAt,
    started_at_measured: Boolean(pending?.started_at),
    finished_at: null,
    duration_ms: null,
    end_context: null,
    // Filled by `metrics-report.mjs` from the transcript once the agent has stopped. `null` here is
    // "not yet", which the report can tell from "never" by the agent id beside it.
    billed: null,
    tool_uses: null,
    session_id: payload?.session_id ?? null,
  };
  appendRecord(projectDir, record.ticket, record);
  if (record.ticket === UNASSIGNED) {
    bail(projectDir, "ticket_unresolved", payload, { mode: "post", agent: record.agent });
  }
  record.seq = countLines(metricsFile(projectDir, record.ticket));
  emit(metricsLine(record, record.ticket));
}

function runPost(payload, projectDir) {
  const toolUseId = payload?.tool_use_id;
  const result = resolveResult(payload) ?? resultFromTranscript(payload?.transcript_path, toolUseId);

  // The launch record is consumed only once there is something to write in its place. It used to be
  // taken first, which meant every bail below destroyed the one artefact that would have let the
  // report say a run had happened — the launch vanished along with the cost.
  if (!result) {
    const response = anyResponse(payload);
    if (isAsyncLaunch(response)) {
      runBackgroundLaunch(payload, response, projectDir);
      return;
    }
    bail(projectDir, "no_result", payload, {
      mode: "post",
      had_pending: existsSync(pendingFile(projectDir, toolUseId ?? "")),
      response_status: response?.status ?? null,
    });
    return;
  }

  const pending = takePending(projectDir, toolUseId);
  const usage = result.usage ?? {};
  const durationMs = result.totalDurationMs ?? payload?.duration_ms ?? 0;
  const finishedAt = new Date();

  // `usage.iterations` has been a single-element array in every payload observed, which is the
  // evidence that `usage` describes one message rather than the run. Recording its length means a
  // harness that starts returning the whole run shows up as a number greater than 1 instead of
  // silently changing what the block below means.
  const usageMessages = Array.isArray(usage.iterations) ? usage.iterations.length : null;

  // Measured at launch when the pre-hook ran; derived from the duration only as a fallback. The
  // derived form silently excludes queueing and the caller's own turn, so it understates elapsed time.
  const startedAt = pending?.started_at ?? new Date(finishedAt.getTime() - durationMs).toISOString();

  // The agent has stopped, so its transcript is complete: sum the bill now rather than at report time.
  const sessionId = payload?.session_id ?? null;
  const billed = billedForRun({ sessionId, agentId: result.agentId ?? null, toolUseId });

  const record = {
    ...head(payload, projectDir, pending, result),
    status: result.status ?? "unknown",
    model: result.resolvedModel ?? billed?.model ?? null,
    agent_id: result.agentId ?? billed?.agent_id ?? null,
    started_at: startedAt,
    started_at_measured: Boolean(pending?.started_at),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    // What the harness handed over: the final message's figures, kept under the name that says so.
    end_context: {
      total: result.totalTokens ?? 0,
      input: usage.input_tokens ?? 0,
      output: usage.output_tokens ?? 0,
      cache_read: usage.cache_read_input_tokens ?? 0,
      cache_creation: usage.cache_creation_input_tokens ?? 0,
      scope: "final_turn",
      messages: usageMessages,
    },
    // The run's bill, summed from the transcript. `null` when the transcript is not on this machine,
    // and the report says so — never a figure derived from `end_context` in its place.
    billed,
    tool_uses: result.totalToolUseCount ?? billed?.tool_uses ?? 0,
    tool_stats: result.toolStats ?? {},
    session_id: sessionId,
  };

  appendRecord(projectDir, record.ticket, record);
  if (record.ticket === UNASSIGNED) {
    bail(projectDir, "ticket_unresolved", payload, { mode: "post", agent: record.agent });
  }
  record.seq = countLines(metricsFile(projectDir, record.ticket));
  emit(metricsLine(record, record.ticket));
}

function runFailed(payload, projectDir) {
  const toolUseId = payload?.tool_use_id;
  const pending = takePending(projectDir, toolUseId);
  const durationMs = payload?.duration_ms ?? null;
  const finishedAt = new Date();
  const status = payload?.is_interrupt ? "interrupted" : payload?.is_timeout ? "timed_out" : "failed";

  const record = {
    ...head(payload, projectDir, pending, null),
    status,
    model: null,
    started_at:
      pending?.started_at ??
      (durationMs === null ? null : new Date(finishedAt.getTime() - durationMs).toISOString()),
    started_at_measured: Boolean(pending?.started_at),
    finished_at: finishedAt.toISOString(),
    duration_ms: durationMs,
    // An agent that never stopped has no bill on record. Recording zero would read as free.
    end_context: null,
    billed: null,
    tool_uses: null,
    error: payload?.error ?? null,
    error_type: payload?.error_type ?? null,
    session_id: payload?.session_id ?? null,
  };

  appendRecord(projectDir, record.ticket, record);
  record.seq = countLines(metricsFile(projectDir, record.ticket));
  emit(metricsLine(record, record.ticket));
}

function main() {
  const mode = process.argv.includes("--pre")
    ? "pre"
    : process.argv.includes("--failed")
      ? "failed"
      : "post";

  const raw = readStdin();
  if (!raw.trim()) {
    bail(resolveProjectDir(null), "no_stdin", null, { mode });
    return;
  }

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    bail(resolveProjectDir(null), "bad_json", null, { mode, bytes: raw.length });
    return;
  }

  const projectDir = resolveProjectDir(payload);
  if (!isSubagentTool(payload?.tool_name)) {
    // A broad matcher legitimately delivers other tools, and those are not news. A payload shaped
    // like a subagent launch under a name this hook does not know is news: it means the wiring has
    // rotted underneath us, which is the failure this guard used to cause rather than report.
    if (looksLikeSubagentLaunch(payload)) {
      bail(projectDir, "unrecognised_subagent_tool", payload, { mode });
    }
    return;
  }

  if (mode === "pre") runPre(payload, projectDir);
  else if (mode === "failed") runFailed(payload, projectDir);
  else runPost(payload, projectDir);
}

// Importable for `metricsLine`; runs as the hook only when invoked directly.
const invokedDirectly =
  Boolean(process.argv[1]) && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  try {
    main();
  } catch (err) {
    // Metrics are never worth failing a run over — but a throw that leaves no trace is how this
    // script spent its entire life believing it worked.
    bail(resolveProjectDir(null), "threw", null, {
      message: String(err?.message ?? err),
      stack: String(err?.stack ?? "").split("\n").slice(0, 3).join(" | "),
    });
  }
  process.exit(0);
}
