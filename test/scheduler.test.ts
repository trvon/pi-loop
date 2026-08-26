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

  it("does not arm LoopStore-owned orchestration in the generic scheduler", () => {
    const entry = store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect" }] },
      },
    });

    scheduler.add(entry);
    scheduler.pump(Date.now());

    expect(scheduler.nextFire(entry.id)).toBeUndefined();
    expect(fired).toEqual([]);
  });

  it("fires a one-shot cron loop via pump", () => {
    const entry = store.create(cronTrigger, "test fire", { recurring: false });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toContain("1");
  });

  it("deletes a fired cron one-shot so restart cannot re-arm it", () => {
    const entry = store.create(cronTrigger, "one shot", { recurring: false });
    scheduler.add(entry);

    vi.advanceTimersByTime(6 * 60 * 1000);
    scheduler.pump(Date.now());

    expect(fired).toEqual([entry.id]);
    expect(store.get(entry.id)).toBeUndefined();
    scheduler.stop();
    scheduler = new CronScheduler(store, (loop) => fired.push(loop.id));
    scheduler.start();
    expect(scheduler.nextFire(entry.id)).toBeUndefined();
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

  it("arms only the active workflow state's cron policy", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
    });
    const entry = store.create({ type: "dynamic" }, "Process records", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "collect",
        states: {
          collect: { prompt: "Collect records.", loop: { schedule: "0 7 * * *" }, on: { ready: "publish" } },
          publish: { prompt: "Publish records.", loop: { schedule: "*/1 * * * *" }, on: { done: "complete" } },
          complete: { prompt: "Finished.", terminal: "completed" },
        },
      },
      dynamic: { goal: "Process records", iteration: 0 },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toHaveLength(0);

    const transitioned = store.transitionWorkflow(entry.id, { outcome: "ready" });
    if (!transitioned.entry) throw new Error("expected workflow transition");
    scheduler.remove(entry.id);
    scheduler.add(transitioned.entry);

    vi.advanceTimersByTime(2 * 60 * 1000);
    scheduler.pump(Date.now());
    expect(fired).toEqual([entry.id]);
    expect(store.get(entry.id)?.workflow?.stateFireCounts).toEqual({ publish: 1 });
  });

  it("pauses a workflow when its active state reaches its local fire cap", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
    });
    const entry = store.create({ type: "dynamic" }, "Process records", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "collect",
        states: {
          collect: { prompt: "Collect records.", loop: { schedule: "*/1 * * * *", maxFires: 1 }, on: { ready: "complete" } },
          complete: { prompt: "Finished.", terminal: "completed" },
        },
      },
      dynamic: { goal: "Process records", iteration: 0 },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(2 * 60 * 1000);
    scheduler.pump(Date.now());

    expect(fired).toEqual([entry.id]);
    expect(store.get(entry.id)?.status).toBe("paused");
    expect(store.get(entry.id)?.workflow?.stateFireCounts).toEqual({ collect: 1 });
  });

  it("does not arm a legacy active terminal workflow after restart", () => {
    const workflow = store.create({ type: "dynamic" }, "Finish", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Do the work.", on: { done: "done" } },
          done: { prompt: "Report completion.", terminal: "completed" },
        },
      },
    });
    const stale = store.get(workflow.id)!;
    stale.workflow!.currentState = "done";

    scheduler.start();
    scheduler.pump(Date.now());

    expect(scheduler.nextFire(workflow.id)).toBeUndefined();
    expect(fired).toEqual([]);
  });

  it("suppresses workflow cadence while waiting on a monitor", () => {
    const entry = store.create({ type: "dynamic" }, "Validate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: { prompt: "Run validation.", loop: { schedule: "*/1 * * * *" }, on: { passed: "done" } },
          done: { prompt: "Report success.", terminal: "completed" },
        },
      },
    });
    const attached = store.attachWorkflowMonitor(entry.id, "18", {
      stateId: "validate",
      transitionSeq: 0,
    });
    if (!attached) throw new Error("expected workflow monitor attachment");

    scheduler.add(attached);
    scheduler.start();
    vi.advanceTimersByTime(2 * 60 * 1000);
    scheduler.pump(Date.now());

    expect(scheduler.nextFire(entry.id)).toBeUndefined();
    expect(fired).toEqual([]);
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

  it("does not refire a loop-less workflow while awaiting transition", () => {
    const entry = store.create({ type: "dynamic" }, "Validate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: { prompt: "Run validation.", on: { passed: "done" } },
          done: { prompt: "Report success.", terminal: "completed" },
        },
      },
      dynamic: { goal: "Validate", iteration: 0, awaitingUpdate: true },
    });

    scheduler.add(entry);
    scheduler.pump(Date.now());

    expect(fired).toEqual([]);
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

  it("pauses maxed workflows instead of orphaning their active task", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
    });
    const entry = store.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      maxFires: 1,
      dynamic: { goal: "workflow", iteration: 0, nextWakeAt: Date.now() + 1000 },
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(1000);
    scheduler.pump(Date.now());

    expect(store.get(entry.id)?.status).toBe("paused");
    expect(scheduler.nextFire(entry.id)).toBeUndefined();
  });

  it("pauses maxed hybrid backlog workers instead of discarding unfinished ownership", () => {
    scheduler = new CronScheduler(store, (entry) => {
      fired.push(entry.id);
      store.fire(entry.id);
    });
    const entry = store.create({
      type: "hybrid",
      cron: "*/5 * * * *",
      event: { source: "tasks:created" },
      debounceMs: 30_000,
    }, "bounded backlog", {
      recurring: true,
      taskBacklog: true,
      maxFires: 1,
    });
    scheduler.add(entry);

    vi.advanceTimersByTime(5 * 60 * 1000);
    scheduler.pump(Date.now());

    expect(store.get(entry.id)?.status).toBe("paused");
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
