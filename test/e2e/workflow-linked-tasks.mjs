#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import process from "node:process";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const model = process.env.PI_LOOP_LIVE_MODEL;
if (!model) {
  console.log("SKIP: set PI_LOOP_LIVE_MODEL=<provider/model[:thinking]> to run the live workflow harness");
  process.exit(0);
}

const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "180000", 10);
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(projectDir, ".artifacts", "live-workflow"));
const fixtureDir = mkdtempSync(join(tmpdir(), "pi-loop-live-workflow-"));
const extensionPath = join(projectDir, "dist", "index.js");
const traceEvents = [];
const toolCalls = [];
let stderr = "";
let eventCount = 0;
let stdoutBytes = 0;
let settledCount = 0;
let finished = false;
let failure;
let resolveCompletion;
let rejectCompletion;

const workflowDefinition = {
  version: 1,
  initialState: "work",
  states: {
    work: {
      prompt: "On attempt 1 transition with retry; on attempt 2 transition with done.",
      task: {
        subject: "Live workflow attempt",
        description: "Embedded workflow work settled only through WorkflowTransition.",
      },
      on: { retry: "work", done: "done" },
      maxAttempts: 3,
    },
    done: { prompt: "The live workflow is complete.", terminal: "completed" },
  },
};

const prompt = [
  "Run this live pi-loop workflow conformance scenario.",
  "Call WorkflowCreate exactly once with goal='Live embedded-execution workflow' and this exact JSON definition:",
  JSON.stringify(workflowDefinition),
  "Then follow every workflow wake until terminal completion.",
  "For each wake: read the shown Attempt and Active workflow work line, then call WorkflowTransition with id, one outcome, and concise evidence. Never call TaskClaim, TaskUpdate, LoopUpdate, or LoopDelete.",
  "On attempt 1 choose outcome retry. On attempt 2 choose outcome done.",
  "Do not create unrelated tasks or loops. Reply LIVE_WORKFLOW_DONE only after WorkflowTransition reports terminal completion.",
].join("\n");

function send(child, command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function readState() {
  const loopPath = join(fixtureDir, ".pi", "loops", "loops.json");
  const taskPath = join(fixtureDir, ".pi", "tasks", "tasks.json");
  try {
    const loops = JSON.parse(readFileSync(loopPath, "utf8")).loops;
    const tasks = JSON.parse(readFileSync(taskPath, "utf8")).tasks;
    return { loops, tasks };
  } catch (cause) {
    throw new Error("live workflow state is unavailable or invalid", { cause });
  }
}

function validate() {
  const { loops, tasks } = readState();
  const creates = toolCalls.filter((call) => call.name === "WorkflowCreate");
  const claims = toolCalls.filter((call) => call.name === "TaskClaim");
  const transitions = toolCalls.filter((call) => call.name === "WorkflowTransition");
  const taskUpdates = toolCalls.filter((call) => call.name === "TaskUpdate");

  if (creates.length !== 1) throw new Error(`expected one WorkflowCreate call, got ${creates.length}`);
  if (claims.length !== 0) throw new Error(`expected zero TaskClaim calls, got ${claims.length}`);
  if (transitions.length !== 2) throw new Error(`expected two WorkflowTransition calls, got ${transitions.length}`);
  if (transitions[0]?.args?.outcome !== "retry" || transitions[1]?.args?.outcome !== "done") {
    throw new Error(`expected transition outcomes retry,done; got ${transitions.map((call) => call.args?.outcome).join(",")}`);
  }
  if (transitions.some((call) => call.args?.claimId !== undefined)) throw new Error("workflow transitions must not carry claimId");
  if (taskUpdates.length > 0) throw new Error("agent called TaskUpdate during workflow execution");
  if (loops.length !== 0) throw new Error(`expected terminal workflow deletion, found ${loops.length} loop(s)`);
  if (tasks.length !== 0) throw new Error(`expected zero standalone tasks, found ${tasks.length}`);
  return { loops, tasks };
}

function summarizeEvent(event) {
  if (event.type === "message_update" || event.type === "extension_ui_request") return undefined;
  if (event.type === "tool_execution_start") {
    return { type: event.type, toolName: event.toolName, args: event.args };
  }
  if (event.type === "tool_execution_end") {
    const text = event.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
    return { type: event.type, toolName: event.toolName, isError: event.isError, result: text.slice(0, 1000) };
  }
  if (event.type === "message_start" || event.type === "message_end") {
    return { type: event.type, role: event.message?.role, stopReason: event.message?.stopReason };
  }
  if (event.type === "turn_end") return { type: event.type, toolResultCount: event.toolResults?.length ?? 0 };
  if (event.type === "agent_end") {
    return { type: event.type, willRetry: event.willRetry, messageCount: event.messages?.length ?? 0 };
  }
  if (event.type === "agent_start" || event.type === "agent_settled" || event.type === "turn_start") {
    return { type: event.type };
  }
  if (event.type === "response") {
    return { type: event.type, id: event.id, command: event.command, success: event.success, error: event.error };
  }
  if (event.type === "queue_update") {
    return { type: event.type, steeringCount: event.steering?.length ?? 0, followUpCount: event.followUp?.length ?? 0 };
  }
  if (event.type === "extension_error") return { type: event.type, extensionPath: event.extensionPath, event: event.event, error: event.error };
  return undefined;
}

function writeArtifact(status, state) {
  mkdirSync(artifactDir, { recursive: true });
  const report = {
    status,
    model,
    timeoutMs,
    settledCount,
    toolCalls,
    state,
    failure: failure instanceof Error ? failure.message : failure,
    stderr: stderr.slice(-12_000),
    eventCount,
    stdoutBytes,
    events: traceEvents.slice(-500),
  };
  writeFileSync(join(artifactDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
}

const child = spawn("pi", [
  "--mode", "rpc",
  "--no-session",
  "--no-extensions",
  "--no-builtin-tools",
  "--extension", extensionPath,
  "--model", model,
], {
  cwd: fixtureDir,
  env: {
    ...process.env,
    PI_LOOP_SCOPE: "project",
    PI_LOOP_DEBUG: "1",
  },
  stdio: ["pipe", "pipe", "pipe"],
});

child.stderr.on("data", (chunk) => {
  stderr = `${stderr}${chunk}`.slice(-24_000);
});

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
      continue;
    }
    eventCount++;
    const summary = summarizeEvent(event);
    if (summary && traceEvents.length < 2000) traceEvents.push(summary);
    if (event.type === "tool_execution_start") {
      toolCalls.push({ name: event.toolName, args: event.args, toolCallId: event.toolCallId });
    }
    if (event.type === "agent_settled") {
      settledCount++;
      if (finished) {
        try {
          resolveCompletion?.(validate());
        } catch (error) {
          failure = error;
          rejectCompletion?.(error);
        }
      }
    }
    if (event.type === "tool_execution_end" && event.toolName === "WorkflowTransition") {
      const text = event.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
      if (text.includes("completed and deleted")) finished = true;
    }
  }
});

const outcome = new Promise((resolveOutcome, rejectOutcome) => {
  const timeout = setTimeout(() => rejectOutcome(new Error(`live workflow timed out after ${timeoutMs}ms`)), timeoutMs);
  resolveCompletion = (state) => {
    clearTimeout(timeout);
    resolveOutcome(state);
  };
  rejectCompletion = (error) => {
    clearTimeout(timeout);
    rejectOutcome(error);
  };
  child.once("exit", (code, signal) => {
    if (finished) return;
    rejectCompletion(new Error(`pi exited before workflow completion (code=${code}, signal=${signal})`));
  });
});

try {
  await new Promise((resolveWait) => setTimeout(resolveWait, 6500));
  send(child, { id: "workflow-live", type: "prompt", message: prompt });
  const state = await outcome;
  writeArtifact("passed", state);
  console.log(`PASS: live embedded workflow completed with ${toolCalls.length} tool calls`);
  console.log(`Artifact: ${join(artifactDir, "latest.json")}`);
} catch (error) {
  failure = error;
  let state;
  try {
    state = readState();
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
