#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const successfulCreates = [];
let stderr = "";
let eventCount = 0;
let stdoutBytes = 0;
let settledCount = 0;
let finished = false;
let failure;
let resolveCompletion;
let rejectCompletion;

// Goal-seeded, not scripted: the model must discover WorkflowCreate /
// WorkflowTransition from their descriptions and author its own definition.
const SCENARIOS = {
  retry: {
    prompt: [
      "Run a live conformance exercise for the durable workflow tools installed in this session.",
      "Goal: model a bounded task as one work phase that repeats itself when it surfaces a follow-up case, up to three runs total.",
      "On the first run, surface one follow-up case and repeat the phase; on the second run, complete the work and finish.",
      "The work itself must be embedded in the workflow states — do not create it as separate tasks.",
      "Use only the workflow tools this session provides; do not create standalone tasks, loops, or monitors.",
      "When a workflow tool reports terminal completion, reply exactly LIVE_WORKFLOW_DONE and nothing else.",
    ].join("\n"),
    validateDefinition(args) {
      const definition = parseDefinition(args);
      const initial = definition.states?.[definition.initialState];
      if (!initial) throw new Error(`initial state "${definition.initialState}" is not defined`);
      if (initial.terminal) throw new Error("initial state must be non-terminal");
      if (!initial.task?.subject) throw new Error("initial state must embed task work");
      if (!Object.values(initial.on ?? {}).includes(definition.initialState)) {
        throw new Error("initial state must declare a self-loop outcome");
      }
      if (!Object.values(definition.states).some((state) => state?.terminal === "completed")) {
        throw new Error("workflow must declare a completed terminal state");
      }
      return definition;
    },
  },
  phases: {
    prompt: [
      "Run a live conformance exercise for the durable workflow tools installed in this session.",
      "Goal: model a multi-phase research exercise with at least three phases — investigate, validate, and report.",
      "The work for each phase is embedded in that phase's state; do not create it as separate tasks.",
      "After each phase, declare an outcome that advances to the next phase, and pass what that phase found as concise evidence in each transition.",
      "Use only the workflow tools this session provides; do not create standalone tasks, loops, or monitors.",
      "When a workflow tool reports terminal completion, reply exactly LIVE_WORKFLOW_DONE and nothing else.",
    ].join("\n"),
    validateDefinition(args) {
      const definition = parseDefinition(args);
      const stateIds = Object.keys(definition.states ?? {});
      if (stateIds.length < 3) throw new Error(`expected at least three phases, got ${stateIds.length}`);
      const initial = definition.states?.[definition.initialState];
      if (!initial) throw new Error(`initial state "${definition.initialState}" is not defined`);
      if (initial.terminal) throw new Error("initial state must be non-terminal");
      if (!initial.task?.subject) throw new Error("initial phase must embed task work");
      const declared = Object.keys(initial.on ?? {});
      if (declared.length === 0) throw new Error("initial phase must declare at least one outcome");
      if (!Object.values(definition.states).some((state) => state?.terminal === "completed")) {
        throw new Error("workflow must declare a completed terminal state");
      }
      return definition;
    },
  },
};

const scenarioName = process.env.PI_LOOP_LIVE_SCENARIO ?? "retry";
const scenario = SCENARIOS[scenarioName];
if (!scenario) {
  console.error(`unknown scenario "${scenarioName}"; expected ${Object.keys(SCENARIOS).join(" or ")}`);
  process.exit(1);
}

function parseDefinition(args) {
  if (!args || typeof args.definition !== "string") throw new Error("WorkflowCreate was not called with a JSON definition string");
  try {
    const definition = JSON.parse(args.definition);
    if (definition?.version !== 1) throw new Error("workflow definition must be version 1");
    return definition;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("workflow definition")) throw error;
    throw new Error("WorkflowCreate definition is not valid JSON");
  }
}

function validateDefinition(args) {
  return scenario.validateDefinition(args);
}

function validate() {
  const { loops, tasks } = readState();
  const taskClaims = toolCalls.filter((call) => call.name === "TaskClaim");
  const workflowClaims = toolCalls.filter((call) => call.name === "WorkflowClaim");
  const transitions = toolCalls.filter((call) => call.name === "WorkflowTransition");
  const forbidden = toolCalls.filter((call) =>
    ["TaskUpdate", "TaskCreate", "LoopCreate", "LoopDelete", "LoopUpdate"].includes(call.name));

  if (successfulCreates.length !== 1) throw new Error(`expected one accepted WorkflowCreate call, got ${successfulCreates.length}`);
  validateDefinition(successfulCreates[0].args);
  if (taskClaims.length !== 0) throw new Error(`expected zero TaskClaim calls, got ${taskClaims.length}`);
  if (workflowClaims.length === 0) throw new Error("expected WorkflowClaim after entering unowned task work");
  if (transitions.length < 2) throw new Error(`expected at least two WorkflowTransition calls, got ${transitions.length}`);
  if (transitions.some((call) => call.args?.claimId !== undefined)) throw new Error("workflow transitions must not carry claimId");
  if (scenarioName === "phases" && transitions.some((call) => !call.args?.evidence)) {
    throw new Error("every phase transition must carry evidence");
  }
  if (forbidden.length > 0) throw new Error(`agent called forbidden tools: ${forbidden.map((call) => call.name).join(", ")}`);
  if (!finished) throw new Error("no WorkflowTransition reported terminal completion");
  if (loops.length !== 0) throw new Error(`expected terminal workflow deletion, found ${loops.length} loop(s)`);
  if (tasks.length !== 0) throw new Error(`expected zero standalone tasks, found ${tasks.length}`);
  return { loops, tasks };
}

function send(child, command) {
  child.stdin.write(`${JSON.stringify(command)}\n`);
}

function readState() {
  const loopPath = join(fixtureDir, ".pi", "loops", "loops.json");
  const taskPath = join(fixtureDir, ".pi", "tasks", "tasks.json");
  // Terminal completion deletes the last loop and standalone tasks are never
  // created, so both files may legitimately not exist.
  const loops = existsSync(loopPath) ? JSON.parse(readFileSync(loopPath, "utf8")).loops : [];
  const tasks = existsSync(taskPath) ? JSON.parse(readFileSync(taskPath, "utf8")).tasks : [];
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
    if (event.type === "tool_execution_end" && event.toolName === "WorkflowCreate") {
      const text = event.result?.content?.map((item) => item.text ?? "").join("\n") ?? "";
      const rejected = Boolean(event.isError || text.includes("Workflow definition rejected"));
      if (!rejected) {
        const start = [...toolCalls].reverse().find((call) => call.name === "WorkflowCreate" && !call.recorded);
        if (start) {
          start.recorded = true;
          successfulCreates.push(start);
        }
      }
    }
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
  send(child, { id: "workflow-conformance", type: "prompt", message: scenario.prompt });
  const state = await outcome;
  writeArtifact("passed", state);
  console.log(`PASS: goal-seeded workflow completed with ${toolCalls.length} tool calls`);
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
