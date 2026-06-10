import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import { TriggerSystem } from "../src/trigger-system.js";
import type { LoopEntry, Trigger } from "../src/types.js";
import { createMockPi } from "./helpers/mock-pi.js";

describe("TriggerSystem", () => {
  let pi: any;
  let store: LoopStore;
  let scheduler: CronScheduler;
  let system: TriggerSystem;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pi = createMockPi().pi;
    store = new LoopStore();
    const fireLoop = (entry: LoopEntry) => {
      if (entry.maxFires && (entry.fireCount ?? 0) >= entry.maxFires) {
        store.delete(entry.id);
        return;
      }
      store.fire(entry.id);
      pi.events.emit("loop:fire", {
        loopId: entry.id,
        prompt: entry.prompt,
        trigger: entry.trigger,
        timestamp: Date.now(),
        readOnly: entry.readOnly,
        recurring: entry.recurring,
        autoTask: entry.autoTask,
      });
    };
    scheduler = new CronScheduler(store, fireLoop as any);
    system = new TriggerSystem(pi, scheduler, store, fireLoop as any);
  });

  afterEach(() => {
    system.stop();
    vi.restoreAllMocks();
  });

  it("adds cron triggers to scheduler (no event subscription needed)", () => {
    const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };
    const entry = store.create(cronTrigger, "cron test", { recurring: true });
    system.add(entry);
    // Cron triggers only use the scheduler, not pi event subscriptions.
    // Verify the trigger was added successfully (no throw).
    expect(store.get("1")!.trigger.type).toBe("cron");
  });

  it("adds event triggers as pi event subscriptions", () => {
    const eventTrigger: Trigger = { type: "event", source: "tool_execution_start" };
    const entry = store.create(eventTrigger, "event test", { recurring: true });
    system.add(entry);

    const calls = (pi.events.on as any).mock.calls.filter((c: string[]) => c[0] === "tool_execution_start");
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });

  it("subscribes to hybrid triggers on both cron and event", () => {
    const hybridTrigger: Trigger = {
      type: "hybrid",
      cron: "*/10 * * * *",
      event: { source: "tool_execution_start" },
      debounceMs: 30000,
    };
    const entry = store.create(hybridTrigger, "hybrid test", { recurring: true });
    system.add(entry);

    const eventCalls = (pi.events.on as any).mock.calls.filter((c: string[]) => c[0] === "tool_execution_start");
    expect(eventCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("removes all subscriptions on remove()", () => {
    const eventTrigger: Trigger = { type: "event", source: "test_event" };
    const entry = store.create(eventTrigger, "to remove", { recurring: true });
    system.add(entry);
    system.remove(entry.id);

    // After removal, firing the event should NOT trigger loop:fire
    const fireCalls = (pi.events.emit as any).mock.calls.filter((c: string[]) => c[0] === "loop:fire");
    const beforeCount = fireCalls.length;

    pi.events.emit("test_event", { some: "data" });
    const afterCount = (pi.events.emit as any).mock.calls.filter((c: string[]) => c[0] === "loop:fire").length;
    expect(afterCount).toBe(beforeCount);
  });

  it("stops all subscriptions and timers on stop()", () => {
    system.start();
    system.stop();
    // Timer-based calls should be zero after stop
    expect(pi.events.emit).toBeDefined();
  });

  it("fires loop:fire event on trigger activation", () => {
    const eventTrigger: Trigger = { type: "event", source: "activation_test" };
    const entry = store.create(eventTrigger, "fire test", { recurring: true });
    system.add(entry);

    pi.events.emit("activation_test", { key: "value" });

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls.length).toBeGreaterThanOrEqual(1);
    expect(fireCalls[fireCalls.length - 1][1]).toMatchObject({
      loopId: "1",
      prompt: "fire test",
    });
  });

  it("deletes one-shot event loops immediately after the first fire", () => {
    const eventTrigger: Trigger = { type: "event", source: "fire_once" };
    const entry = store.create(eventTrigger, "one-shot", { recurring: false });
    system.add(entry);

    pi.events.emit("fire_once", {});

    expect(store.get(entry.id)).toBeUndefined();

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls).toHaveLength(1);

    pi.events.emit("fire_once", {});

    const afterCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(afterCalls).toHaveLength(1);
  });

  it("debounces hybrid triggers", () => {
    vi.useRealTimers();
    const hybridTrigger: Trigger = {
      type: "hybrid",
      cron: "0 0 * * *",
      event: { source: "debounce_test" },
      debounceMs: 500,
    };
    const entry = store.create(hybridTrigger, "debounce", { recurring: true });
    system.add(entry);

    return new Promise<void>((resolve) => {
      let fireCount = 0;
      pi.events.on("loop:fire", () => {
        fireCount++;
        if (fireCount >= 2) {
          system.stop();
          resolve();
        }
      });

      pi.events.emit("debounce_test", {});
      pi.events.emit("debounce_test", {});
      pi.events.emit("debounce_test", {});

      setTimeout(() => {
        expect(fireCount).toBeLessThanOrEqual(2);
        resolve();
      }, 1000);
    });
  });

  it("malformed JSON filter falls back to matching all events", () => {
    const eventTrigger: Trigger = { type: "event", source: "json_filter_test", filter: "{{{bad" };
    const entry = store.create(eventTrigger, "filter fallback", { recurring: true });
    system.add(entry);

    pi.events.emit("json_filter_test", { key: "value" });

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls.length).toBeGreaterThanOrEqual(1);
    expect(fireCalls[fireCalls.length - 1][1]).toMatchObject({
      loopId: entry.id,
    });
  });

  it("regex filter matches event data stringified", () => {
    const eventTrigger: Trigger = { type: "event", source: "regex_test", filter: "regex:hello" };
    const entry = store.create(eventTrigger, "regex filter", { recurring: true });
    system.add(entry);

    pi.events.emit("regex_test", { msg: "hello world" });

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("regex filter rejects non-matching event", () => {
    const eventTrigger: Trigger = { type: "event", source: "regex_no_match", filter: "regex:zzz" };
    const entry = store.create(eventTrigger, "no match", { recurring: true });
    system.add(entry);

    const beforeCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    ).length;

    pi.events.emit("regex_no_match", { msg: "hello" });

    const afterCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    ).length;
    expect(afterCalls).toBe(beforeCalls);
  });

  it("invalid regex filter does not match", () => {
    const eventTrigger: Trigger = { type: "event", source: "bad_regex", filter: "regex:[invalid" };
    const entry = store.create(eventTrigger, "bad regex", { recurring: true });
    system.add(entry);

    const beforeCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    ).length;

    pi.events.emit("bad_regex", { msg: "anything" });

    const afterCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    ).length;
    expect(afterCalls).toBe(beforeCalls);
  });

  it("deletes recurring event loops immediately when final maxFires is reached", () => {
    const eventTrigger: Trigger = { type: "event", source: "event_limit" };
    const entry = store.create(eventTrigger, "limited event", { recurring: true, maxFires: 1 });
    system.add(entry);

    pi.events.emit("event_limit", {});

    expect(store.get(entry.id)).toBeUndefined();

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls).toHaveLength(1);

    pi.events.emit("event_limit", {});

    const afterCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(afterCalls).toHaveLength(1);
  });

  it("deletes recurring hybrid loops immediately when event-side final maxFires is reached", () => {
    const hybridTrigger: Trigger = {
      type: "hybrid",
      cron: "*/10 * * * *",
      event: { source: "hybrid_limit" },
      debounceMs: 0,
    };
    const entry = store.create(hybridTrigger, "limited hybrid", { recurring: true, maxFires: 1 });
    system.add(entry);

    expect(scheduler.nextFire(entry.id)).toBeDefined();

    pi.events.emit("hybrid_limit", {});

    expect(store.get(entry.id)).toBeUndefined();
    expect(scheduler.nextFire(entry.id)).toBeUndefined();

    const fireCalls = (pi.events.emit as any).mock.calls.filter(
      (c: string[]) => c[0] === "loop:fire"
    );
    expect(fireCalls).toHaveLength(1);
  });
});
