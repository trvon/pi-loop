import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { type TSchema, Type } from "typebox";
import { textResult } from "./tool-result.js";

const DESCRIPTIONS = new Map<string, string>([
  ["LoopCreate", "Create scheduled/event wakes or an unphased goal; not ordered work."],
  ["LoopList", "Inspect loops/workflows, current work, revisions and leases."],
  ["LoopUpdate", "Persist/continue an unphased goal; finish only when done."],
  ["LoopDelete", "Cancel or pause a loop; not routine iteration completion."],
  ["WorkflowCreate", "Create ordered/branching/rework goals with embedded workflow work."],
  ["WorkflowClaim", "Claim/renew current workflow work; no bearer token."],
  ["WorkflowRevise", "Revise workflow via typed CAS; reissue stale active work."],
  ["WorkflowTransition", "Advance owned workflow work; paused terminal outcomes need typed blocker admission."],
  ["OrchestrationCreate", "Run an explicit independent batch in session LoopStore."],
  ["OrchestrationGet", "Inspect batch evidence; not workflow/task ownership."],
  ["MonitorCreate", "Run a background command; timeout measures inactivity."],
  ["MonitorList", "Inspect process-local monitors and buffered output."],
  ["MonitorUpdate", "Record structured progress for a running monitor."],
  ["MonitorStop", "Stop a running monitor."],
  ["TaskCreate", "Create independent backlog items; no autonomous worker."],
  ["TaskList", "List standalone tasks, not workflow work."],
  ["TaskGet", "Read full standalone task context."],
  ["TaskClaim", "Claim/renew standalone work; keep returned claimId."],
  ["TaskHeartbeat", "Renew an owned standalone task claim."],
  ["TaskUpdate", "Update standalone tasks; claimed completion/closure requires claimId."],
  ["TaskDelete", "Delete standalone task; live claims require claimId."],
]);

export const COMPACT_GUIDE = `pi-loop compact:
Choose WorkflowCreate for one goal with ordered phases/outcomes/rework/handoff; TaskCreate for independent backlog; LoopCreate for recurring/event wakes or unphased self-paced work. Backlog-only requests do not authorize workers.
Read LoopHelp({tool:"Name"}) before unfamiliar mutations; LoopHelp({}) indexes active owned tools. In native code mode use tools.LoopHelp(...). Help never executes or activates work.
Claim standalone work with TaskClaim; retain claimId for heartbeat/completion. Unowned workflow work requires WorkflowClaim; workflow leases have no bearer token. Never pass claimId to workflow tools.
Persist unfinished progress in TaskUpdate/LoopUpdate; workflow plans/phases in WorkflowRevise/WorkflowTransition. Continue while actionable; LoopDelete only for cancellation or a satisfied stop condition.
Polling needs bounded maxFires; observation-only loops need readOnly. Paused terminal workflow outcomes need typed trusted blocker admission; machine evidence never grants user authority.`;

const SCHEMA_FIELDS = [
  "items", "additionalItems", "contains", "additionalProperties", "unevaluatedProperties", "unevaluatedItems",
  "propertyNames", "not", "if", "then", "else", "contentSchema",
];
const SCHEMA_ARRAYS = ["allOf", "anyOf", "oneOf", "prefixItems"];
const SCHEMA_MAPS = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas", "dependencies"];

function mapSchemas<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const fields = Object.getOwnPropertyDescriptors(value);
  for (const field of Object.values(fields)) {
    if ("value" in field) field.value = compactSchema(field.value);
  }
  return Object.create(Object.getPrototypeOf(value), fields);
}

function compactSchema<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  // Clone schema nodes, not arbitrary instance data such as enum/default/example objects.
  // Descriptors retain TypeBox symbols and support frozen schemas without mutating them.
  const fields = Object.getOwnPropertyDescriptors(value);
  delete fields.description;
  for (const key of SCHEMA_FIELDS) {
    const field = fields[key];
    if (field && "value" in field) {
      field.value = Array.isArray(field.value) ? field.value.map(compactSchema) : compactSchema(field.value);
    }
  }
  for (const key of SCHEMA_ARRAYS) {
    const field = fields[key];
    if (field && "value" in field && Array.isArray(field.value)) field.value = field.value.map(compactSchema);
  }
  for (const key of SCHEMA_MAPS) {
    const field = fields[key];
    if (field && "value" in field) field.value = mapSchemas(field.value);
  }
  return Object.create(Object.getPrototypeOf(value), fields);
}

export function compactParameterSchema<T extends TSchema>(schema: T): T {
  return compactSchema(schema) as T;
}

type Contract = Pick<ToolDefinition, "name" | "description" | "parameters" | "promptSnippet" | "promptGuidelines" | "outputSchema" | "annotations" | "exposure">;

export function createToolContextRegistration(pi: ExtensionAPI, profile = process.env.PI_LOOP_CONTEXT): ExtensionAPI["registerTool"] {
  if (profile !== "compact") return definition => pi.registerTool(definition);

  const contracts = new Map<string, Contract>();
  pi.registerTool({
    name: "LoopHelp",
    label: "LoopHelp",
    description: "Read original pi-loop contracts; omit tool for active index. Never executes or activates tools.",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    parameters: Type.Object({ tool: Type.Optional(Type.String({ maxLength: 64 })) }),
    async execute(_id, { tool }) {
      const active = new Set(pi.getActiveTools());
      if (tool !== undefined) {
        const contract = active.has(tool) ? contracts.get(tool) : undefined;
        if (!contract) return textResult("No active pi-loop-owned contract. Use LoopHelp({}) for the available index.", {
          kind: "loop", action: "help", tone: "error", summary: "Contract unavailable",
        });
        return textResult(JSON.stringify(contract));
      }
      return textResult(JSON.stringify({ guide: COMPACT_GUIDE, tools: [...contracts.keys()].filter(name => active.has(name)) }));
    },
  });

  pi.on("before_agent_start", event => {
    if (event.systemPromptOptions?.sections) {
      event.systemPromptOptions.sections.pi_loop = COMPACT_GUIDE;
      return;
    }
    // Older hosts expose only the rendered-prompt hook. Do not drop the safety guide.
    return { systemPrompt: `${event.systemPrompt}\n\n${COMPACT_GUIDE}` };
  });

  return definition => {
    const { name, description, parameters, promptSnippet, promptGuidelines, outputSchema, annotations, exposure } = definition;
    pi.registerTool({
      ...definition,
      description: DESCRIPTIONS.get(name) ?? description,
      parameters: compactParameterSchema(parameters),
      promptSnippet: undefined,
      promptGuidelines: undefined,
    });
    contracts.set(name, { name, description, parameters, promptSnippet, promptGuidelines, outputSchema, annotations, exposure });
  };
}
