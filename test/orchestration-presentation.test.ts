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
    expect(orchestrationProgressLabel(state)).toBe("0/2 complete · 0/2 in flight · 2 pending");
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

  it("E1: a listing row ends with the evidence held for the item: verify result, time and tokens", () => {
    const entry = createEntry();
    const [first, second] = entry.orchestration!.work;
    first!.status = "completed";
    first!.attemptCount = 1;
    first!.dispatches.push({
      dispatchId: "d", attempt: 1, ownerRuntimeId: "runtime", ownerGeneration: 1, status: "completed", requestedAt: 1, agentId: "a1", consumeStatus: "provider_owned", consumeAttempts: 0,
      usage: { durationMs: 421_000, tokens: { input: 160_000, output: 1_800, total: 161_800 } },
      verify: { passed: true, exitCode: 0, durationMs: 12 },
    });
    second!.status = "failed";
    second!.attemptCount = 1;
    second!.dispatches.push({ dispatchId: "e", attempt: 1, ownerRuntimeId: "runtime", ownerGeneration: 1, status: "failed", requestedAt: 1, consumeStatus: "none", consumeAttempts: 0, verify: { passed: false, exitCode: 1, durationMs: 9 } });
    const before = structuredClone(entry);
    const rows = orchestrationControllerText(entry).split("\n");
    // Existing fields keep their order; evidence is appended.
    expect(rows.at(-2)).toBe("#1 [complete] Explore · Inspect API compatibility · agent=a1 · attempts=1 · verify ok · 7m · 161800 tokens");
    expect(rows.at(-1)).toBe("#2 [failed] Plan · Review rollout risks · attempts=1 · verify failed (exit 1)");
    expect(entry).toEqual(before);
    // Control: an item with no evidence gets no evidence fields.
    expect(orchestrationControllerText(createEntry()).split("\n").at(-1)).toBe("#2 [pending] Plan · Review rollout risks");
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
    expect(orchestrationProgressLabel(state)).toBe(`0/2 complete · 1/2 in flight · 1 ${label} · 1 pending`);
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

  it("reports the aimd window instead of a fixed concurrency limit", () => {
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Paced batch", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "session", runtimeId: "runtime", generation: 1 },
        definition: { goal: "Paced batch", work: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }], pacing: "aimd", maxAttempts: 2 },
      },
    });
    const text = orchestrationControllerText(entry);
    expect(text).toContain("Limits: aimd window=3/3 losses=0 taskLosses=0 maxAttempts=2");
    expect(text).not.toContain("concurrency=");
  });
});

describe("pacing labels", () => {
  function pacedEntry() {
    const store = new LoopStore();
    return store.create({ type: "dynamic" }, "Paced batch", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "session", runtimeId: "runtime", generation: 1 },
        definition: { goal: "Paced batch", work: [{ prompt: "a" }, { prompt: "b" }, { prompt: "c" }, { prompt: "d" }], pacing: "aimd", maxAttempts: 2 },
      },
    });
  }

  it("shows ssthresh once a loss has set it below the ceiling", () => {
    const entry = pacedEntry();
    entry.orchestration!.window = { ...entry.orchestration!.window!, cwnd: 2, ssthresh: 2, losses: 1 };
    expect(orchestrationControllerText(entry)).toContain("Limits: aimd window=2/4 ssthresh=2 losses=1 taskLosses=0 maxAttempts=2");
  });

  it("omits ssthresh while it is still the ceiling", () => {
    expect(orchestrationControllerText(pacedEntry())).not.toContain("ssthresh=");
  });

  it("labels fixed pacing as fixed", () => {
    const store = new LoopStore();
    const entry = store.create({ type: "dynamic" }, "Fixed batch", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "session", runtimeId: "runtime", generation: 1 },
        definition: { goal: "Fixed batch", work: [{ prompt: "a" }, { prompt: "b" }], concurrency: 2, maxAttempts: 1 },
      },
    });
    expect(orchestrationControllerText(entry)).toContain("Limits: fixed concurrency=2 maxAttempts=1");
  });
});

describe("review regressions: attempts label", () => {
  it("D3: counts charged attempts and reports free congestion re-sends separately", () => {
    const entry = createEntry();
    const item = entry.orchestration!.work[0]!;
    item.attemptCount = 3;
    item.congestionRetries = 2;
    expect(orchestrationWorkText(entry, item)).toContain("Attempts: 1/2 (+2 congestion re-sends)");
    item.congestionRetries = undefined;
    item.attemptCount = 1;
    expect(orchestrationWorkText(entry, item)).toContain("Attempts: 1/2");
    expect(orchestrationWorkText(entry, item)).not.toContain("re-send");
  });
});

describe("in-flight work against capacity", () => {
  function reserve(entry: ReturnType<typeof createEntry>, index: number): void {
    const item = entry.orchestration!.work[index]!;
    item.status = "active";
    item.attemptCount = 1;
    item.dispatches.push({ dispatchId: `d${index}`, attempt: 1, ownerRuntimeId: "runtime", ownerGeneration: 1, status: "running", requestedAt: 1, consumeStatus: "none", consumeAttempts: 0 });
  }

  it("F1: an active fixed batch shows reserved work against its concurrency", () => {
    const entry = createEntry();
    expect(orchestrationProgressLabel(entry.orchestration!)).toBe("0/2 complete · 0/2 in flight · 2 pending");
    reserve(entry, 0);
    expect(orchestrationProgressLabel(entry.orchestration!)).toBe("0/2 complete · 1/2 in flight · 1 reported running · 1 pending");
  });

  it("F2: an aimd batch shows reserved work against the current window, not the ceiling", () => {
    const entry = createEntry();
    const state = entry.orchestration!;
    state.concurrency = 8;
    state.window = { mode: "aimd", cwnd: 1.6, ssthresh: 8, acks: 0, losses: 0, taskLosses: 0 };
    reserve(entry, 0);
    expect(orchestrationProgressLabel(state)).toContain("1/1 in flight");
    state.window.cwnd = 4.9;
    expect(orchestrationProgressLabel(state)).toContain("1/4 in flight");
  });

  it("F3: a controller that is no longer dispatching shows no capacity", () => {
    const entry = createEntry();
    const state = entry.orchestration!;
    state.status = "needs_attention";
    state.work[0]!.status = "failed";
    expect(orchestrationProgressLabel(state)).toBe("0/2 complete · 0 reserved · 1 pending · 1 failed");
    expect(orchestrationProgressLabel(state)).not.toContain("in flight");
  });

  it("F4: the count is a reservation, never a liveness claim, and rendering changes nothing", () => {
    const entry = createEntry();
    reserve(entry, 0);
    const before = structuredClone(entry);
    const text = orchestrationControllerText(entry);
    expect(text).toContain("In flight: local reservations against capacity; dispatch state is last reported, not proof of current execution.");
    expect(text).not.toMatch(/\d+ running\b/);
    expect(entry).toEqual(before);
  });
});
