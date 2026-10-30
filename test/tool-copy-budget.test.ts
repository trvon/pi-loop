import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BUDGET_FIELDS, checkToolContextBudget, type ToolContextBudget } from "../benchmarks/tool-context-budget.js";
import { toolCost } from "../benchmarks/tool-context-report.js";
import extension from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

const BASELINE_TOOL_COPY_CHARS = 15_400;
const MAX_TOOL_COPY_CHARS = Math.floor(BASELINE_TOOL_COPY_CHARS / 2);
const contextBudget: ToolContextBudget = JSON.parse(readFileSync(new URL("./fixtures/tool-context-budget.json", import.meta.url), "utf8"));

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("registered tool copy budget", () => {
  it("keeps agent-facing descriptions below half the audited baseline", async () => {
    const { pi, toolMap, extensionHandlers } = createMockPi();
    extension(pi);
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => "copy-budget-session" },
    };
    for (const handler of extensionHandlers.get("turn_start") ?? []) await handler(null, ctx);
    await vi.advanceTimersByTimeAsync(6_100);

    const costs = [...toolMap.values()].map(tool => toolCost({
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters as Tool["parameters"],
    }));
    expect(checkToolContextBudget(costs, contextBudget)).toEqual([]);
    const before = structuredClone(costs);
    for (const field of BUDGET_FIELDS) {
      const inflated = structuredClone(costs);
      const target = inflated.find(cost => cost.name === "WorkflowRevise");
      if (!target) throw new Error("Missing WorkflowRevise budget control");
      target[field].bytes += contextBudget.limits.total[field] + 1;
      expect(checkToolContextBudget(inflated, contextBudget)).toEqual(expect.arrayContaining([
        expect.stringContaining(`WorkflowRevise.${field}:`),
        expect.stringContaining(`total.${field}:`),
      ]));
    }
    expect(costs).toEqual(before);

    const copy = [...toolMap.values()].map((tool) => {
      const description = typeof tool.description === "string" ? tool.description : "";
      const guidelines = Array.isArray(tool.promptGuidelines) ? tool.promptGuidelines.join("\n") : "";
      return `${description}\n${guidelines}`;
    }).join("\n");

    expect(copy.length).toBeLessThanOrEqual(MAX_TOOL_COPY_CHARS);
    for (const required of [
      "claimId",
      "taskBacklog",
      "nextInterval",
      "triggerType",
      "onDone",
      "WorkflowTransition uses id, outcome, and optional evidence",
      "session LoopStore orchestration",
      "ordered phases, conditional outcomes, rework, or durable handoff",
      "independently completable backlog items",
      "Persist in the correct owner: TaskUpdate for unfinished standalone tasks",
    ]) {
      expect(copy).toContain(required);
    }
    expect(toolMap.has("WorkflowList")).toBe(false);
  });

  it("rejects missing, negative, fractional and non-finite ceilings instead of skipping their checks", () => {
    for (const value of [-1, 0.5, NaN, Infinity]) {
      const invalid = structuredClone(contextBudget);
      invalid.limits.total.parameters = value;
      expect(checkToolContextBudget([], invalid)).toContain("Invalid budget limit: total.parameters");
    }
    const missing = structuredClone(contextBudget);
    const workflow = missing.limits.tools.WorkflowRevise;
    if (!workflow) throw new Error("Missing WorkflowRevise budget control");
    Reflect.deleteProperty(workflow, "parameterDescriptions");
    expect(checkToolContextBudget([], missing)).toContain("Invalid budget limit: WorkflowRevise.parameterDescriptions");
  });

  it("catches schema-only and parameter-copy-only inflation even when top-level tool copy is unchanged", () => {
    const make = (parameters: Tool["parameters"]) => toolCost({ name: "Fixture", description: "short", parameters });
    const original = make({ type: "object", properties: { value: { type: "string", description: "short" } } });
    const baseline = Object.fromEntries(BUDGET_FIELDS.map(field => [field, original[field].bytes])) as ToolContextBudget["limits"]["total"];
    const budget: ToolContextBudget = { baseline: { Fixture: baseline }, limits: { total: baseline, tools: { Fixture: baseline } } };
    expect(checkToolContextBudget([original], budget)).toEqual([]);
    const schemaOnly = make({ type: "object", properties: { value: { type: "string", description: "short", enum: ["x".repeat(2000)] } } });
    const copyOnly = make({ type: "object", properties: { value: { type: "string", description: "é😀".repeat(1000) } } });
    expect(schemaOnly.description).toEqual(original.description);
    expect(schemaOnly.parameterDescriptions).toEqual(original.parameterDescriptions);
    expect(checkToolContextBudget([schemaOnly], budget)).toContainEqual(expect.stringContaining("Fixture.parameters:"));
    expect(copyOnly.description).toEqual(original.description);
    expect(checkToolContextBudget([copyOnly], budget)).toContainEqual(expect.stringContaining("Fixture.parameterDescriptions:"));
    expect(checkToolContextBudget([], budget)).toEqual(["Missing budgeted tool: Fixture"]);
    expect(checkToolContextBudget([original, original], budget)).toContain("Duplicate tool: Fixture");
    expect(checkToolContextBudget([{ ...original, name: "NewTool" }], budget)).toContain("Unbudgeted tool: NewTool");
    expect(checkToolContextBudget([{ ...original, name: "toString" }], budget)).toContain("Unbudgeted tool: toString");
  });
});
