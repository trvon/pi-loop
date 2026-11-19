import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RpcError, type RpcEventBus } from "../src/rpc/cross-extension-rpc.js";
import {
  createSubagentProviderSelector,
  createSubagentsV1Provider,
  createSubagentsV2Provider,
  PermanentLaunchError,
  type SubagentLifecycleEvent,
} from "../src/runtime/subagent-provider.js";

function createBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ name: string; data: any }> = [];
  const bus: RpcEventBus = {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, data) {
      emitted.push({ name: event, data });
      for (const handler of [...(handlers.get(event) ?? [])]) handler(data);
    },
  };
  return { bus, emitted, listenerCount: (event: string) => handlers.get(event)?.size ?? 0 };
}

const V1_PING = { version: 1, methods: ["ping", "status", "spawn", "stop"], capabilities: { asyncSpawn: true, stop: true } };

/** Answers v1 requests like the provider: one request channel, replies keyed by request id. */
function serveV1(bus: RpcEventBus, handle: (method: string, params: any) => { data: unknown } | { error: { code: string; message: string } } | undefined) {
  return bus.on("subagents:rpc:v1:request", (raw) => {
    const request = raw as { requestId: string; method: string; params?: unknown };
    const outcome = handle(request.method, request.params);
    if (!outcome) return;
    bus.emit(`subagents:rpc:v1:reply:${request.requestId}`, "data" in outcome
      ? { version: 1, requestId: request.requestId, method: request.method, success: true, data: outcome.data }
      : { version: 1, requestId: request.requestId, method: request.method, success: false, error: outcome.error });
  });
}

function serveV2Ping(bus: RpcEventBus, version = 2) {
  return bus.on("subagents:rpc:ping", (raw) => {
    bus.emit(`subagents:rpc:ping:reply:${(raw as { requestId: string }).requestId}`, { success: true, data: { version } });
  });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("pi-subagents RPC v1 provider", () => {
  it("A1: is compatible only when a v1 responder advertises async spawn and stop", async () => {
    const answering = createBus();
    serveV1(answering.bus, (method) => method === "ping" ? { data: V1_PING } : undefined);
    expect(await createSubagentsV1Provider(answering.bus).probe(1_000)).toBe(true);

    for (const ping of [
      { ...V1_PING, version: 2 },
      { ...V1_PING, methods: ["ping", "status"] },
      { ...V1_PING, capabilities: { asyncSpawn: false, stop: true } },
      null,
    ]) {
      const other = createBus();
      serveV1(other.bus, () => ({ data: ping }));
      expect(await createSubagentsV1Provider(other.bus).probe(1_000)).toBe(false);
    }

    const silent = createBus();
    const probing = createSubagentsV1Provider(silent.bus).probe(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await probing).toBe(false);
    expect(silent.listenerCount(`subagents:rpc:v1:reply:${silent.emitted[0]!.data.requestId}`)).toBe(0);
  });

  it("A2: launches one fresh background child and reads its run id from the reply", async () => {
    const { bus, emitted } = createBus();
    serveV1(bus, (method) => method === "spawn" ? { data: { text: "Async: worker [run-1]", details: { mode: "single", runId: "run-1", asyncId: "run-1", asyncDir: "/tmp/x" } } } : undefined);
    const provider = createSubagentsV1Provider(bus);
    const reply = await provider.spawn({ agentType: "worker", prompt: "Fix module A", description: "Orchestration #1 work #1", model: "anthropic/claude-sonnet-5-5" }, 5_000);

    expect(provider.workerId(reply)).toBe("run-1");
    const request = emitted.find((event) => event.name === "subagents:rpc:v1:request")!.data;
    expect(request).toMatchObject({ version: 1, method: "spawn" });
    expect(typeof request.requestId).toBe("string");
    // Only fields the provider's schema defines: it has no description and no turn limit.
    expect(request.params).toEqual({ agent: "worker", task: "Fix module A", context: "fresh", model: "anthropic/claude-sonnet-5-5" });

    expect(provider.workerId({ text: "no details" })).toBeUndefined();
    expect(provider.workerId({ details: { runId: "" } })).toBeUndefined();
    expect(provider.workerId(undefined)).toBeUndefined();
  });

  it("A3: a refused launch is a proved failure; a silent provider is a timeout", async () => {
    const refusing = createBus();
    serveV1(refusing.bus, () => ({ error: { code: "execution_failed", message: "Unknown agent: general-purpose. Did you mean 'worker'?" } }));
    const refused = await createSubagentsV1Provider(refusing.bus).spawn({ agentType: "general-purpose", prompt: "x", description: "d" }, 5_000).catch((error) => error);
    expect(refused).toBeInstanceOf(RpcError);
    expect(refused.message).toContain("Unknown agent: general-purpose");
    expect(refused.timedOut).toBe(false);

    const silent = createBus();
    const pending = createSubagentsV1Provider(silent.bus).spawn({ agentType: "worker", prompt: "x", description: "d" }, 5_000).catch((error) => error);
    await vi.advanceTimersByTimeAsync(5_001);
    const timedOut = await pending;
    expect(timedOut).toBeInstanceOf(RpcError);
    expect(timedOut.timedOut).toBe(true);
  });

  it("A8: tells a launch refused for good from one refused for now", async () => {
    const refuse = async (error: { code: string; message: string }) => {
      const { bus } = createBus();
      serveV1(bus, () => ({ error }));
      return createSubagentsV1Provider(bus).spawn({ agentType: "x", prompt: "p", description: "d" }, 5_000).catch((caught) => caught);
    };
    for (const error of [
      { code: "execution_failed", message: "Unknown agent: Explroe. Did you mean 'explore'?" },
      { code: "invalid_params", message: "RPC spawn only supports detached async launches" },
    ]) {
      const caught = await refuse(error);
      expect(caught).toBeInstanceOf(PermanentLaunchError);
      expect(caught).toBeInstanceOf(RpcError);
      expect(caught.message).toBe(error.message);
    }
    for (const error of [
      { code: "execution_failed", message: "Active async run capacity exhausted: 4/4 used." },
      { code: "execution_failed", message: "Failed to start async run 'r1': spawn EAGAIN" },
      { code: "no_active_session", message: "No active extension context for subagent RPC." },
    ]) {
      const caught = await refuse(error);
      expect(caught).toBeInstanceOf(RpcError);
      expect(caught).not.toBeInstanceOf(PermanentLaunchError);
    }
  });

  it("A4: maps run lifecycle events to worker outcomes", () => {
    const { bus } = createBus();
    const seen: SubagentLifecycleEvent[] = [];
    const stop = createSubagentsV1Provider(bus).onLifecycle((event) => seen.push(event));

    bus.emit("subagent:async-started", { id: "run-1", agent: "worker", mode: "single" });
    bus.emit("subagent:async-complete", {
      id: "run-1", runId: "run-1", success: true, state: "complete", durationMs: 4_200,
      totalTokens: { input: 900, output: 300, total: 1_200 },
      results: [{ status: "completed", output: "Fixed A; tests pass." }],
    });
    bus.emit("subagent:async-complete", { id: "run-2", success: false, state: "failed", results: [{ status: "failed", error: "HTTP 429 Too Many Requests" }] });
    bus.emit("subagent:async-complete", { id: "run-3", success: false, state: "failed", timedOut: true, error: "deadline reached" });
    bus.emit("subagent:async-complete", { id: "run-4", success: false, state: "stopped", stopped: true });
    bus.emit("subagent:async-complete", { id: "run-5", success: false, state: "paused" });
    bus.emit("subagent:async-complete", { id: "run-6", success: false, state: "partial", results: [{ output: "half" }] });
    // Malformed or foreign payloads are ignored.
    bus.emit("subagent:async-complete", { success: true, state: "complete" });
    bus.emit("subagent:async-complete", "run-7");
    bus.emit("subagent:async-started", { id: "" });

    expect(seen).toEqual([
      { kind: "started", id: "run-1" },
      { kind: "completed", id: "run-1", result: "Fixed A; tests pass.", status: "complete", durationMs: 4_200, tokens: { input: 900, output: 300, total: 1_200 } },
      { kind: "failed", id: "run-2", status: "failed", error: "HTTP 429 Too Many Requests" },
      { kind: "failed", id: "run-3", status: "failed", error: "timed out: deadline reached" },
      { kind: "failed", id: "run-4", status: "stopped" },
      { kind: "failed", id: "run-5", status: "aborted" },
      { kind: "failed", id: "run-6", status: "partial", error: "Provider reported a partial result." },
    ]);
    // The provider reports no tool-use count, so delay evidence and free re-sends stay off.
    expect(seen.every((event) => event.toolUses === undefined)).toBe(true);

    stop();
    bus.emit("subagent:async-started", { id: "run-9" });
    expect(seen).toHaveLength(7);
  });

  it("A9: a run flagged stopped is never a plain failure, whatever its state says", () => {
    const { bus } = createBus();
    const seen: SubagentLifecycleEvent[] = [];
    createSubagentsV1Provider(bus).onLifecycle((event) => seen.push(event));
    bus.emit("subagent:async-complete", { id: "run-1", success: false, state: "failed", stopped: true, error: "stopped by request" });
    // Control: a failure with no such flag is still a failure that may be retried.
    bus.emit("subagent:async-complete", { id: "run-4", success: false, state: "failed", stopped: false, error: "TypeError: x" });
    expect(seen.map((event) => [event.id, event.status])).toEqual([["run-1", "stopped"], ["run-4", "failed"]]);
    expect(seen[1]!.error).toBe("TypeError: x");
  });

  it("A5: stops by run id, cannot consume, and reports readiness", async () => {
    const { bus, emitted } = createBus();
    serveV1(bus, (method) => method === "stop" ? { data: { runId: "run-1", state: "stopping" } } : undefined);
    const provider = createSubagentsV1Provider(bus);

    await provider.stop("run-1", 1_000);
    expect(emitted.find((event) => event.data?.method === "stop")!.data.params).toEqual({ id: "run-1" });
    await expect(provider.consume("run-1", 1_000)).rejects.toThrow(/does not support consume/);

    const ready = vi.fn();
    const off = provider.onReady(ready);
    bus.emit("subagents:rpc:v1:ready", V1_PING);
    expect(ready).toHaveBeenCalledTimes(1);
    off();
    bus.emit("subagents:rpc:v1:ready", V1_PING);
    expect(ready).toHaveBeenCalledTimes(1);
  });

  it("A7: a bus that throws on emit rejects the call and leaves no listener or timer behind", async () => {
    const { bus, listenerCount } = createBus();
    let requestId = "";
    const throwing = { on: bus.on, emit: (event: string, data: unknown) => { requestId = (data as { requestId: string }).requestId; throw new Error(`cannot emit ${event}`); } };
    await expect(createSubagentsV1Provider(throwing).stop("run-1", 1_000)).rejects.toThrow("cannot emit subagents:rpc:v1:request");
    expect(listenerCount(`subagents:rpc:v1:reply:${requestId}`)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    // A reply delivered during emit settles the call; a later emit failure cannot change it.
    const racing = createBus();
    const replied = {
      on: racing.bus.on,
      emit(event: string, data: unknown) {
        racing.bus.emit(`subagents:rpc:v1:reply:${(data as { requestId: string }).requestId}`, { version: 1, success: true, data: { state: "stopping" } });
        throw new Error(`late failure on ${event}`);
      },
    };
    await expect(createSubagentsV1Provider(replied).stop("run-1", 1_000)).resolves.toEqual({ state: "stopping" });
  });

  it("A6: declares what the provider cannot do", () => {
    const v1 = createSubagentsV1Provider(createBus().bus);
    expect(v1).toMatchObject({ defaultAgentType: "delegate", supportsMaxTurns: false });
    expect(v1.spawnTimeoutMs).toBeGreaterThan(5_000);
    const { bus } = createBus();
    const v2 = createSubagentsV2Provider(bus, async () => undefined);
    expect(v2).toMatchObject({ defaultAgentType: "general-purpose", supportsMaxTurns: true, spawnTimeoutMs: 5_000 });
  });
});

describe("provider selection", () => {
  function both(options: { v2?: boolean; v1?: boolean }) {
    const { bus, emitted } = createBus();
    if (options.v2) serveV2Ping(bus);
    if (options.v1) serveV1(bus, (method) => method === "ping" ? { data: V1_PING } : method === "spawn" ? { data: { details: { runId: "run-1" } } } : undefined);
    const rpcCall = vi.fn(async (channel: string, params: Record<string, unknown> = {}, timeoutMs = 5_000) => {
      const { rpcCall: call } = await import("../src/rpc/cross-extension-rpc.js");
      return call(bus, channel, params, timeoutMs);
    });
    const selector = createSubagentProviderSelector([createSubagentsV2Provider(bus, rpcCall), createSubagentsV1Provider(bus)]);
    return { bus, emitted, selector };
  }

  it("S1: prefers protocol v2 when both providers answer", async () => {
    const { selector } = both({ v2: true, v1: true });
    expect(await selector.probe(1_000)).toBe(true);
    expect(selector.name).toContain("protocol v2");
    expect(selector.supportsMaxTurns).toBe(true);
  });

  it("S2: selects RPC v1 when it is the only provider, and routes calls to it", async () => {
    const { selector, emitted } = both({ v1: true });
    expect(selector.isAvailable()).toBe(false);
    const probing = selector.probe(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(await probing).toBe(true);
    expect(selector.isAvailable()).toBe(true);
    expect(selector.name).toContain("RPC v1");
    expect(selector).toMatchObject({ defaultAgentType: "delegate", supportsMaxTurns: false });
    expect(selector.workerId(await selector.spawn({ agentType: "worker", prompt: "x", description: "d" }, 5_000))).toBe("run-1");
    expect(emitted.some((event) => event.name === "subagents:rpc:spawn")).toBe(false);
  });

  it("S3: with no provider, probing is false and calls reject without dispatching", async () => {
    const { selector, emitted } = both({});
    const probing = selector.probe(1_000);
    await vi.advanceTimersByTimeAsync(2_002);
    expect(await probing).toBe(false);
    expect(selector.isAvailable()).toBe(false);
    const before = emitted.length;
    await expect(selector.spawn({ agentType: "worker", prompt: "x", description: "d" }, 5_000)).rejects.toThrow(/No compatible subagent provider/);
    await expect(selector.stop("run-1", 1_000)).rejects.toThrow(/No compatible subagent provider/);
    expect(emitted).toHaveLength(before);
    expect(selector.workerId({ id: "x" })).toBeUndefined();
  });

  it("S6: needs at least one candidate, and cannot consume before a provider is selected", async () => {
    expect(() => createSubagentProviderSelector([])).toThrow("needs at least one candidate");
    const { selector } = both({});
    await expect(selector.consume("run-1", 1_000)).rejects.toThrow(/No compatible subagent provider/);
  });

  it("S4: the first selection is kept for the runtime's lifetime", async () => {
    const { bus, selector } = both({ v1: true });
    const probing = selector.probe(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await probing;
    serveV2Ping(bus);
    expect(await selector.probe(1_000)).toBe(true);
    expect(selector.name).toContain("RPC v1");
  });

  it("S5: forwards lifecycle only from the selected provider, and readiness from every candidate", async () => {
    const { bus, selector } = both({ v1: true });
    const seen: SubagentLifecycleEvent[] = [];
    const ready = vi.fn();
    const off = selector.onLifecycle((event) => seen.push(event));
    const offReady = selector.onReady(ready);

    // Before selection nothing was launched here, so no provider's event belongs to this runtime.
    bus.emit("subagents:started", { id: "agent-0" });
    bus.emit("subagent:async-started", { id: "run-0" });
    expect(seen).toEqual([]);

    const probing = selector.probe(1_000);
    await vi.advanceTimersByTimeAsync(1_001);
    await probing;
    // An installed but unselected provider cannot settle or crowd out this runtime's dispatches.
    bus.emit("subagents:started", { id: "agent-1" });
    bus.emit("subagents:completed", { id: "agent-1", result: "foreign" });
    bus.emit("subagent:async-started", { id: "run-1" });
    expect(seen.map((event) => event.id)).toEqual(["run-1"]);

    bus.emit("subagents:ready", {});
    bus.emit("subagents:rpc:v1:ready", {});
    expect(ready).toHaveBeenCalledTimes(2);
    off();
    offReady();
    bus.emit("subagent:async-started", { id: "run-2" });
    expect(seen).toHaveLength(1);
  });
});
