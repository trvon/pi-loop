import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopScope } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { registerSubagentOrchestrationTools } from "../src/tools/subagent-orchestration-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup(options: { scope?: LoopScope; env?: string; protocol?: number } = {}) {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore();
  const probeSubagents = vi.fn(async () => options.protocol === undefined ? { version: 2 } : { version: options.protocol });
  registerSubagentOrchestrationTools({
    pi,
    getStore: () => store,
    getScope: () => options.scope ?? "session",
    getPiLoopEnv: () => options.env,
    getActor: () => ({ sessionId: "session-a", runtimeId: "runtime-a", generation: 1 }),
    probeSubagents,
    updateWidget: vi.fn(),
  });
  const result = async (name: string, args: unknown) => toolMap.get(name)!.execute!("call", args);
  const text = async (name: string, args: unknown) => (await result(name, args)).content[0].text as string;
  return { store, toolMap, probeSubagents, result, text };
}

describe("subagent orchestration tools", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("creates a finite session-scoped batch without arming a second scheduler", async () => {
    const out = await h.text("OrchestrationCreate", {
      goal: "Review release readiness",
      work: [
        { prompt: "Inspect API compatibility", agentType: "Explore" },
        { prompt: "Review rollout risks", agentType: "Plan" },
      ],
      concurrency: 2,
      maxAttempts: 2,
      model: "test/model",
      maxTurns: 8,
    });

    expect(out).toContain("Orchestration #1 created");
    expect(out).toContain("2 work items · concurrency 2");
    expect(h.probeSubagents).toHaveBeenCalledTimes(1);
    expect(h.store.get("1")).toMatchObject({
      trigger: { type: "dynamic" },
      recurring: true,
      dynamic: { awaitingUpdate: true },
      orchestration: {
        status: "active",
        work: [{ id: "1", status: "pending" }, { id: "2", status: "pending" }],
      },
    });
  });

  it.each([
    ["memory", undefined, "requires the default file-backed session scope"],
    ["project", undefined, "requires the default file-backed session scope"],
    ["session", "off", "unavailable when PI_LOOP overrides storage"],
    ["session", "/tmp/loops.json", "unavailable when PI_LOOP overrides storage"],
  ] as const)("rejects unsupported storage scope %s/%s before probing", async (scope, env, message) => {
    h = setup({ scope, env });

    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }] })).toContain(message);
    expect(h.probeSubagents).not.toHaveBeenCalled();
    expect(h.store.list()).toHaveLength(0);
  });

  it("requires pi-subagents protocol v2 before persisting", async () => {
    h = setup({ protocol: 1 });

    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }] })).toContain("requires pi-subagents protocol v2");
    expect(h.store.list()).toHaveLength(0);
  });

  it("bounds work, concurrency, attempts, turns, and serialized input", async () => {
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [] })).toContain("between 1 and 32 work items");
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], concurrency: 9 })).toContain("concurrency must be between 1 and 8");
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], maxAttempts: 4 })).toContain("maxAttempts must be between 1 and 3");
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], maxTurns: 0 })).toContain("maxTurns must be between 1 and 100");
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "x".repeat(20_000) }] })).toContain("work prompt exceeds");
    expect(h.store.list()).toHaveLength(0);
  });

  it("retrieves bounded controller and per-work evidence", async () => {
    await h.text("OrchestrationCreate", {
      goal: "Review release readiness",
      work: [{ prompt: "Inspect API compatibility", agentType: "Explore" }],
    });

    const summary = await h.text("OrchestrationGet", { id: "1" });
    expect(summary).toContain("Orchestration #1 · active");
    expect(summary).toContain("pending=1");
    expect(summary).toContain("#1 [pending] Explore · Inspect API compatibility");

    let state = h.store.get("1")!.orchestration!;
    h.store.mutateOrchestration("1", {
      type: "dispatch_requested",
      at: 10,
      expected: { revision: state.revision, ownerRuntimeId: "runtime-a", generation: 1 },
      workId: "1",
      dispatchId: "dispatch-1",
    });
    state = h.store.get("1")!.orchestration!;
    h.store.mutateOrchestration("1", {
      type: "dispatch_bound",
      at: 11,
      expected: { revision: state.revision, ownerRuntimeId: "runtime-a", generation: 1 },
      workId: "1",
      dispatchId: "dispatch-1",
      agentId: "agent-1",
    });
    state = h.store.get("1")!.orchestration!;
    h.store.mutateOrchestration("1", {
      type: "dispatch_settled",
      at: 12,
      expected: { revision: state.revision, ownerRuntimeId: "runtime-a", generation: 1 },
      agentId: "agent-1",
      outcome: "completed",
      result: "API is compatible",
    });

    const work = await h.text("OrchestrationGet", { id: "1", workId: "1" });
    expect(work).toContain("Work #1 · completed");
    expect(work).toContain("Prompt: Inspect API compatibility");
    expect(work).toContain("Dispatch 1: completed · agent=agent-1");
    expect(work).toContain("Result: API is compatible");
    expect(work).toContain("Consume: pending");
  });

  it("reports missing controllers and work without mutation", async () => {
    expect(await h.text("OrchestrationGet", { id: "404" })).toContain("Orchestration #404 not found");
    await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }] });
    expect(await h.text("OrchestrationGet", { id: "1", workId: "404" })).toContain("Work #404 not found");
  });

  it("renders compact create and inspect calls", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    const create = (h.toolMap.get("OrchestrationCreate") as any).renderCall({ goal: "Review readiness" }, theme);
    const inspect = (h.toolMap.get("OrchestrationGet") as any).renderCall({ id: "7" }, theme);

    expect(create.render(80).join("\n")).toContain("Orchestration create · Review readiness");
    expect(inspect.render(80).join("\n")).toContain("Orchestration inspect · #7");
  });
});
