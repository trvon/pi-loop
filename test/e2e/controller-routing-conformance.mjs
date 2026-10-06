#!/usr/bin/env node
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import { createModelObservationCollector, evaluateScenario } from "./controller-routing-evaluation.mjs";
import { sendRpcPrompt } from "./rpc-child-io.mjs";

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

if (models.length === 0) throw new Error("No routing models were configured");
if (scenarios.length === 0) throw new Error("No controller-routing scenarios matched PI_LOOP_LIVE_ROUTING_SCENARIOS");

function textResult(event) {
  return (event.result?.content ?? [])
    .filter((item) => item?.type === "text")
    .map((item) => item.text)
    .join("\n");
}

async function runScenario(model, scenario) {
  const fixtureDir = mkdtempSync(join(tmpdir(), `pi-loop-routing-${scenario.id}-`));
  writeFileSync(join(fixtureDir, "README.md"), "# Isolated controller-routing fixture\n");
  const toolCalls = [];
  const modelObservations = createModelObservationCollector();
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

  const reportChildFailure = (channel, cause) => {
    const error = new Error(`pi ${channel} failed for ${scenario.id}: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    failure ??= error;
    rejectSettled?.(failure);
  };
  child.once("error", (cause) => reportChildFailure("process", cause));
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
      modelObservations.observe(event);
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
    sendRpcPrompt(child, `routing-${scenario.id}`, scenario.prompt, (cause) => reportChildFailure("stdin", cause));
    await settled;
    return {
      ...evaluateScenario(scenario, toolCalls, toolResults, agentRuns, Date.now() - startedAt - startupMs),
      ...modelObservations.snapshot(),
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
let piVersion = "unavailable";
try {
  piVersion = execFileSync("pi", ["--version"], { encoding: "utf8", timeout: 10_000 }).trim();
} catch {
  // Version probing must not discard failed-run evidence when Pi is unavailable.
}
const report = {
  status: failure ? "failed" : "passed",
  scenarioVersion: scenarioDocument.version,
  evaluationVersion: 2,
  runtime: { node: process.version, pi: piVersion },
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
    console.log(`  ${result.success ? "PASS" : "FAIL"} ${result.id} · ${(result.accuracy * 100).toFixed(0)}% · ${result.toolUses} tools · first valid=${result.firstAttemptValid} semantic=${result.firstAttemptSemantic} · ${result.durationMs}ms`);
  }
}
console.log(`Artifact: ${join(artifactDir, "latest.json")}`);
if (failure) {
  console.error(`FAIL: ${failure instanceof Error ? failure.message : failure}`);
  process.exitCode = 1;
}
