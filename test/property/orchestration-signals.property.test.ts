import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { type AckSignal, applyAckSignal, classifySettlement, createAckWindow, type DelayClass, delayClass, observeDelay, validateAckWindow } from "../../src/ack-window.js";
import type { RpcEventBus } from "../../src/rpc/cross-extension-rpc.js";
import { createSubagentProviderSelector, createSubagentsV1Provider, type SubagentLifecycleEvent, type SubagentProvider } from "../../src/runtime/subagent-provider.js";
import { propertyOptions } from "./config.js";

const sample = fc.record({
  msPerToken: fc.double({ min: 1, max: 500, noNaN: true }),
  outputTokens: fc.integer({ min: 1, max: 5_000 }),
  toolUses: fc.option(fc.integer({ min: 0, max: 40 }), { nil: undefined }),
  attempt: fc.constantFrom(1, 1, 1, 2),
  dispatchedBeforeLastCut: fc.boolean(),
});

function run(ceiling: number, samples: Array<{ msPerToken: number; outputTokens: number; toolUses: number | undefined; attempt: number; dispatchedBeforeLastCut?: boolean }>) {
  let window = createAckWindow(ceiling);
  const signals: AckSignal[] = [];
  let at = 0;
  for (const item of samples) {
    at += 10;
    const evidence = { outcome: "completed" as const, result: "ok", attempt: item.attempt, durationMs: item.msPerToken * item.outputTokens, outputTokens: item.outputTokens, toolUses: item.toolUses };
    const before = window;
    const signal = classifySettlement(evidence, window);
    const requestedAt = item.dispatchedBeforeLastCut && window.recoverAt !== undefined ? window.recoverAt : at - 1;
    window = observeDelay(applyAckSignal(window, signal, ceiling, { at, requestedAt }), evidence);
    signals.push(signal);
    expect(validateAckWindow(structuredClone(window), ceiling)).toBe(true);
    for (const key of Object.keys(before.delayFloors ?? {}) as DelayClass[]) {
      expect(window.delayFloors![key]!).toBeLessThanOrEqual(before.delayFloors![key]!);
    }
    if (item.toolUses === undefined || item.attempt > 1) expect(signal).not.toBe("congestion");
  }
  return { window, signals };
}

describe("delay signal properties", () => {
  it("keeps the window valid, floors non-increasing, and never cuts twice on one slow run", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 32 }), fc.array(sample, { minLength: 1, maxLength: 80 }), (ceiling, samples) => {
      const { window, signals } = run(ceiling, samples);
      expect(window.cwnd).toBeGreaterThanOrEqual(1);
      expect(window.cwnd).toBeLessThanOrEqual(ceiling);
      expect(window.acks + window.losses + window.taskLosses).toBe(samples.length);
      // A reported streak starts over: two delay cuts need at least two slow samples each.
      for (let index = 1; index < signals.length; index += 1) {
        expect(signals[index] === "congestion" && signals[index - 1] === "congestion").toBe(false);
      }
    }), propertyOptions());
  });

  it("never reads work as congestion while each tool-use class stays within twice its own fastest sample", () => {
    const classBase = fc.record({ "0": fc.double({ min: 5, max: 400, noNaN: true }), "1": fc.double({ min: 5, max: 400, noNaN: true }), "2": fc.double({ min: 5, max: 400, noNaN: true }), "3": fc.double({ min: 5, max: 400, noNaN: true }) });
    const item = fc.record({ toolUses: fc.integer({ min: 0, max: 40 }), spread: fc.double({ min: 1, max: 2, noNaN: true }), outputTokens: fc.integer({ min: 1, max: 5_000 }) });
    fc.assert(fc.property(classBase, fc.array(item, { minLength: 1, maxLength: 80 }), (bases, items) => {
      const samples = items.map(({ toolUses, spread, outputTokens }) => ({ msPerToken: bases[delayClass(toolUses)!] * spread, outputTokens, toolUses, attempt: 1 }));
      const { window, signals } = run(32, samples);
      expect(signals).not.toContain("congestion");
      expect(window.losses).toBe(0);
    }), propertyOptions());
  });
});

function bus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const events: RpcEventBus = {
    on(event, handler) {
      const set = handlers.get(event) ?? new Set();
      set.add(handler);
      handlers.set(event, set);
      return () => set.delete(handler);
    },
    emit(event, data) {
      for (const handler of [...(handlers.get(event) ?? [])]) handler(data);
    },
  };
  return events;
}

describe("provider adapter properties", () => {
  it("turns any v1 lifecycle payload into a well-formed event or nothing, without throwing", () => {
    const payload = fc.oneof(
      fc.anything(),
      fc.record({
        id: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
        runId: fc.oneof(fc.string(), fc.constant(undefined)),
        success: fc.oneof(fc.boolean(), fc.constant(undefined), fc.string()),
        state: fc.oneof(fc.constantFrom("complete", "failed", "partial", "paused", "stopped", ""), fc.string(), fc.constant(undefined)),
        timedOut: fc.oneof(fc.boolean(), fc.constant(undefined)),
        error: fc.oneof(fc.string(), fc.constant(undefined), fc.integer()),
        durationMs: fc.oneof(fc.double(), fc.constant(undefined), fc.string()),
        totalTokens: fc.oneof(fc.record({ input: fc.double(), output: fc.double(), total: fc.double() }), fc.anything()),
        results: fc.oneof(fc.array(fc.oneof(fc.record({ output: fc.oneof(fc.string(), fc.anything()), error: fc.oneof(fc.string(), fc.anything()) }), fc.anything()), { maxLength: 3 }), fc.anything()),
      }),
    );
    fc.assert(fc.property(fc.constantFrom("subagent:async-started", "subagent:async-complete"), payload, (channel, raw) => {
      const events = bus();
      const seen: SubagentLifecycleEvent[] = [];
      createSubagentsV1Provider(events).onLifecycle((event) => seen.push(event));
      events.emit(channel, raw);
      expect(seen.length).toBeLessThanOrEqual(1);
      for (const event of seen) {
        expect(typeof event.id === "string" && event.id.length > 0).toBe(true);
        expect(["started", "completed", "failed"]).toContain(event.kind);
        expect(event.toolUses).toBeUndefined();
        for (const field of [event.result, event.error, event.status]) expect(field === undefined || typeof field === "string").toBe(true);
        if (event.durationMs !== undefined) expect(Number.isFinite(event.durationMs)).toBe(true);
        if (event.tokens) expect(Object.values(event.tokens).every(Number.isFinite)).toBe(true);
        const data = raw as Record<string, unknown>;
        if (event.kind === "started") expect(channel).toBe("subagent:async-started");
        // Only an explicit success is ever a completion.
        if (event.kind === "completed") expect(data.success).toBe(true);
        if (channel === "subagent:async-complete" && data.success !== true) expect(event.kind).toBe("failed");
      }
    }), propertyOptions());
  });

  it("selects the first compatible candidate in order and never changes it", async () => {
    await fc.assert(fc.asyncProperty(fc.array(fc.boolean(), { minLength: 1, maxLength: 4 }), fc.array(fc.array(fc.boolean(), { minLength: 4, maxLength: 4 }), { maxLength: 3 }), async (first, later) => {
      let answers = first;
      const candidates = first.map((_, index): SubagentProvider => ({
        name: `provider-${index}`,
        defaultAgentType: `agent-${index}`,
        supportsMaxTurns: index % 2 === 0,
        spawnTimeoutMs: 1_000 + index,
        probe: async () => answers[index] ?? false,
        spawn: async () => ({ index }),
        workerId: () => `worker-${index}`,
        stop: async () => undefined,
        consume: async () => undefined,
        onLifecycle: () => () => undefined,
        onReady: () => () => undefined,
      }));
      const selector = createSubagentProviderSelector(candidates);
      const expected = first.indexOf(true);
      expect(await selector.probe(10)).toBe(expected !== -1);
      if (expected === -1) {
        await expect(selector.spawn({ agentType: "a", prompt: "p", description: "d" }, 10)).rejects.toThrow();
        return;
      }
      for (const next of later) {
        answers = next;
        await selector.probe(10);
        expect(selector.name).toBe(`provider-${expected}`);
        expect(selector.defaultAgentType).toBe(`agent-${expected}`);
        expect(selector.workerId({})).toBe(`worker-${expected}`);
      }
    }), propertyOptions());
  });
});
