import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { RpcError } from "../src/rpc/cross-extension-rpc.js";
import { createSubagentOrchestrationRuntime } from "../src/runtime/subagent-orchestration-runtime.js";
import { LoopStore } from "../src/store.js";
import type { OrchestrationActor } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

const owner: OrchestrationActor = { sessionId: "session-a", runtimeId: "runtime-a", generation: 2 };
type RpcFn = (channel: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
type RpcMock = Mock<RpcFn>;

function setup(options: { workCount?: number; concurrency?: number; maxAttempts?: number; rpc?: RpcMock; env?: string } = {}) {
  const { pi } = createMockPi();
  const store = new LoopStore();
  let actor = { ...owner };
  let now = 1_000;
  let contextCurrent = true;
  const scheduled: Array<() => void> = [];
  let nextAgent = 0;
  const rpc = options.rpc ?? vi.fn(async (channel: string) => {
    if (channel === "subagents:rpc:spawn") return { id: `agent-${++nextAgent}` };
    return undefined;
  });
  const emitWake = vi.fn();
  const runtime = createSubagentOrchestrationRuntime({
    events: pi.events,
    getStore: () => store,
    getScope: () => "session",
    getPiLoopEnv: () => options.env,
    getActor: () => actor,
    getGeneration: () => actor.generation,
    rpcCall: rpc,
    emitWake,
    updateWidget: vi.fn(),
    now: () => now,
    scheduleReconcile: (fn) => scheduled.push(fn),
    isContextCurrent: () => contextCurrent,
  });
  const entry = store.create({ type: "dynamic" }, "Parallel review", {
    recurring: true,
    dynamic: { goal: "Parallel review", awaitingUpdate: true },
    orchestration: {
      owner: actor,
      definition: {
        goal: "Parallel review",
        work: Array.from({ length: options.workCount ?? 3 }, (_, index) => ({
          prompt: `Inspect subsystem ${index + 1}`,
          agentType: "Explore",
        })),
        concurrency: options.concurrency ?? 2,
        maxAttempts: options.maxAttempts ?? 2,
        model: "test/model",
        maxTurns: 7,
      },
    },
  });
  async function drain() {
    while (scheduled.length > 0) scheduled.shift()!();
    await Promise.resolve();
    await Promise.resolve();
  }
  return {
    pi,
    store,
    runtime,
    rpc,
    emitWake,
    entry,
    drain,
    setNow(value: number) { now = value; },
    setActor(value: OrchestrationActor) { actor = value; },
    setContextCurrent(value: boolean) { contextCurrent = value; },
  };
}

function spawnCalls(rpc: RpcMock) {
  return rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:spawn");
}

describe("subagent orchestration runtime", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("fills only local capacity and forces detached isolated worker options", async () => {
    const h = setup({ workCount: 3, concurrency: 2 });

    await h.runtime.pump();

    expect(spawnCalls(h.rpc)).toHaveLength(2);
    expect(spawnCalls(h.rpc)[0]?.[1]).toMatchObject({
      type: "Explore",
      options: {
        description: "Orchestration #1 work #1",
        model: "test/model",
        maxTurns: 7,
        isBackground: true,
        isolated: true,
        inheritContext: false,
      },
    });
    expect(h.store.get(h.entry.id)?.orchestration?.work.map((item) => item.status)).toEqual(["active", "active", "pending"]);
  });

  it("settles before consume, coalesces refill, and wakes only after the batch settles", async () => {
    const order: string[] = [];
    let nextAgent = 0;
    const rpc = vi.fn(async (channel: string) => {
      order.push(channel);
      if (channel === "subagents:rpc:spawn") return { id: `agent-${++nextAgent}` };
      return undefined;
    });
    const h = setup({ workCount: 3, concurrency: 2, rpc });
    await h.runtime.pump();

    h.pi.events.emit("subagents:completed", { id: "agent-1", status: "completed", result: "first", toolUses: 2, durationMs: 10 });
    expect(h.store.get(h.entry.id)?.orchestration?.work[0]).toMatchObject({ status: "completed" });
    expect(order.at(-1)).toBe("subagents:rpc:consume");
    expect(h.emitWake).not.toHaveBeenCalled();

    await h.drain();
    expect(spawnCalls(rpc)).toHaveLength(3);

    h.pi.events.emit("subagents:completed", { id: "agent-2", status: "completed", result: "second" });
    h.pi.events.emit("subagents:completed", { id: "agent-3", status: "completed", result: "third" });
    await h.drain();

    expect(h.emitWake).toHaveBeenCalledTimes(1);
    expect(h.emitWake).toHaveBeenCalledWith(expect.objectContaining({ id: h.entry.id }), expect.objectContaining({ reason: "completed", sequence: 1 }));
    expect(h.store.get(h.entry.id)?.status).toBe("paused");
  });

  it("replays a started event that arrives before the spawn reply binds the agent", async () => {
    let h: ReturnType<typeof setup>;
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") {
        h.pi.events.emit("subagents:started", { id: "agent-early", type: "Explore", description: "early" });
        return { id: "agent-early" };
      }
      return undefined;
    });
    h = setup({ workCount: 1, rpc });

    await h.runtime.pump();

    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.dispatches[0]).toMatchObject({
      agentId: "agent-early",
      status: "running",
    });
  });

  it("replays terminal evidence that arrives before the spawn reply binds the agent", async () => {
    let h: ReturnType<typeof setup>;
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") {
        h.pi.events.emit("subagents:completed", { id: "agent-fast", status: "completed", result: "fast result" });
        return { id: "agent-fast" };
      }
      return undefined;
    });
    h = setup({ workCount: 1, rpc });

    await h.runtime.pump();
    await h.drain();

    expect(h.store.get(h.entry.id)?.orchestration?.work[0]).toMatchObject({ status: "completed" });
    expect(rpc.mock.calls.some(([channel]) => channel === "subagents:rpc:consume")).toBe(true);
  });

  it("settles failed lifecycle events with bounded usage before consume", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();

    h.pi.events.emit("subagents:failed", {
      id: "agent-1",
      status: "failed",
      error: "worker failed",
      tokens: { input: 2, output: 3, total: 5 },
      toolUses: 4,
      durationMs: 20,
    });

    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.dispatches[0]).toMatchObject({
      status: "failed",
      error: "worker failed",
      usage: { tokens: { input: 2, output: 3, total: 5 }, toolUses: 4, durationMs: 20 },
      consumeStatus: "pending",
    });
    expect(h.rpc.mock.calls.at(-1)?.[0]).toBe("subagents:rpc:consume");
  });

  it("waits for active workers before waking for uncertain work", async () => {
    let spawn = 0;
    const rpc = vi.fn(async (channel: string) => {
      if (channel !== "subagents:rpc:spawn") return undefined;
      spawn += 1;
      if (spawn === 2) throw new RpcError(channel, "timed out", true);
      return { id: "agent-1" };
    });
    const h = setup({ workCount: 2, concurrency: 2, rpc });

    await h.runtime.pump();
    await h.drain();

    expect(h.store.get(h.entry.id)?.orchestration?.work.map((item) => item.status)).toEqual(["active", "uncertain"]);
    expect(h.emitWake).not.toHaveBeenCalled();

    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "done" });
    await h.drain();

    expect(h.emitWake).toHaveBeenCalledTimes(1);
    expect(h.emitWake).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ reason: "uncertain" }));
  });

  it("rejects duplicate agent identities without settling two work items", async () => {
    const rpc = vi.fn(async (channel: string) => channel === "subagents:rpc:spawn" ? { id: "agent-shared" } : undefined);
    const h = setup({ workCount: 2, concurrency: 2, rpc });

    await h.runtime.pump();

    expect(h.store.get(h.entry.id)?.orchestration?.work.map((item) => item.status)).toEqual(["active", "uncertain"]);
    h.pi.events.emit("subagents:completed", { id: "agent-shared", result: "one result" });
    await h.drain();
    expect(h.store.get(h.entry.id)?.orchestration?.work.map((item) => item.status)).toEqual(["completed", "uncertain"]);
    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:stop")).toHaveLength(0);
  });

  it("marks an ambiguous spawn timeout uncertain and never retries it", async () => {
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") throw new RpcError(channel, "timed out", true);
      return undefined;
    });
    const h = setup({ workCount: 1, maxAttempts: 3, rpc });

    await h.runtime.pump();
    await h.drain();

    expect(spawnCalls(rpc)).toHaveLength(1);
    expect(h.store.get(h.entry.id)?.orchestration).toMatchObject({
      status: "needs_attention",
      work: [{ status: "uncertain", attemptCount: 1 }],
      pendingWake: { reason: "uncertain" },
    });
  });

  it("refuses to recover orchestration from a custom PI_LOOP path", async () => {
    const h = setup({ workCount: 1, env: "/tmp/shared-loops.json" });

    await h.runtime.recover();

    expect(spawnCalls(h.rpc)).toHaveLength(0);
    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.status).toBe("pending");
  });

  it("renews controller ownership on the existing reconciliation heartbeat", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();
    const before = h.store.get(h.entry.id)!.orchestration!.owner.leaseExpiresAt;
    h.setNow(before - 30_000);

    await h.runtime.pump();

    expect(h.store.get(h.entry.id)!.orchestration!.owner.leaseExpiresAt).toBeGreaterThan(before);
  });

  it("replays a durable pending wake after paused-owner lease recovery", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();
    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "done" });
    await h.drain();
    const previous = h.store.get(h.entry.id)!.orchestration!;
    expect(h.store.get(h.entry.id)?.status).toBe("paused");
    expect(h.emitWake).toHaveBeenCalledTimes(1);

    h.setActor({ sessionId: owner.sessionId, runtimeId: "runtime-b", generation: 3 });
    h.setNow(previous.owner.leaseExpiresAt + 1);
    await h.runtime.recover();

    expect(h.store.get(h.entry.id)?.orchestration?.owner).toMatchObject({ runtimeId: "runtime-b", generation: 3 });
    expect(h.emitWake).toHaveBeenCalledTimes(2);
    expect(h.store.get(h.entry.id)?.orchestration?.pendingWake).toMatchObject({ reason: "completed", sequence: 1 });
  });

  it("retries bounded consume acknowledgement after durable settlement", async () => {
    let consumeAttempts = 0;
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") return { id: "agent-1" };
      if (channel === "subagents:rpc:consume" && ++consumeAttempts === 1) throw new Error("consume unavailable");
      return undefined;
    });
    const h = setup({ workCount: 1, rpc });
    await h.runtime.pump();

    h.pi.events.emit("subagents:completed", { id: "agent-1", status: "completed", result: "done" });
    await h.drain();
    await h.runtime.pump();
    await Promise.resolve();

    expect(consumeAttempts).toBe(2);
    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.dispatches[0]?.consumeStatus).toBe("consumed");
  });

  it("does not consume again for duplicate terminal lifecycle events", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();
    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "done" });
    await Promise.resolve();
    await Promise.resolve();
    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.dispatches[0]?.consumeStatus).toBe("consumed");
    const before = h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:consume").length;

    h.pi.events.emit("subagents:completed", { id: "agent-1", result: "duplicate" });
    await Promise.resolve();

    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:consume")).toHaveLength(before);
  });

  it("drops lifecycle events from a stale extension context before mutation", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();
    h.setContextCurrent(false);

    h.pi.events.emit("subagents:completed", { id: "agent-1", status: "completed", result: "stale" });

    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.status).toBe("active");
    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:consume")).toHaveLength(0);
  });

  it("ignores stale-generation lifecycle events", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();
    h.setActor({ ...owner, generation: 3 });

    h.pi.events.emit("subagents:completed", { id: "agent-1", status: "completed", result: "stale" });

    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.status).toBe("active");
    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:consume")).toHaveLength(0);
  });

  it("disposes lifecycle subscriptions and disables later reconciliation", async () => {
    const h = setup({ workCount: 1 });

    h.runtime.dispose();
    h.pi.events.emit("subagents:started", { id: "agent-late" });
    h.pi.events.emit("subagents:completed", { id: "agent-late", result: "late" });
    h.pi.events.emit("subagents:failed", { id: "agent-late", error: "late" });
    await h.runtime.pump();

    expect(spawnCalls(h.rpc)).toHaveLength(0);
    expect(h.store.get(h.entry.id)?.orchestration?.work[0]?.status).toBe("pending");
  });

  it("stops a worker whose spawn reply arrives after cancellation", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") return await new Promise((resolve) => { resolveSpawn = resolve; });
      return undefined;
    });
    const h = setup({ workCount: 1, rpc });
    const pumping = h.runtime.pump();
    await Promise.resolve();

    const cancelling = h.runtime.cancel(h.entry.id, "delete");
    await Promise.resolve();
    resolveSpawn?.({ id: "agent-after-cancel" });
    await Promise.all([pumping, cancelling]);

    expect(h.rpc.mock.calls).toContainEqual(["subagents:rpc:stop", { agentId: "agent-after-cancel" }, 1_000]);
    expect(h.rpc.mock.calls).toContainEqual(["subagents:rpc:consume", { agentId: "agent-after-cancel" }, 1_000]);
    expect(h.store.get(h.entry.id)).toBeUndefined();
  });

  it("fences cancellation before stopping and deleting owned workers", async () => {
    const h = setup({ workCount: 2, concurrency: 2 });
    await h.runtime.pump();

    expect(await h.runtime.cancel(h.entry.id, "delete")).toBe(true);

    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:stop")).toHaveLength(2);
    expect(h.store.get(h.entry.id)).toBeUndefined();
  });

  it("pauses a cancelled controller after best-effort stop", async () => {
    const h = setup({ workCount: 1 });
    await h.runtime.pump();

    expect(await h.runtime.cancel(h.entry.id, "pause")).toBe(true);

    expect(h.store.get(h.entry.id)).toMatchObject({ status: "paused", orchestration: { status: "cancelled" } });
  });

  it("marks an unidentified in-flight spawn uncertain during shutdown", async () => {
    let resolveSpawn: ((value: unknown) => void) | undefined;
    const rpc = vi.fn(async (channel: string) => {
      if (channel !== "subagents:rpc:spawn") return undefined;
      return await new Promise((resolve) => { resolveSpawn = resolve; });
    });
    const h = setup({ workCount: 1, rpc });
    const pumping = h.runtime.pump();
    await Promise.resolve();

    const shuttingDown = h.runtime.shutdown();
    await Promise.resolve();
    resolveSpawn?.({ id: "agent-too-late" });
    await Promise.all([pumping, shuttingDown]);

    expect(h.rpc.mock.calls).toContainEqual(["subagents:rpc:stop", { agentId: "agent-too-late" }, 1_000]);
    expect(h.store.get(h.entry.id)?.orchestration).toMatchObject({
      status: "needs_attention",
      work: [{ status: "uncertain" }],
    });
  });

  it("persists teardown settlement before consuming upstream evidence", async () => {
    let h: ReturnType<typeof setup>;
    let statusAtConsume: string | undefined;
    const rpc = vi.fn(async (channel: string) => {
      if (channel === "subagents:rpc:spawn") return { id: "agent-1" };
      if (channel === "subagents:rpc:consume") statusAtConsume = h.store.get(h.entry.id)?.orchestration?.work[0]?.dispatches[0]?.status;
      return undefined;
    });
    h = setup({ workCount: 1, rpc });
    await h.runtime.pump();

    await h.runtime.shutdown();
    await Promise.resolve();

    expect(statusAtConsume).toBe("interrupted");
  });

  it("stops owned workers on shutdown and leaves proved stops retryable", async () => {
    const h = setup({ workCount: 2, concurrency: 2 });
    await h.runtime.pump();

    await h.runtime.shutdown();

    expect(h.rpc.mock.calls.filter(([channel]) => channel === "subagents:rpc:stop")).toHaveLength(2);
    expect(h.store.get(h.entry.id)?.orchestration?.work.map((item) => item.status)).toEqual(["pending", "pending"]);
  });
});
