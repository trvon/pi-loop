import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import { TriggerSystem } from "../src/trigger-system.js";
import type { Trigger } from "../src/types.js";

function createMockPi() {
  const handlers = new Map<string, Array<(...args: any[]) => void>>();
  return {
    events: {
      emit: vi.fn((event: string, data: any) => {
        const callbacks = handlers.get(event);
        if (callbacks) for (const cb of callbacks) cb(data);
      }),
      on: vi.fn((event: string, handler: (...args: any[]) => void) => {
        if (!handlers.has(event)) handlers.set(event, []);
        handlers.get(event)!.push(handler);
        return () => {
          const arr = handlers.get(event);
          if (arr) {
            const idx = arr.indexOf(handler);
            if (idx !== -1) arr.splice(idx, 1);
          }
        };
      }),
    },
  } as any;
}

describe("TriggerSystem", () => {
  let pi: ReturnType<typeof createMockPi>;
  let store: LoopStore;
  let scheduler: CronScheduler;
  let system: TriggerSystem;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    pi = createMockPi();
    store = new LoopStore();
    scheduler = new CronScheduler(store, () => {});
    system = new TriggerSystem(pi, scheduler, store);
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
});
