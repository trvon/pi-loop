import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { createMockPi } from "./helpers/mock-pi.js";

const BASELINE_TOOL_COPY_CHARS = 15_400;
const MAX_TOOL_COPY_CHARS = Math.floor(BASELINE_TOOL_COPY_CHARS / 2);

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
      "ordered phases, conditional outcomes, rework, or durable handoff",
      "independently completable backlog items",
      "Persist in the correct owner: TaskUpdate for unfinished standalone tasks",
    ]) {
      expect(copy).toContain(required);
    }
    expect(toolMap.has("WorkflowList")).toBe(false);
  });
});
