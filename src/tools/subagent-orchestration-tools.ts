import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { LoopScope } from "../runtime/scope.js";
import type { LoopStore } from "../store.js";
import type { OrchestrationActor, OrchestrationDefinitionInput } from "../types.js";
import { orchestrationControllerText, orchestrationDisplayDetails, orchestrationProgressLabel, orchestrationWorkText } from "../ui/orchestration-presentation.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { textResult } from "./tool-result.js";

const MAX_WORK_ITEMS = 32;
const MAX_CONCURRENCY = 8;
const MAX_ATTEMPTS = 3;
const MAX_TURNS = 100;
const MAX_GOAL_CHARS = 2_000;
const MAX_PROMPT_CHARS = 16_384;
const MAX_SERIALIZED_INPUT_BYTES = 65_536;

interface OrchestrationToolsOptions {
  pi: ExtensionAPI;
  getStore: () => LoopStore;
  getScope: () => LoopScope;
  getPiLoopEnv: () => string | undefined;
  getActor: () => OrchestrationActor | undefined;
  probeSubagents: () => Promise<unknown>;
  updateWidget: () => void;
}

interface CreateParams {
  goal: string;
  work: Array<{ prompt: string; agentType?: string }>;
  agentType?: string;
  model?: string;
  maxTurns?: number;
  concurrency?: number;
  maxAttempts?: number;
}

function errorResult(message: string) {
  return textResult(message, {
    kind: "orchestration",
    action: "create",
    tone: "error",
    summary: "Orchestration was not created",
    expanded: [message],
  });
}

function validateCreate(params: CreateParams): string | undefined {
  if (!params.goal.trim() || params.goal.length > MAX_GOAL_CHARS) return `goal must contain 1-${MAX_GOAL_CHARS} characters`;
  if (params.work.length < 1 || params.work.length > MAX_WORK_ITEMS) return `Orchestration requires between 1 and ${MAX_WORK_ITEMS} work items.`;
  const concurrency = params.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) return `concurrency must be between 1 and ${MAX_CONCURRENCY}`;
  const maxAttempts = params.maxAttempts ?? 1;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > MAX_ATTEMPTS) return `maxAttempts must be between 1 and ${MAX_ATTEMPTS}`;
  if (params.maxTurns !== undefined && (!Number.isInteger(params.maxTurns) || params.maxTurns < 1 || params.maxTurns > MAX_TURNS)) {
    return `maxTurns must be between 1 and ${MAX_TURNS}`;
  }
  for (const [index, item] of params.work.entries()) {
    if (!item.prompt.trim()) return `work item ${index + 1} prompt must not be empty`;
    if (item.prompt.length > MAX_PROMPT_CHARS) return `work prompt exceeds ${MAX_PROMPT_CHARS} characters at item ${index + 1}`;
    if ((item.agentType ?? params.agentType ?? "general-purpose").length > 128) return `agentType exceeds 128 characters at item ${index + 1}`;
  }
  if (Buffer.byteLength(JSON.stringify(params), "utf8") > MAX_SERIALIZED_INPUT_BYTES) {
    return `Serialized orchestration input exceeds ${MAX_SERIALIZED_INPUT_BYTES} bytes.`;
  }
  return undefined;
}

function protocolVersion(value: unknown): number | undefined {
  if (!value || typeof value !== "object") return undefined;
  const version = (value as Record<string, unknown>).version;
  return Number.isInteger(version) ? Number(version) : undefined;
}

function definitionFrom(params: CreateParams): OrchestrationDefinitionInput {
  return {
    goal: params.goal.trim(),
    work: params.work.map((item) => ({
      prompt: item.prompt.trim(),
      agentType: item.agentType ?? params.agentType ?? "general-purpose",
    })),
    concurrency: params.concurrency ?? 3,
    maxAttempts: params.maxAttempts ?? 1,
    model: params.model,
    maxTurns: params.maxTurns,
  };
}

export function registerSubagentOrchestrationTools(options: OrchestrationToolsOptions): void {
  const { pi, getStore, getScope, getPiLoopEnv, getActor, probeSubagents, updateWidget } = options;

  pi.registerTool({
    name: "OrchestrationCreate",
    label: "OrchestrationCreate",
    renderCall: renderToolCall("Orchestration", (args) => `create · ${String(toolArg(args, "goal") ?? "batch").slice(0, 56)}`),
    renderResult: renderToolResult,
    description: "Create a bounded session LoopStore orchestration batch.",
    parameters: Type.Object({
      goal: Type.String({ description: "Shared batch goal", maxLength: MAX_GOAL_CHARS }),
      work: Type.Array(Type.Object({
        prompt: Type.String({ description: "Bounded independent work prompt", maxLength: MAX_PROMPT_CHARS }),
        agentType: Type.Optional(Type.String({ description: "Per-item subagent type override" })),
      }), { minItems: 1, maxItems: MAX_WORK_ITEMS }),
      agentType: Type.Optional(Type.String({ description: "Default subagent type (default: general-purpose)" })),
      model: Type.Optional(Type.String({ description: "Optional model override forwarded through protocol v2" })),
      maxTurns: Type.Optional(Type.Integer({ description: "Per-worker turn bound", minimum: 1, maximum: MAX_TURNS })),
      concurrency: Type.Optional(Type.Integer({ description: "Local worker capacity (default: 3)", minimum: 1, maximum: MAX_CONCURRENCY, default: 3 })),
      maxAttempts: Type.Optional(Type.Integer({ description: "Attempts per item after proved failures (default: 1)", minimum: 1, maximum: MAX_ATTEMPTS, default: 1 })),
    }),
    async execute(_toolCallId, params: CreateParams) {
      if (getScope() !== "session") return errorResult("Orchestration requires the default file-backed session scope; memory and project scopes are unsupported.");
      if (getPiLoopEnv() !== undefined) return errorResult("Orchestration is unavailable when PI_LOOP overrides storage; unset PI_LOOP and use session scope.");
      const actor = getActor();
      if (!actor) return errorResult("Orchestration requires an active session runtime.");
      const validationError = validateCreate(params);
      if (validationError) return errorResult(validationError);

      let probe: unknown;
      try {
        probe = await probeSubagents();
      } catch (error) {
        return errorResult(`Orchestration requires pi-subagents protocol v2: ${error instanceof Error ? error.message : String(error)}`);
      }
      if (protocolVersion(probe) !== 2) return errorResult("Orchestration requires pi-subagents protocol v2; no compatible provider replied.");

      const definition = definitionFrom(params);
      const entry = getStore().create({ type: "dynamic" }, definition.goal, {
        recurring: true,
        dynamic: { goal: definition.goal, awaitingUpdate: true, iteration: 0 },
        orchestration: { definition, owner: actor },
      });
      updateWidget();
      const message = [
        `Orchestration #${entry.id} created`,
        `${definition.work.length} work items · concurrency ${definition.concurrency}`,
        "Dispatch begins after the parent turn becomes idle. Use OrchestrationGet to inspect durable results.",
      ].join("\n");
      return textResult(message, {
        kind: "orchestration",
        action: "create",
        tone: "success",
        summary: `Orchestration #${entry.id} running · ${orchestrationProgressLabel(entry.orchestration!)}`,
        expanded: [`Goal: ${definition.goal}`, `Status: running`, `Progress: ${orchestrationProgressLabel(entry.orchestration!)}`, `Concurrency: ${definition.concurrency}`, `Attempts: ${definition.maxAttempts}`],
      });
    },
  });

  pi.registerTool({
    name: "OrchestrationGet",
    label: "OrchestrationGet",
    renderCall: renderToolCall("Orchestration", (args) => `inspect · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Inspect orchestration results.",
    parameters: Type.Object({
      id: Type.String({ description: "Orchestration loop ID" }),
      workId: Type.Optional(Type.String({ description: "Optional work item ID" })),
    }),
    execute(_toolCallId, params: { id: string; workId?: string }) {
      const entry = getStore().get(params.id);
      if (!entry?.orchestration) {
        const message = `Orchestration #${params.id} not found`;
        return Promise.resolve(textResult(message, {
          kind: "orchestration", action: "inspect", tone: "error", summary: message, expanded: ["Use LoopList to find orchestration IDs."],
        }));
      }
      const item = params.workId ? entry.orchestration.work.find((candidate) => candidate.id === params.workId) : undefined;
      if (params.workId && !item) {
        const message = `Work #${params.workId} not found in orchestration #${params.id}`;
        return Promise.resolve(textResult(message, {
          kind: "orchestration",
          action: "inspect",
          tone: "error",
          summary: message,
          expanded: orchestrationDisplayDetails(entry).expanded,
        }));
      }
      const details = orchestrationDisplayDetails(entry, item);
      const message = item
        ? orchestrationWorkText(entry, item)
        : orchestrationControllerText(entry);
      return Promise.resolve(textResult(message, details));
    },
  });
}
