import { describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import {
  formatOrchestrationInspection,
  orchestrationControllerText,
  orchestrationDisplayDetails,
  orchestrationProgressLabel,
  orchestrationStatusLabel,
  orchestrationTone,
  orchestrationWakeHeading,
  orchestrationWorkStatusLabel,
  orchestrationWorkText,
} from "../src/ui/orchestration-presentation.js";

function createEntry() {
  const store = new LoopStore();
  return store.create({ type: "dynamic" }, "Review release readiness", {
    recurring: true,
    orchestration: {
      owner: { sessionId: "session", runtimeId: "runtime", generation: 1 },
      definition: {
        goal: "Review release readiness",
        work: [
          { prompt: "Inspect API compatibility", agentType: "Explore" },
          { prompt: "Review rollout risks", agentType: "Plan" },
        ],
        concurrency: 2,
        maxAttempts: 2,
      },
    },
  });
}

describe("orchestration presentation", () => {
  it("uses human status and progress labels", () => {
    const entry = createEntry();
    const state = entry.orchestration!;

    expect(orchestrationStatusLabel(state.status)).toBe("active");
    expect(orchestrationWorkStatusLabel(state.work[0]!.status)).toBe("pending");
    expect(orchestrationProgressLabel(state)).toBe("0/2 complete · 0 reserved · 2 pending");
    expect(orchestrationTone(state)).toBe("info");
    expect(orchestrationWakeHeading("1", state)).toBe("[pi-loop] Orchestration #1 active.");
  });

  it("makes failures and uncertainty prominent without leaking reducer vocabulary", () => {
    const entry = createEntry();
    const state = entry.orchestration!;
    state.status = "needs_attention";
    state.work[0]!.status = "failed";
    state.work[1]!.status = "uncertain";

    const text = orchestrationControllerText(entry);
    expect(text).toContain("Orchestration #1 · needs attention");
    expect(text).toContain("0/2 complete · 0 reserved · 1 failed · 1 uncertain");
    expect(text).not.toContain("needs_attention");
    expect(orchestrationTone(state)).toBe("warning");
  });

  it.each(["spawning", "queued", "running"] as const)("separates reservations from %s observations", (status) => {
    const entry = createEntry();
    const state = entry.orchestration!;
    const item = state.work[0]!;
    item.status = "active";
    item.attemptCount = 1;
    item.dispatches.push({ dispatchId: "d", attempt: 1, ownerRuntimeId: "runtime", ownerGeneration: 1, status, requestedAt: 1, consumeStatus: "none", consumeAttempts: 0 });
    const before = structuredClone(entry);
    const label = status === "spawning" ? "starting" : status === "running" ? "reported running" : "queued";
    expect(orchestrationProgressLabel(state)).toBe(`0/2 complete · 1 reserved · 1 ${label} · 1 pending`);
    expect(orchestrationWorkText(entry, item)).toContain("Work #1 · reserved");
    expect(orchestrationWorkText(entry, item)).toContain(`Dispatch 1: ${label}`);
    expect(orchestrationControllerText(entry)).toContain("last reported");
    expect(entry).toEqual(before);
  });

  it("presents provider-owned output as ownership rather than consume state", () => {
    const entry = createEntry();
    const state = entry.orchestration!;
    const item = state.work[0]!;
    item.status = "completed";
    item.attemptCount = 1;
    item.dispatches.push({
      dispatchId: "dispatch-1",
      attempt: 1,
      ownerRuntimeId: "runtime",
      ownerGeneration: 1,
      status: "completed",
      requestedAt: 1,
      settledAt: 2,
      agentId: "agent-1",
      result: "API is compatible",
      consumeStatus: "provider_owned",
      consumeAttempts: 0,
    });

    const text = orchestrationWorkText(entry, item);
    expect(text).toContain("Work #1 · complete");
    expect(text).toContain("Output: provider-owned");
    expect(text).not.toContain("Consume:");
  });

  it("bounds command inspection for large batches", () => {
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Large review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "session", runtimeId: "runtime", generation: 1 },
        definition: {
          goal: "Large review",
          work: Array.from({ length: 32 }, (_, index) => ({ prompt: `Inspect subsystem ${index + 1}` })),
        },
      },
    });

    const lines = formatOrchestrationInspection(entry).split("\n");
    expect(lines.length).toBeLessThanOrEqual(11);
    expect(lines.at(-1)).toContain("more");
  });

  it("builds bounded, status-aware tool and command details", () => {
    const entry = createEntry();
    entry.orchestration!.status = "completed";
    for (const item of entry.orchestration!.work) item.status = "completed";

    const details = orchestrationDisplayDetails(entry);
    expect(details).toMatchObject({
      kind: "orchestration",
      tone: "success",
      summary: "Orchestration #1 complete · 2/2 complete · 0 reserved",
    });
    expect(details.expanded!.length).toBeLessThanOrEqual(9);

    const inspection = formatOrchestrationInspection(entry);
    expect(inspection).toContain("Orchestration #1 · complete");
    expect(inspection).toContain("Progress: 2/2 complete · 0 reserved");
    expect(inspection).not.toContain('Trigger: {"type":"dynamic"}');
  });
});
