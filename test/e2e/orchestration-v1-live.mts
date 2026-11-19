/**
 * Live wire check of orchestration against the real npm `pi-subagents` package
 * (RPC v1). The parent session is scripted: no parent model inference.
 *
 * Default mode spends nothing: the worker's agent directory is an empty
 * temporary one, so the detached child has no credentials and its run fails.
 * That still exercises probe, tool registration, launch, run id, lifecycle
 * events and settlement against the real provider.
 *
 * PI_LOOP_LIVE_V1_AGENT_DIR=<agent dir> with PI_LOOP_LIVE_MODEL=<provider/model>
 * lets the worker use that directory's real credentials, so one worker makes
 * real model requests and the success path is checked too.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { type AssistantMessage, createAssistantMessageEventStream, InMemoryCredentialStore, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const extension = resolve(process.env.PI_LOOP_LIVE_SUBAGENTS_V1_EXTENSION ?? join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-subagents", "index.js"));
if (process.env.PI_LOOP_LIVE_V1 !== "1") {
  console.log("SKIP: set PI_LOOP_LIVE_V1=1 to run the live RPC v1 orchestration check");
  process.exit(0);
}
if (!existsSync(extension)) {
  console.log(`SKIP: npm pi-subagents entrypoint not found at ${extension}; set PI_LOOP_LIVE_SUBAGENTS_V1_EXTENSION`);
  process.exit(0);
}

const paid = process.env.PI_LOOP_LIVE_V1_AGENT_DIR !== undefined;
const workerModel = process.env.PI_LOOP_LIVE_MODEL;
if (paid && !workerModel) {
  console.log("SKIP: PI_LOOP_LIVE_V1_AGENT_DIR needs PI_LOOP_LIVE_MODEL=<provider/model>; the scripted parent model does not exist for a worker");
  process.exit(0);
}
const workspace = mkdtempSync(join(tmpdir(), "pi-loop-live-v1-"));
const agentDir = paid ? resolve(process.env.PI_LOOP_LIVE_V1_AGENT_DIR!) : mkdtempSync(join(tmpdir(), "pi-loop-live-v1-agent-"));
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(process.cwd(), ".artifacts", "live-orchestration-v1"));
const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "180000", 10);
// Detached workers inherit this, so an unpaid run cannot reach real credentials.
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_LOOP;
delete process.env.PI_LOOP_SCOPE;
delete process.env.PI_LOOP_CONTEXT;
writeFileSync(join(workspace, "README.md"), "# Isolated live RPC v1 orchestration fixture\n");
process.chdir(workspace);

const observed: Array<{ channel: string; payload: unknown }> = [];
const timeline: Array<Record<string, unknown>> = [];
const ownTools = new Map<string, { execute: (id: string, args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }>();
const startedMs = Date.now();
const report: Record<string, unknown> = { extension, paid, startedAt: new Date().toISOString() };
const failures: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
};

function loops(): any[] {
  const dir = join(workspace, ".pi", "loops");
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((name) => name.endsWith(".json")).flatMap((name) => JSON.parse(readFileSync(join(dir, name), "utf8")).loops ?? []);
}

async function until<T>(read: () => T | undefined, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  const { default: piLoop } = await import("../../src/index.js");
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(workspace, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const replies: ToolCall[][] = [];
  modelRuntime.registerProvider("live-v1-fixture", {
    api: "openai-completions",
    baseUrl: "https://invalid.test",
    apiKey: "fixture-not-a-secret",
    models: [{ id: "scripted", name: "Scripted parent (no model inference)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model) {
      const calls = replies.shift() ?? [];
      const message: AssistantMessage = {
        role: "assistant",
        content: calls.length ? calls : [{ type: "text", text: "Fixture complete." }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: calls.length ? "toolUse" : "stop",
        timestamp: Date.now(),
      };
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
      stream.end();
      return stream;
    },
  });
  const loader = new DefaultResourceLoader({
    cwd: workspace, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [extension],
    extensionFactories: [
      (pi) => {
        for (const channel of ["subagents:rpc:v1:ready", "subagent:async-started", "subagent:async-complete", "subagent:process-terminal"]) {
          pi.events.on(channel, (payload) => {
            observed.push({ channel, payload });
            timeline.push({ at: Date.now() - startedMs, what: channel, id: (payload as any)?.id ?? (payload as any)?.runId, state: (payload as any)?.state });
          });
        }
        // Requests pi-loop sends, and the provider's reply to each, without prompts or results.
        pi.events.on("subagents:rpc:v1:request", (raw) => {
          const request = raw as { requestId: string; method: string; params?: Record<string, unknown> };
          timeline.push({ at: Date.now() - startedMs, what: `request:${request.method}`, id: request.params?.id as string | undefined });
          const off = pi.events.on(`subagents:rpc:v1:reply:${request.requestId}`, (reply) => {
            off();
            const data = reply as { success?: boolean; error?: { code?: string; message?: string }; data?: { state?: string } };
            timeline.push({ at: Date.now() - startedMs, what: `reply:${request.method}`, success: data.success, state: data.data?.state, error: data.error ? `${data.error.code}: ${String(data.error.message).slice(0, 200)}` : undefined });
          });
        });
      },
      // Keep pi-loop's own tool executors: the provider holds a headless parent turn open until its
      // workers finish, so a cancellation sent through a scripted parent turn would arrive too late.
      (pi) => piLoop(new Proxy(pi, {
        get(target, property, receiver) {
          if (property !== "registerTool") return Reflect.get(target, property, receiver);
          return (definition: { name: string; execute: (id: string, args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }) => {
            ownTools.set(definition.name, definition);
            return (target.registerTool as (tool: unknown) => unknown)(definition);
          };
        },
      })),
    ],
  });
  await loader.reload();
  const loadErrors = loader.getExtensions().errors;
  if (loadErrors.length) throw new Error(`extension load failed: ${JSON.stringify(loadErrors)}`);
  const created = await createAgentSession({
    cwd: workspace, agentDir, resourceLoader: loader, settingsManager,
    sessionManager: SessionManager.create(workspace, join(workspace, "sessions")),
    modelRuntime, model: modelRuntime.getModel("live-v1-fixture", "scripted"), thinkingLevel: "off",
  });
  session = created.session;
  const extensionErrors: string[] = [];
  session.extensionRunner.onError((error) => extensionErrors.push(`${error.extensionPath}: ${error.error}`));
  await session.bindExtensions({});
  const bound = session;
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>) => {
    const id = `live-${++sequence}`;
    replies.push([{ type: "toolCall", id, name, arguments: args }]);
    await bound.prompt("Execute the scripted live check.");
    await bound.waitForIdle();
    const result = bound.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    if (result?.role !== "toolResult") throw new Error(`missing result for ${name}`);
    return result.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
  };

  // 1. The real provider answers the v1 probe, so the tools are offered.
  await until(() => bound.getAllTools().some((tool) => tool.name === "OrchestrationCreate") ? true : undefined, "orchestration tool registration");
  report.toolsRegistered = true;
  check(observed.some((event) => event.channel === "subagents:rpc:v1:ready"), "provider did not announce subagents:rpc:v1:ready");

  // 2. A provider with no turn limit rejects maxTurns without writing state.
  const rejected = await call("OrchestrationCreate", { goal: "Live v1 turn limit", work: [{ prompt: "Reply with the single word ok." }], maxTurns: 3 });
  report.maxTurnsRejection = rejected;
  check(rejected.includes("maxTurns is not supported by pi-subagents (RPC v1)"), `maxTurns was not rejected: ${rejected}`);
  check(loops().length === 0, "a rejected create persisted state");

  // 3. An unknown agent type is a proved launch failure, not an uncertain one.
  const unknown = await call("OrchestrationCreate", { goal: "Live v1 unknown agent", work: [{ prompt: "Reply with the single word ok.", agentType: "pi-loop-no-such-agent" }] });
  check(unknown.includes("created"), `unknown-agent batch was not created: ${unknown}`);
  const unknownItem = await until(() => {
    const item = loops().find((entry) => entry.orchestration?.goal === "Live v1 unknown agent")?.orchestration?.work?.[0];
    return item && item.status !== "pending" && item.status !== "active" ? item : undefined;
  }, "unknown agent settlement");
  report.unknownAgent = { status: unknownItem.status, dispatch: unknownItem.dispatches?.at(-1) };
  check(unknownItem.status === "failed", `unknown agent settled as ${unknownItem.status}, expected failed`);
  check(/Unknown agent/i.test(unknownItem.dispatches?.at(-1)?.error ?? ""), `unknown agent error was: ${unknownItem.dispatches?.at(-1)?.error}`);

  // 4. A real launch: run id, lifecycle events and settlement.
  const launched = await call("OrchestrationCreate", { goal: "Live v1 launch", work: [{ prompt: "Reply with the single word ok. Do not use any tools." }], ...(paid ? { model: workerModel } : {}) });
  report.create = launched;
  check(launched.includes("created"), `launch batch was not created: ${launched}`);
  // The unknown-agent batch said nothing about load, so this one must not start from its window.
  check(!launched.includes("learned from"), `a refused launch seeded the next batch: ${launched}`);
  check(unknownItem.dispatches?.length === 1, "a refused launch was re-sent");
  const item = await until(() => {
    const work = loops().find((entry) => entry.orchestration?.goal === "Live v1 launch")?.orchestration?.work?.[0];
    return work && work.status !== "pending" && work.status !== "active" ? work : undefined;
  }, "launch settlement");
  const dispatch = item.dispatches?.at(-1);
  report.launch = { status: item.status, dispatch };
  const runId = dispatch?.agentId;
  check(typeof runId === "string" && runId.length > 0, "the launch reply carried no run id");
  check(observed.some((event) => event.channel === "subagent:async-started" && (event.payload as any)?.id === runId), "no async-started event for the run id");
  const complete = observed.find((event) => event.channel === "subagent:async-complete" && ((event.payload as any)?.id === runId || (event.payload as any)?.runId === runId));
  check(complete, "no async-complete event for the run id");
  if (paid) {
    check(item.status === "completed", `paid launch settled as ${item.status}: ${dispatch?.error}`);
    check(typeof dispatch?.result === "string" && dispatch.result.length > 0, "completed worker carried no result text");
  } else {
    check(item.status === "failed", `launch without credentials settled as ${item.status}, expected failed`);
    check(typeof dispatch?.error === "string" && dispatch.error.length > 0, "failed worker carried no error text");
  }
  check(dispatch?.usage?.toolUses === undefined, "RPC v1 unexpectedly reported a tool-use count; revisit the adapter's delay-signal assumption");
  report.completePayloadKeys = complete ? Object.keys(complete.payload as object).sort() : [];
  report.completeState = complete ? { success: (complete.payload as any).success, state: (complete.payload as any).state, timedOut: (complete.payload as any).timedOut, firstResultKeys: Object.keys((complete.payload as any).results?.[0] ?? {}).sort() } : undefined;
  report.inspection = await call("OrchestrationGet", { id: String(loops().find((entry) => entry.orchestration?.goal === "Live v1 launch")?.id) });
  // The provider reports its own failed run as an extension error; only pi-loop's errors fail this check.
  const ownErrors = extensionErrors.filter((error) => !error.startsWith(extension));
  check(ownErrors.length === 0, `pi-loop extension errors: ${ownErrors.join("; ")}`);
  if (paid) check(extensionErrors.length === 0, `extension errors: ${extensionErrors.join("; ")}`);
  report.extensionErrors = extensionErrors;
  if (paid) {
    // 5. Cancelling an active batch reaches the provider's stop method for the real run.
    const cancelGoal = "Live v1 cancellation";
    // Not awaited yet: the provider keeps this headless parent turn open while its worker runs.
    const creating = call("OrchestrationCreate", { goal: cancelGoal, model: workerModel, work: [{ prompt: "Use your shell tool to run exactly `sleep 90`, then reply done." }] });
    const active = await until(() => {
      const entry = loops().find((candidate) => candidate.orchestration?.goal === cancelGoal);
      const last = entry?.orchestration?.work?.[0]?.dispatches?.at(-1);
      return last?.agentId ? { id: String(entry.id), runId: last.agentId as string } : undefined;
    }, "an active worker to cancel");
    timeline.push({ at: Date.now() - startedMs, what: "LoopDelete", id: active.runId });
    const cancelled = (await ownTools.get("LoopDelete")!.execute("live-cancel", { id: active.id })).content.map((part) => part.text ?? "").join("\n");
    timeline.push({ at: Date.now() - startedMs, what: "LoopDelete:result" });
    report.cancellation = { message: cancelled, runId: active.runId };
    check(/cancel/i.test(cancelled), `LoopDelete did not report a cancellation: ${cancelled}`);
    const stopped = await until(() => observed.find((event) => event.channel === "subagent:async-complete" && (event.payload as any)?.id === active.runId), "the provider to report the cancelled run");
    report.cancellationState = { state: (stopped.payload as any).state, success: (stopped.payload as any).success, durationMs: (stopped.payload as any).durationMs, output: String((stopped.payload as any).results?.[0]?.output ?? "").slice(0, 200) };
    check((stopped.payload as any).state === "stopped", `cancelled run ended as ${(stopped.payload as any).state}, expected stopped`);
    const cancelCreated = await creating;
    check(cancelCreated.includes("created"), `cancellation batch was not created: ${cancelCreated}`);
    const retained = loops().find((candidate) => candidate.orchestration?.goal === cancelGoal);
    report.cancellationRetained = retained ? { status: retained.orchestration.status, work: retained.orchestration.work[0].status } : "deleted";
    check(retained === undefined || retained.orchestration.work[0].status !== "completed", "a cancelled worker was recorded as completed");
    check(timeline.some((entry) => entry.what === "request:stop" && entry.id === active.runId), "pi-loop sent no stop request for the active run");
    check(timeline.some((entry) => entry.what === "reply:stop" && entry.success === true), "the provider did not accept the stop request");
    check(Number((stopped.payload as any).durationMs) < 60_000, "the cancelled worker ran to the end of its 90 s task");

    const usage = dispatch?.usage;
    report.usage = usage;
    check(Number.isFinite(usage?.durationMs), "completed worker carried no duration");
    check(Number.isFinite(usage?.tokens?.output) && usage.tokens.output > 0, "completed worker carried no output-token count");
  }
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
  report.events = observed.map((event) => event.channel);
  report.timeline = timeline;
  report.failures = failures;
  report.finishedAt = new Date().toISOString();
  try {
    if (session) {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
  } catch (error) {
    failures.push(`teardown: ${error instanceof Error ? error.message : String(error)}`);
  }
  const { mkdirSync } = await import("node:fs");
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.chdir(tmpdir());
  rmSync(workspace, { recursive: true, force: true });
  if (!paid) rmSync(agentDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} check(s) failed\n- ${failures.join("\n- ")}`);
  console.error(`report: ${join(artifactDir, "report.json")}`);
  process.exit(1);
}
console.log(`PASS: live RPC v1 orchestration ${paid ? "with a real worker model" : "wire check (no model spend)"}; report: ${join(artifactDir, "report.json")}`);
process.exit(0);
