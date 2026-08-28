#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const configuredModels = process.env.PI_LOOP_LIVE_ROUTING_MODELS ?? process.env.PI_LOOP_LIVE_MODEL;
if (!configuredModels) {
  console.log("SKIP: set PI_LOOP_LIVE_ROUTING_MODELS=<model[,model...]> or PI_LOOP_LIVE_MODEL=<model> to run controller-routing evaluation");
  process.exit(0);
}

const models = [...new Set(configuredModels.split(",").map((model) => model.trim()).filter(Boolean))];
const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "180000", 10);
const startupMs = Number.parseInt(process.env.PI_LOOP_LIVE_STARTUP_MS ?? "9000", 10);
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(projectDir, ".artifacts", "live-controller-routing"));
const extensionPath = join(projectDir, "dist", "index.js");
const scenarioDocument = JSON.parse(readFileSync(join(projectDir, "test", "fixtures", "controller-routing-scenarios.json"), "utf8"));
const scenarioFilter = new Set((process.env.PI_LOOP_LIVE_ROUTING_SCENARIOS ?? "").split(",").map((id) => id.trim()).filter(Boolean));
const scenarios = scenarioDocument.scenarios.filter((scenario) => scenarioFilter.size === 0 || scenarioFilter.has(scenario.id));
const CONTROLLER_TOOLS = new Set(["WorkflowCreate", "TaskCreate", "LoopCreate"]);

if (models.length === 0) throw new Error("No routing models were configured");
if (scenarios.length === 0) throw new Error("No controller-routing scenarios matched PI_LOOP_LIVE_ROUTING_SCENARIOS");

function send(child, id, message) {
  child.stdin.write(`${JSON.stringify({ id, type: "prompt", message })}\n`);
}

function textResult(event) {
  return (event.result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

function hasDirectedCycle(definition) {
  const states = definition?.states;
  if (!states || typeof states !== "object") return false;
  const visiting = new Set();
  const visited = new Set();
  function visit(stateId) {
    if (visiting.has(stateId)) return true;
    if (visited.has(stateId) || !states[stateId]) return false;
    visiting.add(stateId);
    for (const target of Object.values(states[stateId].on ?? {})) {
      if (typeof target === "string" && visit(target)) return true;
    }
    visiting.delete(stateId);
    visited.add(stateId);
    return false;
  }
  return Object.keys(states).some(visit);
}

function validateWorkflowArgs(args) {
  if (typeof args?.goal !== "string" || !args.goal.trim() || typeof args.definition !== "string") return false;
  let definition;
  try {
    definition = JSON.parse(args.definition);
  } catch {
    return false;
  }
  const states = definition?.states;
  if (definition?.version !== 1 || typeof definition.initialState !== "string" || !states?.[definition.initialState]) return false;
  const values = Object.values(states);
  if (values.length < 3 || values.some((state) => typeof state?.prompt !== "string" || !state.prompt.trim())) return false;
  const taskCount = values.filter((state) => typeof state?.task?.subject === "string" && typeof state?.task?.description === "string").length;
  const branchCount = values.filter((state) => Object.keys(state?.on ?? {}).length >= 2).length;
  const terminalCount = values.filter((state) => state?.terminal === "completed" || state?.terminal === "paused").length;
  return taskCount >= 2 && branchCount >= 1 && terminalCount >= 1 && hasDirectedCycle(definition);
}

function validateIndependentTasks(calls) {
  if (calls.length === 0) return false;
  const subjects = calls.map((call) => call.args?.subject);
  return calls.every((call) => typeof call.args?.subject === "string" && call.args.subject.trim()
      && typeof call.args?.description === "string" && call.args.description.trim().length >= 20)
    && new Set(subjects).size === calls.length;
}

function validateBoundedCronLoop(args) {
  const trigger = String(args?.trigger ?? "").toLowerCase();
  return args?.maxFires === 12
    && args?.recurring !== false
    && (trigger === "10m" || trigger.includes("*/10"))
    && /health|healthy/.test(String(args?.prompt ?? "").toLowerCase());
}

function validateIdleLoop(args) {
  return String(args?.trigger ?? "").toLowerCase() === "idle"
    && args?.triggerType === "idle"
    && args?.recurring !== false
    && /broken.*link|link.*broken/.test(String(args?.prompt ?? "").toLowerCase());
}

function successfulCall(call, toolResults) {
  const result = toolResults.get(call.toolCallId);
  return Boolean(result && !result.isError && result.tone !== "error");
}

function evaluateScenario(scenario, toolCalls, toolResults, agentRuns, durationMs) {
  const controllerCalls = toolCalls.filter((call) => CONTROLLER_TOOLS.has(call.name));
  const expectedCalls = controllerCalls.filter((call) => call.name === scenario.expectedTool);
  const successfulExpectedCalls = expectedCalls.filter((call) => successfulCall(call, toolResults));
  const unexpectedCalls = controllerCalls.filter((call) => call.name !== scenario.expectedTool);
  const exactRoute = successfulExpectedCalls.length === scenario.expectedCount && unexpectedCalls.length === 0;
  const cleanExecution = exactRoute && successfulCall(expectedCalls.at(-1), toolResults);
  let semanticArguments = false;
  if (scenario.argumentCheck === "workflow-rework") {
    semanticArguments = successfulExpectedCalls.length === 1 && validateWorkflowArgs(successfulExpectedCalls[0]?.args);
  } else if (scenario.argumentCheck === "independent-tasks") {
    semanticArguments = successfulExpectedCalls.length === scenario.expectedCount && validateIndependentTasks(successfulExpectedCalls);
  } else if (scenario.argumentCheck === "bounded-cron-loop") {
    semanticArguments = successfulExpectedCalls.length === 1 && validateBoundedCronLoop(successfulExpectedCalls[0]?.args);
  } else if (scenario.argumentCheck === "idle-loop") {
    semanticArguments = successfulExpectedCalls.length === 1 && validateIdleLoop(successfulExpectedCalls[0]?.args);
  }
  const firstTurn = successfulExpectedCalls.length === scenario.expectedCount
    && controllerCalls.every((call) => call.agentRun === 1);

  const checklist = [
    { id: "route", critical: true, passed: exactRoute },
    { id: "execution", critical: true, passed: cleanExecution },
    { id: "arguments", critical: false, passed: semanticArguments },
    { id: "single-turn", critical: false, passed: firstTurn },
  ];
  const success = checklist.filter((item) => item.critical).every((item) => item.passed);
  const accuracy = checklist.filter((item) => item.passed).length / checklist.length;
  return {
    id: scenario.id,
    category: scenario.category,
    holdout: scenario.holdout,
    success,
    accuracy,
    durationMs,
    toolUses: toolCalls.length,
    retryCount: expectedCalls.length - successfulExpectedCalls.length,
    agentRuns,
    checklist,
    expected: { tool: scenario.expectedTool, count: scenario.expectedCount },
    actual: controllerCalls.map((call) => ({ name: call.name, args: call.args })),
    errors: controllerCalls.flatMap((call) => {
      const result = toolResults.get(call.toolCallId);
      return result?.isError || result?.tone === "error" ? [`${call.name}: ${result.text.slice(0, 500)}`] : [];
    }),
  };
}

async function runScenario(model, scenario) {
  const fixtureDir = mkdtempSync(join(tmpdir(), `pi-loop-routing-${scenario.id}-`));
  writeFileSync(join(fixtureDir, "README.md"), "# Isolated controller-routing fixture\n");
  const toolCalls = [];
  const toolResults = new Map();
  const traceEvents = [];
  let stderr = "";
  let buffer = "";
  let agentRuns = 0;
  let stdoutBytes = 0;
  let assistantText = "";
  let resolveSettled;
  let rejectSettled;
  let failure;
  const startedAt = Date.now();

  const child = spawn("pi", [
    "--mode", "rpc",
    "--no-session",
    "--approve",
    "--no-extensions",
    "--extension", extensionPath,
    "--no-skills",
    "--no-prompt-templates",
    "--no-context-files",
    "--no-builtin-tools",
    "--model", model,
    "--tools", "WorkflowCreate,TaskCreate,LoopCreate",
  ], {
    cwd: fixtureDir,
    env: { ...process.env, PI_LOOP_SCOPE: "project", PI_LOOP_DEBUG: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" },
    stdio: ["pipe", "pipe", "pipe"],
  });

  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-24_000);
  });

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
      if (event.type === "agent_start") agentRuns += 1;
      if (event.type === "tool_execution_start") {
        toolCalls.push({ name: event.toolName, args: event.args, toolCallId: event.toolCallId, agentRun: agentRuns });
        traceEvents.push({ type: event.type, toolName: event.toolName, args: event.args, agentRun: agentRuns });
      } else if (event.type === "tool_execution_end") {
        const text = textResult(event);
        toolResults.set(event.toolCallId, { isError: event.isError, tone: event.result?.details?.tone, text });
        traceEvents.push({ type: event.type, toolName: event.toolName, isError: event.isError, tone: event.result?.details?.tone, result: text.slice(0, 1000) });
      } else if (["agent_start", "agent_end", "agent_settled"].includes(event.type)) {
        if (event.type === "agent_end") {
          const assistant = [...(event.messages ?? [])].reverse().find((message) => message?.role === "assistant");
          assistantText = (assistant?.content ?? [])
            .filter((item) => item?.type === "text")
            .map((item) => item.text)
            .join("\n")
            .slice(-4_000);
        }
        traceEvents.push({ type: event.type, agentRun: agentRuns });
      } else if (event.type === "extension_error") {
        failure = new Error(`extension error: ${event.error}`);
        traceEvents.push({ type: event.type, extensionPath: event.extensionPath, error: event.error });
      }
      if (event.type === "agent_settled") {
        if (failure) rejectSettled?.(failure);
        else resolveSettled?.();
      }
    }
  });

  const settled = new Promise((resolveDone, rejectDone) => {
    const timeout = setTimeout(() => rejectDone(new Error(`${scenario.id} timed out after ${timeoutMs}ms`)), timeoutMs);
    resolveSettled = () => {
      clearTimeout(timeout);
      resolveDone();
    };
    rejectSettled = (error) => {
      clearTimeout(timeout);
      rejectDone(error);
    };
    child.once("exit", (code, signal) => rejectSettled(new Error(`pi exited before ${scenario.id} settled (code=${code}, signal=${signal})`)));
  });

  try {
    await new Promise((resolveWait) => setTimeout(resolveWait, startupMs));
    send(child, `routing-${scenario.id}`, scenario.prompt);
    await settled;
    return {
      ...evaluateScenario(scenario, toolCalls, toolResults, agentRuns, Date.now() - startedAt - startupMs),
      stderr: stderr.slice(-4_000),
      stdoutBytes,
      assistantText,
      events: traceEvents.slice(-100),
    };
  } finally {
    child.kill("SIGTERM");
    await new Promise((resolveClose) => {
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolveClose();
      }, 5_000);
      child.once("close", () => {
        clearTimeout(timer);
        resolveClose();
      });
    });
    rmSync(fixtureDir, { recursive: true, force: true });
  }
}

const modelResults = [];
let failure;
try {
  for (const model of models) {
    const results = [];
    for (const scenario of scenarios) {
      process.stdout.write(`RUN ${model} · ${scenario.id}\n`);
      results.push(await runScenario(model, scenario));
    }
    modelResults.push({
      model,
      success: results.every((result) => result.success),
      averageAccuracy: results.reduce((sum, result) => sum + result.accuracy, 0) / results.length,
      results,
    });
  }
  const failed = modelResults.flatMap((entry) => entry.results.filter((result) => !result.success).map((result) => `${entry.model}:${result.id}`));
  if (failed.length > 0) throw new Error(`critical controller-routing failures: ${failed.join(", ")}`);
} catch (error) {
  failure = error;
}

mkdirSync(artifactDir, { recursive: true });
const report = {
  status: failure ? "failed" : "passed",
  scenarioVersion: scenarioDocument.version,
  models,
  timeoutMs,
  startupMs,
  scenarioIds: scenarios.map((scenario) => scenario.id),
  modelResults,
  failure: failure instanceof Error ? failure.message : failure,
};
writeFileSync(join(artifactDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);

for (const entry of modelResults) {
  console.log(`${entry.success ? "PASS" : "FAIL"} ${entry.model} · accuracy ${(entry.averageAccuracy * 100).toFixed(1)}%`);
  for (const result of entry.results) {
    console.log(`  ${result.success ? "PASS" : "FAIL"} ${result.id} · ${(result.accuracy * 100).toFixed(0)}% · ${result.toolUses} tools · ${result.durationMs}ms`);
  }
}
console.log(`Artifact: ${join(artifactDir, "latest.json")}`);
if (failure) {
  console.error(`FAIL: ${failure instanceof Error ? failure.message : failure}`);
  process.exitCode = 1;
}
