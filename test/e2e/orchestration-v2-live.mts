/**
 * Live wire check of orchestration against the real `@tintinweb/pi-subagents`
 * package (protocol v2). It spends nothing: that provider runs workers inside
 * the parent process with the parent's model, and the parent model here is a
 * scripted fixture, so workers answer from the same script.
 *
 * It checks provider detection and tool registration, a two-item batch through
 * spawn, lifecycle events, usage evidence and settlement, and cancellation of a
 * worker that is busy in a tool call.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import process from "node:process";
import { type AssistantMessage, createAssistantMessageEventStream, InMemoryCredentialStore, type ToolCall } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const extension = resolve(process.env.PI_LOOP_LIVE_SUBAGENTS_EXTENSION ?? join(homedir(), ".pi", "agent", "npm", "node_modules", "@tintinweb", "pi-subagents", "src", "index.ts"));
if (process.env.PI_LOOP_LIVE_V2 !== "1") {
  console.log("SKIP: set PI_LOOP_LIVE_V2=1 to run the live protocol v2 orchestration check");
  process.exit(0);
}
if (!existsSync(extension)) {
  console.log(`SKIP: @tintinweb/pi-subagents entrypoint not found at ${extension}; set PI_LOOP_LIVE_SUBAGENTS_EXTENSION`);
  process.exit(0);
}

const workspace = mkdtempSync(join(tmpdir(), "pi-loop-live-v2-"));
const agentDir = mkdtempSync(join(tmpdir(), "pi-loop-live-v2-agent-"));
const artifactDir = resolve(process.env.PI_LOOP_LIVE_ARTIFACT_DIR ?? join(process.cwd(), ".artifacts", "live-orchestration-v2"));
const timeoutMs = Number.parseInt(process.env.PI_LOOP_LIVE_TIMEOUT_MS ?? "120000", 10);
process.env.PI_CODING_AGENT_DIR = agentDir;
delete process.env.PI_LOOP;
delete process.env.PI_LOOP_SCOPE;
delete process.env.PI_LOOP_CONTEXT;
writeFileSync(join(workspace, "README.md"), "# Isolated live protocol v2 orchestration fixture\n");
process.chdir(workspace);

const observed: Array<{ channel: string; payload: any }> = [];
const timeline: Array<Record<string, unknown>> = [];
const ownTools = new Map<string, { execute: (id: string, args: unknown) => Promise<{ content: Array<{ type: string; text?: string }> }> }>();
const startedMs = Date.now();
const report: Record<string, unknown> = { extension, startedAt: new Date().toISOString() };
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
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`timed out waiting for ${label}`);
}

let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
try {
  const { default: piLoop } = await import("../../src/index.js");
  const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false }, cacheWarming: "off" });
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: join(workspace, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  // Parent and in-process workers share this script: each request takes the next entry, or a plain reply.
  const replies: ToolCall[][] = [];
  modelRuntime.registerProvider("live-v2-fixture", {
    api: "openai-completions",
    baseUrl: "https://invalid.test",
    apiKey: "fixture-not-a-secret",
    models: [{ id: "scripted", name: "Scripted fixture (no model inference)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 1024 }],
    streamSimple(model) {
      const calls = replies.shift() ?? [];
      const message: AssistantMessage = {
        role: "assistant",
        content: calls.length ? calls : [{ type: "text", text: "Fixture complete." }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 20, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 25, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
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
        for (const channel of ["subagents:ready", "subagents:started", "subagents:completed", "subagents:failed"]) {
          pi.events.on(channel, (payload) => {
            observed.push({ channel, payload });
            timeline.push({ at: Date.now() - startedMs, what: channel, id: (payload as any)?.id, status: (payload as any)?.status });
          });
        }
        for (const method of ["ping", "spawn", "stop", "consume"]) {
          pi.events.on(`subagents:rpc:${method}`, (raw) => {
            const request = raw as { requestId: string; type?: string; agentId?: string; options?: { maxTurns?: number } };
            timeline.push({ at: Date.now() - startedMs, what: `request:${method}`, type: request.type, id: request.agentId, maxTurns: request.options?.maxTurns });
            const off = pi.events.on(`subagents:rpc:${method}:reply:${request.requestId}`, (reply) => {
              off();
              const data = reply as { success?: boolean; error?: string; data?: { id?: string; version?: number } };
              timeline.push({ at: Date.now() - startedMs, what: `reply:${method}`, success: data.success, id: data.data?.id, version: data.data?.version, error: data.error ? String(data.error).slice(0, 200) : undefined });
            });
          });
        }
      },
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
    modelRuntime, model: modelRuntime.getModel("live-v2-fixture", "scripted"), thinkingLevel: "off",
  });
  session = created.session;
  const extensionErrors: string[] = [];
  session.extensionRunner.onError((error) => extensionErrors.push(`${error.extensionPath}: ${error.error}`));
  await session.bindExtensions({});
  const bound = session;
  let sequence = 0;
  const call = async (name: string, args: Record<string, unknown>, workerScript: ToolCall[][] = []) => {
    const id = `live-${++sequence}`;
    // The parent's tool call, its closing reply, then whatever the workers should do.
    replies.push([{ type: "toolCall", id, name, arguments: args }], [], ...workerScript);
    await bound.prompt("Execute the scripted live check.");
    await bound.waitForIdle();
    const result = bound.messages.find((message) => message.role === "toolResult" && message.toolCallId === id);
    if (result?.role !== "toolResult") throw new Error(`missing result for ${name}`);
    return result.content.filter((part) => part.type === "text").map((part) => (part as { text: string }).text).join("\n");
  };
  const work = (goal: string) => loops().find((entry) => entry.orchestration?.goal === goal)?.orchestration?.work as any[] | undefined;
  const settled = (items: any[] | undefined) => items?.every((item) => item.status !== "pending" && item.status !== "active") ? items : undefined;

  // 1. The real provider answers the protocol-v2 probe, so the tools are offered.
  await until(() => bound.getAllTools().some((tool) => tool.name === "OrchestrationCreate") ? true : undefined, "orchestration tool registration");
  report.toolsRegistered = true;
  check(timeline.some((entry) => entry.what === "reply:ping" && entry.version === 2), "no protocol version 2 ping reply was seen");
  const agentTypeDescription = (bound.getAllTools().find((tool) => tool.name === "OrchestrationCreate")!.parameters as any).properties.agentType.description as string;
  check(agentTypeDescription.includes("general-purpose"), `schema default was: ${agentTypeDescription}`);

  // 2. A two-item batch with a turn limit: spawn, lifecycle, usage and settlement.
  const batchGoal = "Live v2 batch";
  const createdText = await call("OrchestrationCreate", { goal: batchGoal, work: [{ prompt: "Reply with the single word ok." }, { prompt: "Reply with the single word ok." }], maxTurns: 3, concurrency: 2 });
  report.create = createdText;
  check(createdText.includes("created") && createdText.includes("fixed concurrency 2"), `batch was not created as asked: ${createdText}`);
  const items = await until(() => settled(work(batchGoal)), "batch settlement");
  report.batch = items.map((item) => ({ status: item.status, agentType: item.agentType, dispatch: item.dispatches?.at(-1) }));
  const spawns = timeline.filter((entry) => entry.what === "request:spawn");
  check(spawns.length === 2, `expected 2 spawn requests, saw ${spawns.length}`);
  check(spawns.every((entry) => entry.type === "general-purpose" && entry.maxTurns === 3), `spawn requests were: ${JSON.stringify(spawns)}`);
  for (const [index, item] of items.entries()) {
    const dispatch = item.dispatches?.at(-1);
    check(item.status === "completed", `item ${index + 1} settled as ${item.status}: ${dispatch?.error}`);
    check(typeof dispatch?.agentId === "string" && dispatch.agentId.length > 0, `item ${index + 1} has no agent id`);
    check(observed.some((event) => event.channel === "subagents:started" && event.payload?.id === dispatch?.agentId), `no subagents:started for item ${index + 1}`);
    check(observed.some((event) => event.channel === "subagents:completed" && event.payload?.id === dispatch?.agentId), `no subagents:completed for item ${index + 1}`);
    check(typeof dispatch?.result === "string" && dispatch.result.length > 0, `item ${index + 1} carried no result text`);
    check(Number.isFinite(dispatch?.usage?.toolUses), `item ${index + 1} carried no tool-use count; the delay signal depends on it`);
    check(Number.isFinite(dispatch?.usage?.durationMs), `item ${index + 1} carried no duration`);
    check(dispatch?.consumeStatus === "provider_owned", `item ${index + 1} output ownership was ${dispatch?.consumeStatus}`);
  }
  check(!timeline.some((entry) => entry.what === "request:consume"), "pi-loop consumed a provider-owned result");
  const batchEntry = loops().find((entry) => entry.orchestration?.goal === batchGoal);
  report.inspection = await call("OrchestrationGet", { id: String(batchEntry?.id) });
  check(String(report.inspection).includes("2/2 complete"), `inspection was: ${report.inspection}`);

  // 3. Cancelling a worker that is busy in a tool call reaches the provider's stop method.
  const cancelGoal = "Live v2 cancellation";
  const busy: ToolCall[] = [{ type: "toolCall", id: "worker-sleep", name: "bash", arguments: { command: "sleep 60" } }];
  // Not awaited yet: the parent turn may stay open while the worker runs.
  const creating = call("OrchestrationCreate", { goal: cancelGoal, work: [{ prompt: "Run the scripted command." }] }, [busy]);
  const active = await until(() => {
    const entry = loops().find((candidate) => candidate.orchestration?.goal === cancelGoal);
    const last = entry?.orchestration?.work?.[0]?.dispatches?.at(-1);
    return last?.agentId && last.status === "running" ? { id: String(entry.id), agentId: last.agentId as string } : undefined;
  }, "a running worker to cancel");
  timeline.push({ at: Date.now() - startedMs, what: "LoopDelete", id: active.agentId });
  const cancelled = (await ownTools.get("LoopDelete")!.execute("live-cancel", { id: active.id })).content.map((part) => part.text ?? "").join("\n");
  report.cancellation = { message: cancelled, agentId: active.agentId };
  check(/cancel/i.test(cancelled), `LoopDelete did not report a cancellation: ${cancelled}`);
  check(timeline.some((entry) => entry.what === "request:stop" && entry.id === active.agentId), "pi-loop sent no stop request for the running worker");
  check(timeline.some((entry) => entry.what === "reply:stop" && entry.success === true), "the provider did not accept the stop request");
  const ended = await until(() => observed.find((event) => (event.channel === "subagents:failed" || event.channel === "subagents:completed") && event.payload?.id === active.agentId), "the provider to report the cancelled worker");
  report.cancellationEvent = { channel: ended.channel, status: ended.payload?.status };
  check(ended.channel === "subagents:failed" && (ended.payload?.status === "stopped" || ended.payload?.status === "aborted"), `cancelled worker ended as ${ended.channel} ${ended.payload?.status}`);
  await creating;
  const retained = loops().find((candidate) => candidate.orchestration?.goal === cancelGoal);
  report.cancellationRetained = retained ? { status: retained.orchestration.status, work: retained.orchestration.work[0].status } : "deleted";
  check(retained === undefined || retained.orchestration.work[0].status !== "completed", "a cancelled worker was recorded as completed");

  const ownErrors = extensionErrors.filter((error) => !error.startsWith(extension));
  check(ownErrors.length === 0, `pi-loop extension errors: ${ownErrors.join("; ")}`);
  report.extensionErrors = extensionErrors;
} catch (error) {
  failures.push(error instanceof Error ? error.stack ?? error.message : String(error));
} finally {
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
  mkdirSync(artifactDir, { recursive: true });
  writeFileSync(join(artifactDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  process.chdir(tmpdir());
  rmSync(workspace, { recursive: true, force: true });
  rmSync(agentDir, { recursive: true, force: true });
}

if (failures.length) {
  console.error(`FAIL: ${failures.length} check(s) failed\n- ${failures.join("\n- ")}`);
  console.error(`report: ${join(artifactDir, "report.json")}`);
  process.exit(1);
}
console.log(`PASS: live protocol v2 orchestration wire check (no model spend); report: ${join(artifactDir, "report.json")}`);
process.exit(0);
