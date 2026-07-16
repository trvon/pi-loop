import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import type { Trigger } from "../src/types.js";

const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };

describe("CronScheduler", () => {
  let store: LoopStore;
  let scheduler: CronScheduler;
  let fired: string[];

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    store = new LoopStore();
    fired = [];
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
    });
  });

  afterEach(() => {
    scheduler.stop();
    vi.restoreAllMocks();
  });

  it("fires a one-shot cron loop via pump", () => {
    const entry = store.create(cronTrigger, "test fire", { recurring: false });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("does not fire paused loops", () => {
    const entry = store.create(cronTrigger, "paused test", { recurring: false });
    store.pause(entry.id);
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("removes on delete before pump", () => {
    const entry = store.create(cronTrigger, "will be deleted", { recurring: false });
    scheduler.add(entry);
    scheduler.remove("1");

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("pump fires recurring loops multiple times when time advances far enough", () => {
    const entry = store.create(cronTrigger, "recurring", { recurring: true });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired.length).toBeGreaterThanOrEqual(2);
  });

  it("stop clears fireTimes", () => {
    store.create(cronTrigger, "loop 1", { recurring: false });
    store.create(cronTrigger, "loop 2", { recurring: false });
    scheduler.start();
    scheduler.stop();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("ignores event-only triggers", () => {
    const eventTrigger: Trigger = { type: "event", source: "test" };
    store.create(eventTrigger, "event loop", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("fires idle-driven dynamic loops on the next pump", () => {
    const entry = store.create({ type: "dynamic" }, "finish goal", {
      recurring: true,
      dynamic: { goal: "finish goal", iteration: 0 },
    });
    scheduler.add(entry);

    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("does not refire idle-driven dynamic loops while awaiting update", () => {
    const entry = store.create({ type: "dynamic" }, "finish goal", {
      recurring: true,
      dynamic: { goal: "finish goal", iteration: 0, awaitingUpdate: true },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("recovers persisted awaiting dynamic loops when the scheduler starts", () => {
    store.create({ type: "dynamic" }, "recover goal", {
      recurring: true,
      dynamic: { goal: "recover goal", iteration: 2, awaitingUpdate: true },
    });

    scheduler.start();
    scheduler.pump(Date.now());

    expect(fired).toEqual(["1"]);
    expect(store.get("1")?.dynamic?.awaitingUpdate).toBe(false);
  });

  it("does not recover awaiting dynamic loops already armed in the current runtime", () => {
    const entry = store.create({ type: "dynamic" }, "current goal", {
      recurring: true,
      dynamic: { goal: "current goal", iteration: 1, awaitingUpdate: true },
    });
    scheduler.add(entry);

    scheduler.start();
    scheduler.pump(Date.now());

    expect(fired).toHaveLength(0);
    expect(store.get("1")?.dynamic?.awaitingUpdate).toBe(true);
  });

  it("uses dynamic nextWakeAt when provided", () => {
    const entry = store.create({ type: "dynamic" }, "finish goal", {
      recurring: true,
      dynamic: { goal: "finish goal", iteration: 0, nextWakeAt: Date.now() + 60 * 1000 },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("fires stale dynamic nextWakeAt on the next pump", () => {
    const entry = store.create({ type: "dynamic" }, "stale goal", {
      recurring: true,
      dynamic: { goal: "stale goal", iteration: 0, nextWakeAt: Date.now() - 1000 },
    });
    scheduler.add(entry);

    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("re-arms recurring dynamic loops from updated nextWakeAt", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
      store.updateDynamic(entry.id, {
        dynamic: {
          nextWakeAt: Date.now() + 30 * 1000,
          awaitingUpdate: false,
        },
      });
    });
    const entry = store.create({ type: "dynamic" }, "recurring dynamic", {
      recurring: true,
      dynamic: { goal: "recurring dynamic", iteration: 0, nextWakeAt: Date.now() + 60 * 1000 },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toEqual(["1"]);

    vi.advanceTimersByTime(29 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toEqual(["1"]);

    vi.advanceTimersByTime(1000);
    scheduler.pump(Date.now());
    expect(fired).toEqual(["1", "1"]);
  });

  it("deletes recurring dynamic loops after maxFires", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
    });
    const entry = store.create({ type: "dynamic" }, "limited dynamic", {
      recurring: true,
      maxFires: 1,
      dynamic: { goal: "limited dynamic", iteration: 0, nextWakeAt: Date.now() + 1000 },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(1000);
    scheduler.pump(Date.now());

    expect(fired).toContain("1");
    expect(store.get(entry.id)).toBeUndefined();
    expect(scheduler.nextFire(entry.id)).toBeUndefined();
  });

  it("loads existing loops on start and fires via pump", () => {
    store.create(cronTrigger, "existing", { recurring: false });
    scheduler.start();

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("tracks nextFire times", () => {
    const entry = store.create(cronTrigger, "tracked", { recurring: false });
    scheduler.add(entry);

    const nextFire = scheduler.nextFire("1");
    expect(nextFire).toBeDefined();
    expect(nextFire!).toBeGreaterThan(Date.now());
  });

  it("returns undefined for untracked IDs", () => {
    expect(scheduler.nextFire("999")).toBeUndefined();
  });

  it("pump does not fire when time has not reached nextFire", () => {
    const entry = store.create(cronTrigger, "not yet", { recurring: false });
    scheduler.add(entry);

    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
  });

  it("deletes expired entries on pump", () => {
    const entry = store.create(cronTrigger, "expired", { recurring: false });
    entry.expiresAt = Date.now() - 1;
    scheduler.add(entry);

    vi.advanceTimersByTime(10 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);
    expect(store.get(entry.id)).toBeUndefined();
  });
});
