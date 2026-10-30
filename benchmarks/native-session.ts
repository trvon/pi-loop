import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AssistantMessage,
  createAssistantMessageEventStream,
  getCurrentTools,
  InMemoryCredentialStore,
  type ToolCall,
  type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import piLoop from "../src/index.js";
import { createToolObserver } from "./native-tool-observer.js";

export async function createNativeSession(options: {
  mode?: "on" | "only";
  inactive?: boolean;
  inlineBudget?: number;
  block?: string;
  onRequest?: (context: TranscriptContext, workspace: string) => void;
  inference?: { modelRuntime: ModelRuntime; model: NonNullable<ReturnType<ModelRuntime["getModel"]>> };
  allowTools?: readonly string[];
} = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-loop-codemode-"));
  let session: AgentSession | undefined;
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try {
      if (session) {
        await session.abort();
        await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      }
    } finally {
      session?.dispose();
      await rm(cwd, { recursive: true, force: true });
    }
  };

  try {
    const settingsManager = SettingsManager.inMemory({
      packages: [],
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
      ...(options.mode && !options.inactive ? { defaultTools: ["+codemode"] } : {}),
      codemode: { mode: options.mode ?? "on", inlineBudget: options.inlineBudget ?? 3000 },
    });
    const requests: Array<ReturnType<typeof getCurrentTools>> = [];
    const replies: ToolCall[][] = [];
    const modelRuntime = options.inference?.modelRuntime ?? await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      modelsStorePath: join(cwd, "models-cache.json"),
      refreshOnCreate: false,
      allowModelNetwork: false,
    });
    if (!options.inference) modelRuntime.registerProvider("codemode-fixture", {
      api: "openai-completions",
      baseUrl: "https://invalid.test",
      apiKey: "fixture-not-a-secret",
      models: [{
        id: "scripted",
        name: "Scripted conformance fixture (no model inference)",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 128000,
        maxTokens: 1024,
      }],
      streamSimple(model, context) {
        options.onRequest?.(context, cwd);
        requests.push(structuredClone(getCurrentTools(context.messages)));
        const calls = replies.shift() ?? [];
        const message: AssistantMessage = {
          role: "assistant",
          content: calls.length ? calls : [{ type: "text", text: "Fixture complete." }],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: calls.length ? "toolUse" : "stop",
          timestamp: Date.now(),
        };
        const stream = createAssistantMessageEventStream();
        stream.push({ type: "done", reason: calls.length ? "toolUse" : "stop", message });
        stream.end();
        return stream;
      },
    });

    const calls: string[] = [];
    const observations = createToolObserver();
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: cwd,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        (pi) => {
          // Capture memory scope synchronously; never retain or replace the caller's environment.
          const previous = { PI_LOOP: process.env.PI_LOOP, PI_LOOP_SCOPE: process.env.PI_LOOP_SCOPE };
          process.env.PI_LOOP = "off";
          process.env.PI_LOOP_SCOPE = "memory";
          try { piLoop(pi); }
          finally {
            for (const [name, value] of Object.entries(previous)) {
              if (value === undefined) delete process.env[name];
              else process.env[name] = value;
            }
          }
          pi.on("agent_start", () => { observations.agentStart(); });
          pi.on("tool_execution_start", event => { observations.start(event); });
          pi.on("tool_execution_end", event => { observations.end(event); });
          pi.on("tool_call", (event) => {
            if (observations.hasFailures()) return { block: true, reason: "Incomplete fixture execution evidence" };
            calls.push(event.toolName);
            if (event.toolName === options.block || (options.allowTools && !options.allowTools.includes(event.toolName))) {
              return { block: true, reason: "Fixture permission denial" };
            }
          });
        },
        ...(options.mode ? [createCodemodeExtension({ models: false })] : []),
      ],
    });
    await loader.reload();
    if (loader.getExtensions().errors.length) throw new Error(JSON.stringify(loader.getExtensions().errors));
    const created = await createAgentSession({
      cwd,
      agentDir: cwd,
      resourceLoader: loader,
      settingsManager,
      sessionManager: SessionManager.inMemory(cwd),
      modelRuntime,
      model: options.inference?.model ?? modelRuntime.getModel("codemode-fixture", "scripted"),
      thinkingLevel: "off",
    });
    session = created.session;
    const errors: string[] = [];
    session.extensionRunner.onError((error) => {
      errors.push(error.error);
      observations.incomplete("Extension error during tool observation");
    });
    await session.bindExtensions({});
    const boundSession = session;
    let sequence = 0;

    async function prompt(text = "Execute the scripted conformance fixture.") {
      await boundSession.prompt(text);
      if (errors.length) throw new Error(errors.join("\n"));
      let assistant: AssistantMessage | undefined;
      for (const message of boundSession.messages) {
        if (message.role === "assistant") assistant = message;
      }
      if (assistant?.role !== "assistant" || assistant.stopReason !== "stop") {
        throw new Error(assistant?.role === "assistant" ? assistant.errorMessage ?? "Fixture did not settle" : "Missing fixture response");
      }
    }

    async function callMany(inputs: Array<{ name: string; args: ToolCall["arguments"] }>) {
      if (options.inference) throw new Error("Scripted tool choices are disabled for configured-model sessions");
      const batch: ToolCall[] = inputs.map(({ name, args }) => ({ type: "toolCall", id: `fixture-${++sequence}`, name, arguments: args }));
      replies.push(batch);
      await prompt();
      return batch.map(({ id }) => {
        const result = boundSession.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
        if (result?.role !== "toolResult") throw new Error(`Missing fixture result for ${id}`);
        return result;
      });
    }

    async function call(name: string, args: ToolCall["arguments"]) {
      const [result] = await callMany([{ name, args }]);
      if (!result) throw new Error("Missing single-call fixture result");
      return result;
    }

    return {
      session: boundSession,
      evidenceKind: options.inference ? "configured-model" : "scripted-conformance",
      close,
      workspace: cwd,
      requests,
      calls,
      observations,
      call,
      callMany,
      prompt,
      script: (code: string) => call("codemode", { code }),
    };
  } catch (error) {
    try { await close(); }
    catch (cleanup) { throw new AggregateError([error, cleanup], "Native fixture setup and cleanup failed"); }
    throw error;
  }
}
