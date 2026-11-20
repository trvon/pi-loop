import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LoopScope } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { registerSubagentOrchestrationTools, resolveDefaultPacing } from "../src/tools/subagent-orchestration-tools.js";
import type { OrchestrationPacing } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup(options: { scope?: LoopScope; env?: string; protocol?: number; defaultPacing?: OrchestrationPacing } = {}) {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore();
  const probeSubagents = vi.fn(async () => options.protocol === undefined || options.protocol === 2);
  registerSubagentOrchestrationTools({
    pi,
    getStore: () => store,
    getScope: () => options.scope ?? "session",
    getPiLoopEnv: () => options.env,
    getActor: () => ({ sessionId: "session-a", runtimeId: "runtime-a", generation: 1 }),
    probeSubagents,
    updateWidget: vi.fn(),
    ...(options.defaultPacing ? { defaultPacing: options.defaultPacing } : {}),
  });
  const result = async (name: string, args: unknown) => toolMap.get(name)!.execute!("call", args);
  const text = async (name: string, args: unknown) => (await result(name, args)).content[0].text as string;
  return { store, toolMap, probeSubagents, result, text };
}

function setupFields() {
  return Object.keys((setup().toolMap.get("OrchestrationCreate")!.parameters as { properties: Record<string, unknown> }).properties);
}

describe("subagent orchestration tools", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("AUD-02: creation rejects a provider probe completed after session rebinding", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_000);
    try {
      const { pi, toolMap } = createMockPi();
      const a = new LoopStore();
      const b = new LoopStore();
      let store = a;
      let actor = { sessionId: "session-a", runtimeId: "runtime-a", generation: 1 };
      let entered!: () => void;
      let release!: (compatible: boolean) => void;
      const probeEntered = new Promise<void>((resolve) => { entered = resolve; });
      const probeReply = new Promise<boolean>((resolve) => { release = resolve; });
      registerSubagentOrchestrationTools({
        pi,
        getStore: () => store,
        getScope: () => "session",
        getPiLoopEnv: () => undefined,
        getActor: () => actor,
        probeSubagents: () => { entered(); return probeReply; },
        updateWidget: vi.fn(),
      });
      const creating = toolMap.get("OrchestrationCreate")!.execute!("create", { goal: "A review", work: [{ prompt: "Inspect A" }] });
      await probeEntered;
      store = b;
      actor = { sessionId: "session-b", runtimeId: "runtime-b", generation: 2 };
      release(true);
      const result = await creating;

      expect.soft(a.list()).toEqual([]);
      expect.soft(b.list()).toEqual([]);
      expect.soft(result.details).toMatchObject({ tone: "error" });
    } finally {
      clock.mockRestore();
    }
  });

  it("creates a finite session-scoped batch without arming a second scheduler", async () => {
    const created = await h.result("OrchestrationCreate", {
      goal: "Review release readiness",
      work: [
        { prompt: "Inspect API compatibility", agentType: "Explore" },
        { prompt: "Review rollout risks", agentType: "Plan" },
      ],
      concurrency: 2,
      maxAttempts: 2,
      model: "test/model",
      maxTurns: 8,
      expiresIn: "14d",
    });
    const out = created.content[0].text as string;

    expect(out).toContain("Orchestration #1 created");
    expect(out).toContain("2 work items · fixed concurrency 2");
    expect(created.details).toMatchObject({
      kind: "orchestration",
      tone: "success",
      summary: "Orchestration #1 active · 0/2 complete · 0/2 in flight · 2 pending",
    });
    expect(h.probeSubagents).toHaveBeenCalledTimes(1);
    expect(h.store.get("1")!.expiresAt - h.store.get("1")!.createdAt).toBe(14 * 24 * 60 * 60 * 1000);
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

  it("creates an explicit aimd batch with per-item verifiers", async () => {
    const out = await h.text("OrchestrationCreate", {
      goal: "Implement helpers",
      work: [{ prompt: "Add sum()", verify: "node --test sum.test.js" }, { prompt: "Add mul()", verify: " npm test " }],
      concurrency: 2,
      pacing: "aimd",
    });

    expect(out).toContain("2 work items · aimd window 2-2");
    expect(h.store.get("1")?.orchestration).toMatchObject({
      concurrency: 2,
      window: { mode: "aimd", cwnd: 2, ssthresh: 2 },
      work: [{ verify: "node --test sum.test.js" }, { verify: "npm test" }],
    });
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], pacing: "cubic" })).toContain("pacing must be fixed or aimd");
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect", verify: " " }] })).toContain("verify must contain");
    expect(h.store.list()).toHaveLength(1);
  });

  it("N3: stores a tidy label per item and shows it in place of the prompt snippet", async () => {
    await h.text("OrchestrationCreate", {
      goal: "Audit",
      work: [
        { prompt: "Inspect the sandbox profile in depth", label: "  seat\u001b[31mbelt\n " },
        { prompt: "Inspect paths", label: "   " },
        { prompt: "Inspect services", label: "s".repeat(90) },
        { prompt: "Inspect tests" },
      ],
    });
    const work = h.store.get("1")!.orchestration!.work;
    // Obvious mistakes are recovered, not rejected: controls collapse, blanks drop, long names clip.
    expect(work.map((item) => item.label)).toEqual(["seat [31mbelt", undefined, "s".repeat(40), undefined]);
    const listing = await h.text("OrchestrationGet", { id: "1" });
    expect(listing).toContain("#1 [pending] general-purpose · seat [31mbelt");
    expect(listing).not.toContain("Inspect the sandbox profile");
    // Control: an unlabelled item keeps its prompt snippet.
    expect(listing).toContain("#4 [pending] general-purpose · Inspect tests");
    const detail = await h.text("OrchestrationGet", { id: "1", workId: "1" });
    expect(detail).toContain("Label: seat [31mbelt");
    expect(detail).toContain("Prompt: Inspect the sandbox profile in depth");
    expect(await h.text("OrchestrationGet", { id: "1", workId: "4" })).not.toContain("Label:");
  });

  describe("default pacing", () => {
    it("paces a batch with aimd when neither pacing nor concurrency is given", async () => {
      h = setup();
      const out = await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "A" }, { prompt: "B" }, { prompt: "C" }, { prompt: "D" }] });
      expect(out).toContain("4 work items · aimd window 3-4");
      expect(h.store.get("1")?.orchestration).toMatchObject({ concurrency: 4, window: { mode: "aimd", cwnd: 3, ssthresh: 4 } });
    });

    it("reports the stored aimd window, capped at eight for unverified work", async () => {
      h = setup();
      const work = Array.from({ length: 20 }, (_, index) => ({ prompt: `task ${index + 1}` }));
      expect(await h.text("OrchestrationCreate", { goal: "Review", work })).toContain("20 work items · aimd window 3-8");
      const verified = work.map((item) => ({ ...item, verify: "npm test" }));
      expect(await h.text("OrchestrationCreate", { goal: "Review", work: verified })).toContain("20 work items · aimd window 3-20");
    });

    it("L7: seeds a new aimd batch from the window the session's last batch learned", async () => {
      h = setup();
      const work = [{ prompt: "A" }, { prompt: "B" }, { prompt: "C" }, { prompt: "D" }];
      await h.text("OrchestrationCreate", { goal: "First", work });
      const expected = () => {
        const state = h.store.get("1")!.orchestration!;
        return { revision: state.revision, ownerRuntimeId: "runtime-a", generation: 1 };
      };
      h.store.mutateOrchestration("1", { type: "dispatch_requested", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d1" });
      h.store.mutateOrchestration("1", { type: "dispatch_bound", at: Date.now(), expected: expected(), workId: "1", dispatchId: "d1", agentId: "a1" });
      h.store.mutateOrchestration("1", { type: "dispatch_settled", at: Date.now(), expected: expected(), agentId: "a1", outcome: "failed", error: "503 overloaded", usage: { toolUses: 2 } });
      expect(h.store.get("1")?.orchestration?.window).toMatchObject({ cwnd: 1, ssthresh: 1 });
      const out = await h.text("OrchestrationCreate", { goal: "Second", work });
      expect(out).toContain("aimd window 1-4 (learned from orchestration #1)");
      expect(h.store.get("2")?.orchestration?.window).toMatchObject({ cwnd: 1, ssthresh: 1 });
    });

    it("treats an explicit concurrency as a request for fixed pacing", async () => {
      h = setup();
      await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "A" }], concurrency: 2 });
      const stored = h.store.get("1")?.orchestration;
      expect(stored).toMatchObject({ concurrency: 2 });
      expect(stored?.window).toBeUndefined();
    });

    it("lets explicit pacing win over the configured default", async () => {
      h = setup({ defaultPacing: "fixed" });
      await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "A" }] });
      expect(h.store.get("1")?.orchestration?.window).toBeUndefined();
      expect(h.store.get("1")?.orchestration?.concurrency).toBe(3);
      await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "A" }], pacing: "aimd" });
      expect(h.store.get("2")?.orchestration?.window?.mode).toBe("aimd");
    });

    it("resolves PI_LOOP_PACING and rejects unknown values", () => {
      expect(resolveDefaultPacing(undefined)).toBe("aimd");
      expect(resolveDefaultPacing("")).toBe("aimd");
      expect(resolveDefaultPacing(" Fixed ")).toBe("fixed");
      expect(resolveDefaultPacing("aimd")).toBe("aimd");
      expect(() => resolveDefaultPacing("cubic")).toThrow("Invalid PI_LOOP_PACING");
    });
  });

  it("ignores concurrency under aimd instead of rejecting values above the fixed-pacing limit", async () => {
    const out = await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], pacing: "aimd", concurrency: 9 });
    expect(out).toContain("Orchestration #1 created");
    expect(h.store.get("1")?.orchestration?.concurrency).toBe(1);
    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], concurrency: 9 })).toContain("concurrency must be between 1 and 8");
  });

  it("keeps fixed pacing without a persisted window or verifier", async () => {
    await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }], pacing: "fixed" });
    expect(h.store.get("1")?.orchestration?.window).toBeUndefined();
    expect(h.store.get("1")?.orchestration?.work[0]?.verify).toBeUndefined();
  });

  it("requires a compatible provider before persisting", async () => {
    h = setup({ protocol: 1 });

    expect(await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }] })).toContain("requires a compatible subagent provider");
    expect(h.store.list()).toHaveLength(0);
  });

  describe("provider traits", () => {
    function withProvider(provider: { name: string; defaultAgentType: string; supportsMaxTurns: boolean }, compatible = true) {
      const { pi, toolMap } = createMockPi();
      const store = new LoopStore();
      registerSubagentOrchestrationTools({
        pi,
        getStore: () => store,
        getScope: () => "session",
        getPiLoopEnv: () => undefined,
        getActor: () => ({ sessionId: "session-a", runtimeId: "runtime-a", generation: 1 }),
        probeSubagents: async () => compatible,
        getProvider: () => provider,
        updateWidget: vi.fn(),
      });
      const text = async (args: unknown) => (await toolMap.get("OrchestrationCreate")!.execute!("call", args)).content[0].text as string;
      const fields = Object.keys((toolMap.get("OrchestrationCreate")!.parameters as { properties: Record<string, unknown> }).properties);
      return { store, text, fields };
    }
    const v1 = { name: "pi-subagents (RPC v1)", defaultAgentType: "worker", supportsMaxTurns: false };

    it("T1: accepts an adapter's own compatibility answer", async () => {
      const ok = withProvider(v1);
      expect(await ok.text({ goal: "Review", work: [{ prompt: "Inspect" }] })).toContain("Orchestration #1 created");
      const absent = withProvider(v1, false);
      expect(await absent.text({ goal: "Review", work: [{ prompt: "Inspect" }] })).toContain("requires a compatible subagent provider");
      expect(absent.store.list()).toHaveLength(0);
    });

    it("T2: work without an agent type gets the provider's default, and an explicit type is kept", async () => {
      const h1 = withProvider(v1);
      await h1.text({ goal: "Review", work: [{ prompt: "A" }, { prompt: "B", agentType: "reviewer" }] });
      expect(h1.store.list()[0]?.orchestration?.work.map((item) => item.agentType)).toEqual(["worker", "reviewer"]);
      const h2 = withProvider(v1);
      await h2.text({ goal: "Review", agentType: "scout", work: [{ prompt: "A" }] });
      expect(h2.store.list()[0]?.orchestration?.work[0]?.agentType).toBe("scout");
    });

    it("T3: rejects maxTurns for a provider with no turn limit, naming the next action, without persisting", async () => {
      const h1 = withProvider(v1);
      const out = await h1.text({ goal: "Review", work: [{ prompt: "A" }], maxTurns: 20 });
      expect(out).toContain("maxTurns is not supported by pi-subagents (RPC v1)");
      expect(out).toContain("Omit maxTurns");
      expect(h1.store.list()).toHaveLength(0);
      // Control: a provider with turn limits still accepts it.
      const h2 = withProvider({ name: "@tintinweb/pi-subagents (protocol v2)", defaultAgentType: "general-purpose", supportsMaxTurns: true });
      expect(await h2.text({ goal: "Review", work: [{ prompt: "A" }], maxTurns: 20 })).toContain("Orchestration #1 created");
      expect(h2.store.list()[0]?.orchestration?.maxTurns).toBe(20);
    });

    it("T6: the schema offers maxTurns only when the provider has a turn limit", () => {
      expect(withProvider(v1).fields).not.toContain("maxTurns");
      // Controls: a provider with turn limits, and no declared traits, keep the field; nothing else is dropped.
      const v2 = withProvider({ name: "@tintinweb/pi-subagents (protocol v2)", defaultAgentType: "general-purpose", supportsMaxTurns: true });
      expect(v2.fields).toContain("maxTurns");
      expect(setupFields()).toContain("maxTurns");
      expect(v2.fields.filter((field) => field !== "maxTurns")).toEqual(withProvider(v1).fields);
    });

    it("T7: a multi-item batch held to one worker says it is serial and how to lift that", async () => {
      const serial = "Serial: one worker at a time. Omit `concurrency` if the items can safely run together.";
      const h1 = withProvider(v1);
      expect(await h1.text({ goal: "Review", concurrency: 1, work: [{ prompt: "A" }, { prompt: "B" }] })).toContain(serial);
      // Controls: one item, more than one worker, and adaptive pacing are not serial batches.
      expect(await withProvider(v1).text({ goal: "Review", concurrency: 1, work: [{ prompt: "A" }] })).not.toContain("Serial");
      expect(await withProvider(v1).text({ goal: "Review", concurrency: 2, work: [{ prompt: "A" }, { prompt: "B" }] })).not.toContain("Serial");
      expect(await withProvider(v1).text({ goal: "Review", work: [{ prompt: "A" }, { prompt: "B" }] })).not.toContain("Serial");
      // The stored batch is unchanged by the note.
      expect(h1.store.list()[0]?.orchestration?.concurrency).toBe(1);
    });

    it("T5: rejects malformed input and a failing probe with a specific message, without persisting", async () => {
      const create = (args: unknown) => h.text("OrchestrationCreate", args);
      expect(await create({ goal: "   ", work: [{ prompt: "A" }] })).toContain("goal must contain 1-2000 characters");
      expect(await create({ goal: "Review", work: [{ prompt: "  " }] })).toContain("work item 1 prompt must not be empty");
      expect(await create({ goal: "Review", work: [{ prompt: "A", agentType: "x".repeat(129) }] })).toContain("agentType exceeds 128 characters at item 1");
      expect(await create({ goal: "Review", work: Array.from({ length: 5 }, () => ({ prompt: "x".repeat(16_000) })) })).toContain("Serialized orchestration input exceeds 65536 bytes");
      h.probeSubagents.mockRejectedValueOnce(new Error("bus closed"));
      expect(await create({ goal: "Review", work: [{ prompt: "A" }] })).toContain("requires a compatible subagent provider: bus closed");
      expect(h.store.list()).toHaveLength(0);
    });

    it("T4 (control): with no provider traits the default agent type is unchanged", async () => {
      await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "A" }], maxTurns: 5 });
      expect(h.store.list()[0]?.orchestration).toMatchObject({ maxTurns: 5, work: [{ agentType: "general-purpose" }] });
    });
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
    expect(summary).toContain("0/1 complete · 0/1 in flight · 1 pending");
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
    expect(work).toContain("Work #1 · complete");
    expect(work).toContain("Prompt: Inspect API compatibility");
    expect(work).toContain("Dispatch 1: complete · agent=agent-1");
    expect(work).toContain("Result: API is compatible");
    expect(work).toContain("Output: provider-owned");
  });

  it("renders status-aware human summaries", async () => {
    await h.text("OrchestrationCreate", { goal: "Review", work: [{ prompt: "Inspect" }] });
    const entry = h.store.get("1")!;
    entry.orchestration!.status = "needs_attention";
    entry.orchestration!.work[0]!.status = "failed";

    const warning = await h.result("OrchestrationGet", { id: "1" });
    expect(warning.details).toMatchObject({
      kind: "orchestration",
      tone: "warning",
      summary: "Orchestration #1 needs attention · 0/1 complete · 0 reserved · 1 failed",
    });
    expect(warning.details.summary).not.toContain("needs_attention");
  });

  it("reports missing controllers and work with bounded context", async () => {
    expect(await h.text("OrchestrationGet", { id: "404" })).toContain("Orchestration #404 not found");
    await h.text("OrchestrationCreate", {
      goal: "Review",
      work: Array.from({ length: 12 }, (_, index) => ({ prompt: `Inspect ${index + 1}` })),
    });
    const missing = await h.result("OrchestrationGet", { id: "1", workId: "404" });
    expect(missing.content[0].text).toContain("Work #404 not found");
    expect(missing.details.expanded).toHaveLength(10);
    expect(missing.details.expanded.at(-1)).toBe("… 8 more");
    expect(missing.details.expanded.every((line: string) => !line.includes("\n"))).toBe(true);
  });

  it("renders compact create and inspect calls", () => {
    const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
    const create = (h.toolMap.get("OrchestrationCreate") as any).renderCall({ goal: "Review readiness" }, theme);
    const inspect = (h.toolMap.get("OrchestrationGet") as any).renderCall({ id: "7" }, theme);

    expect(create.render(80).join("\n")).toContain("Orchestration create · Review readiness");
    expect(inspect.render(80).join("\n")).toContain("Orchestration inspect · #7");
  });
});
