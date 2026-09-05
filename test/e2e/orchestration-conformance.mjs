#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const model = process.env.PI_LOOP_LIVE_MODEL;
const configuredSubagents = process.env.PI_LOOP_LIVE_SUBAGENTS_EXTENSION;
const defaultSubagents = join(
  process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent"),
  "npm",
  "node_modules",
  "@tintinweb",
  "pi-subagents",
  "src",
  "index.ts",
);
const subagentsExtension = resolve(configuredSubagents ?? defaultSubagents);
if (!model) {
  console.log("SKIP: set PI_LOOP_LIVE_MODEL=<provider/model[:thinking]> to run the live orchestration harness");
  process.exit(0);
}
if (!existsSync(subagentsExtension)) {
  console.log("SKIP: set PI_LOOP_LIVE_SUBAGENTS_EXTENSION to a protocol-v2 pi-subagents extension entrypoint");
  process.exit(0);
}

const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "480000", 10);
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(projectDir, ".artifacts", "live-orchestration"));
const fixtureDir = mkdtempSync(join(tmpdir(), "pi-loop-live-orchestration-"));
const sessionDir = join(fixtureDir, "sessions");
const extensionPath = join(projectDir, "dist", "index.js");
mkdirSync(sessionDir, { recursive: true });
writeFileSync(join(fixtureDir, "README.md"), "# Isolated live orchestration fixture\n");

const toolCalls = [];
const traceEvents = [];
const extensionErrors = [];
const completedWork = new Map();
let stderr = "";
let completionId;
let cancellationId;
let completionDeleted = false;
let cancellationCreated = false;
let cancellationDeleteSent = false;
let cancellationRetained = false;
let cancellationObservedActive = false;
let completionCleanupSent = false;
let cancellationCreateSent = false;
let settledCount = 0;
let eventCount = 0;
let stdoutBytes = 0;
let resolveOutcome;
let rejectOutcome;
let failure;

function send(child, id, message) {
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

function textResult(event) {
  return (event.result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function controllerId(text) {
  return text.match(/Orchestration #(\d+)/)?.[1];
}

function summarizeEvent(event) {
  if (event.type === "message_update" || event.type === "extension_ui_request") return undefined;
  if (event.type === "tool_execution_start") return { type: event.type, toolName: event.toolName, args: event.args };
  if (event.type === "tool_execution_end") {
    return { type: event.type, toolName: event.toolName, isError: event.isError, result: textResult(event).slice(0, 1200) };
  }
  if (["agent_start", "agent_settled", "turn_start"].includes(event.type)) return { type: event.type };
  if (event.type === "agent_end") return { type: event.type, willRetry: event.willRetry };
  if (event.type === "extension_error") return { type: event.type, extensionPath: event.extensionPath, event: event.event, error: event.error };
  return undefined;
}

function readPersistedLoops() {
  const loopDir = join(fixtureDir, ".pi", "loops");
  if (!existsSync(loopDir)) return [];
  return readdirSync(loopDir)
    .filter((name) => name.endsWith(".json"))
    .flatMap((name) => JSON.parse(readFileSync(join(loopDir, name), "utf8")).loops ?? []);
}

function validate() {
  const creates = toolCalls.filter((call) => call.name === "OrchestrationCreate");
  const deletes = toolCalls.filter((call) => call.name === "LoopDelete");
  const forbidden = toolCalls.filter((call) => /^(Task|Workflow|Monitor|Agent)/.test(call.name));
  if (creates.length !== 2) throw new Error(`expected two OrchestrationCreate calls, got ${creates.length}`);
  if (deletes.length !== 2) throw new Error(`expected two LoopDelete calls, got ${deletes.length}`);
  if (forbidden.length > 0) throw new Error(`called forbidden tools: ${forbidden.map((call) => call.name).join(", ")}`);
  if (completedWork.size !== 2) throw new Error(`expected two durable work results, got ${completedWork.size}`);
  for (const [workId, text] of completedWork) {
    if (!/Result:\s*42\b/.test(text)) throw new Error(`work ${workId} did not return 42`);
    if (!/Output:\s*provider-owned/.test(text)) throw new Error(`work ${workId} did not preserve provider-owned completion`);
  }
  if (!cancellationObservedActive) throw new Error("cancellation controller was not observed with one active worker");
  if (!completionDeleted || !cancellationRetained) throw new Error("completed batch must be deleted and cancellation uncertainty retained");
  if (extensionErrors.length > 0) throw new Error(`extension errors: ${extensionErrors.map((item) => item.error).join("; ")}`);
  const loops = readPersistedLoops();
  const retained = loops.find((entry) => entry.id === cancellationId);
  if (loops.length !== 1 || retained?.status !== "paused" || retained.orchestration?.status !== "cancelled") throw new Error("cancelled controller not durably retained and paused");
  const dispatch = retained.orchestration.work[0]?.dispatches[0];
  if (!dispatch?.agentId || dispatch.status !== "uncertain" || dispatch.consumeStatus !== "unavailable") throw new Error("missing non-consumable cancellation identity");
  return { loops };
}

function writeArtifact(status, state) {
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "latest.json"), `${JSON.stringify({
    status,
    model,
    subagentsExtension,
    timeoutMs,
    completionId,
    cancellationId,
    settledCount,
    toolCalls,
    completedWork: Object.fromEntries(completedWork),
    cancellationObservedActive,
    extensionErrors,
    state,
    failure: failure instanceof Error ? failure.message : failure,
    stderr: stderr.slice(-12_000),
    eventCount,
    stdoutBytes,
    events: traceEvents.slice(-500),
  }, null, 2)}\n`);
}

const childEnv = {
  ...process.env,
  PI_LOOP_SCOPE: "session",
  PI_LOOP_DEBUG: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
delete childEnv.PI_LOOP;

const child = spawn("pi", [
  "--mode", "rpc",
  "--session-dir", sessionDir,
  "--name", "pi-loop-live-orchestration",
  "--approve",
  "--no-extensions",
  "--extension", extensionPath,
  "--extension", subagentsExtension,
  "--no-skills",
  "--no-prompt-templates",
  "--no-context-files",
  "--no-builtin-tools",
  "--model", model,
], {
  cwd: fixtureDir,
  env: childEnv,
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-24_000);
});

function maybeAdvance() {
  if (completedWork.size === 2 && !completionCleanupSent) {
    completionCleanupSent = true;
    send(child, "completion-cleanup", `Call LoopDelete for orchestration #${completionId}. Do not call any other tool. Then report cleanup complete.`);
    return;
  }
  if (completionDeleted && !cancellationCreateSent) {
    cancellationCreateSent = true;
    send(child, "cancellation-create", [
      "Call OrchestrationCreate exactly once for goal 'Validate active cancellation'.",
      "Use concurrency 1, maxAttempts 1, maxTurns 5, and one general-purpose work item:",
      "'Run the bash command sleep 30. Only after it exits, return CANCELLATION_WORKER_FINISHED.'",
      "Then stop without deleting or inspecting the controller. Do not call any other tool.",
    ].join("\n"));
    return;
  }
  if (cancellationCreated && !cancellationDeleteSent) {
    cancellationDeleteSent = true;
    setTimeout(() => {
      send(child, "cancellation-delete", `Call LoopList once, then call LoopDelete for orchestration #${cancellationId}. Do not call any other tool. Report cancellation complete.`);
    }, 500);
    return;
  }
  if (cancellationRetained) {
    try {
      resolveOutcome?.(validate());
    } catch (error) {
      rejectOutcome?.(error);
    }
  }
}

let buffer = "";
const decoder = new StringDecoder("utf8");
child.stdout.on("data", (chunk) => {
  stdoutBytes += chunk.length;
  buffer += decoder.write(chunk);
  while (true) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    let line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (!line) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      failure = new Error(`non-JSON RPC output: ${line.slice(0, 200)}`);
      rejectOutcome?.(failure);
      continue;
    }
    eventCount += 1;
    const summary = summarizeEvent(event);
    if (summary && traceEvents.length < 2000) traceEvents.push(summary);
    if (event.type === "extension_error") extensionErrors.push(summary);
    if (event.type === "tool_execution_start") {
      toolCalls.push({ name: event.toolName, args: event.args, toolCallId: event.toolCallId });
    }
    if (event.type === "tool_execution_end") {
      const text = textResult(event);
      if (event.isError) {
        failure = new Error(`${event.toolName} returned an error: ${text.slice(0, 500)}`);
        rejectOutcome?.(failure);
        continue;
      }
      if (event.toolName === "OrchestrationCreate") {
        const id = controllerId(text);
        if (!completionId) completionId = id;
        else if (!cancellationId) {
          cancellationId = id;
          cancellationCreated = true;
        }
      }
      if (event.toolName === "OrchestrationGet" && /Work #(\d+) · complete/.test(text)) {
        const workId = text.match(/Work #(\d+)/)?.[1];
        if (workId) completedWork.set(workId, text);
      }
      if (event.toolName === "LoopList" && cancellationId) {
        const entry = readPersistedLoops().find((item) => item.id === cancellationId);
        cancellationObservedActive = entry?.orchestration?.work.some((item) => item.status === "active") === true;
      }
      if (event.toolName === "LoopDelete") {
        const id = controllerId(text);
        if (id === completionId) completionDeleted = text.includes("cancelled and deleted");
        if (id === cancellationId) cancellationRetained = text.includes("retained and paused") && text.includes("termination is unconfirmed");
      }
    }
    if (event.type === "agent_settled") {
      settledCount += 1;
      maybeAdvance();
    }
  }
});

const outcome = new Promise((resolveResult, rejectResult) => {
  const timer = setTimeout(() => rejectResult(new Error(`live orchestration timed out after ${timeoutMs}ms`)), timeoutMs);
  resolveOutcome = (state) => {
    clearTimeout(timer);
    resolveResult(state);
  };
  rejectOutcome = (error) => {
    clearTimeout(timer);
    rejectResult(error);
  };
  child.once("exit", (code, signal) => {
    if (cancellationRetained) return;
    rejectOutcome(new Error(`pi exited before orchestration completion (code=${code}, signal=${signal})`));
  });
});

try {
  await new Promise((resolveWait) => setTimeout(resolveWait, 6500));
  send(child, "completion-create", [
    "Exercise the live orchestration tools using only OrchestrationCreate, LoopList, OrchestrationGet, and LoopDelete.",
    "Call OrchestrationCreate exactly once for goal 'Validate live worker settlement' with concurrency 2, maxAttempts 1, maxTurns 3, and two general-purpose work items:",
    "1. 'Compute 17 + 25. Return the numeric answer and one short verification sentence.'",
    "2. 'Compute 6 * 7. Return the numeric answer and one short verification sentence.'",
    "Call LoopList once, then stop. When the provider's native completion messages arrive, call OrchestrationGet for the controller and each work item. Verify both results equal 42 and both say Output: provider-owned. Do not delete until another prompt asks you to.",
  ].join("\n"));
  const state = await outcome;
  writeArtifact("passed", state);
  console.log(`PASS: live orchestration preserved provider completion and cancelled with ${toolCalls.length} tool calls`);
  console.log(`Artifact: ${join(artifactDir, "latest.json")}`);
} catch (error) {
  failure = error;
  let state;
  try {
    state = { loops: readPersistedLoops() };
  } catch {}
  writeArtifact("failed", state);
  console.error(`FAIL: ${error instanceof Error ? error.message : error}`);
  console.error(`Artifact: ${join(artifactDir, "latest.json")}`);
  process.exitCode = 1;
} finally {
  child.kill("SIGTERM");
  await new Promise((resolveClose) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolveClose();
    }, 5000);
    child.once("close", () => {
      clearTimeout(timer);
      resolveClose();
    });
  });
  rmSync(fixtureDir, { recursive: true, force: true });
}
