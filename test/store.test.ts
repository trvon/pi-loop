import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import type { Trigger, WorkflowRunState } from "../src/types.js";

const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };

describe("LoopStore (in-memory)", () => {
  let store: LoopStore;

  beforeEach(() => {
    store = new LoopStore();
  });

  it("creates loops with auto-incrementing IDs", () => {
    const l1 = store.create(cronTrigger, "check deploy", { recurring: true });
    const l2 = store.create(cronTrigger, "check tests", { recurring: true });

    expect(l1.id).toBe("1");
    expect(l2.id).toBe("2");
    expect(l1.status).toBe("active");
    expect(l1.prompt).toBe("check deploy");
    expect(l1.trigger.type).toBe("cron");
  });

  it("sets expiry 7 days from creation", () => {
    const l = store.create(cronTrigger, "test", { recurring: true });
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    expect(l.expiresAt).toBeGreaterThan(l.createdAt + sevenDays - 1000);
    expect(l.expiresAt).toBeLessThan(l.createdAt + sevenDays + 1000);
  });

  it("gets a loop by ID", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const entry = store.get("1");
    expect(entry).toBeDefined();
    expect(entry!.prompt).toBe("test");
  });

  it("returns undefined for non-existent loop", () => {
    expect(store.get("999")).toBeUndefined();
  });

  it("lists all loops sorted by ID", () => {
    store.create(cronTrigger, "loop 3", { recurring: true });
    store.create(cronTrigger, "loop 1", { recurring: true });
    store.create(cronTrigger, "loop 2", { recurring: true });

    const loops = store.list();
    expect(loops.map(l => l.id)).toEqual(["1", "2", "3"]);
  });

  it("deletes a loop", () => {
    store.create(cronTrigger, "test", { recurring: true });
    expect(store.delete("1")).toBe(true);
    expect(store.get("1")).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });

  it("returns false when deleting non-existent loop", () => {
    expect(store.delete("999")).toBe(false);
  });

  it("pauses loops explicitly", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const entry = store.pause("1");

    expect(entry!.status).toBe("paused");
  });

  it("resumes loops explicitly", () => {
    store.create(cronTrigger, "test", { recurring: true });
    store.pause("1");
    const entry = store.resume("1");

    expect(entry!.status).toBe("active");
  });

  it("atomically pauses a workflow that reaches a paused terminal state", () => {
    store.create({ type: "dynamic" }, "Investigate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "investigate",
        states: {
          investigate: { prompt: "Find the blocker.", on: { blocked: "blocked" } },
          blocked: { prompt: "Report the blocker.", terminal: "paused" },
        },
      },
    });
    const result = store.transitionWorkflow("1", { outcome: "blocked" });

    expect(result.terminal).toBe("paused");
    expect(store.resume("1")).toBeUndefined();
    expect(store.get("1")?.status).toBe("paused");
  });

  it("atomically removes a workflow that reaches a completed terminal state", () => {
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

    const result = store.transitionWorkflow(workflow.id, { outcome: "done" });

    expect(result).toMatchObject({
      applied: true,
      terminal: "completed",
      entry: { workflow: { currentState: "done" } },
    });
    expect(store.get(workflow.id)).toBeUndefined();
  });

  it("rejects a fire for a legacy active terminal workflow", () => {
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

    expect(store.fire(workflow.id)).toBeUndefined();
    expect(store.get(workflow.id)?.fireCount).toBe(0);
  });

  it("counts only scheduler fires toward a workflow state's cadence budget", () => {
    const workflow = store.create({ type: "dynamic" }, "Validate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: {
            prompt: "Run validation.",
            loop: { schedule: "*/5 * * * *", maxFires: 1 },
            on: { passed: "done" },
          },
          done: { prompt: "Report completion.", terminal: "completed" },
        },
      },
    });

    store.fire(workflow.id, "monitor");
    expect(store.get(workflow.id)?.workflow?.stateFireCounts).toEqual({});
    store.fire(workflow.id, "scheduler");
    expect(store.get(workflow.id)?.workflow?.stateFireCounts).toEqual({ validate: 1 });
  });

  it("updates loop prompt metadata", () => {
    store.create(cronTrigger, "original", { recurring: true });
    const { changedFields } = store.updateMetadata("1", { prompt: "updated" });

    expect(changedFields).toEqual(["prompt"]);
    expect(store.get("1")!.prompt).toBe("updated");
  });

  it("updates trigger metadata", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const newTrigger: Trigger = { type: "event", source: "tool_execution_start" };
    const { changedFields } = store.updateMetadata("1", { trigger: newTrigger });

    expect(changedFields).toEqual(["trigger"]);
    expect(store.get("1")!.trigger.type).toBe("event");
  });

  it("returns empty entry for non-existent metadata update", () => {
    const { entry, changedFields } = store.updateMetadata("999", { prompt: "missing" });
    expect(entry).toBeUndefined();
    expect(changedFields).toEqual([]);
  });

  it("clears expired loops", () => {
    const store2 = new LoopStore();

    store2.create(cronTrigger, "fresh", { recurring: true });

    expect(store2.list()).toHaveLength(1);
    expect(store2.clearExpired()).toBe(0);

    const entry = store2.get("1")!;
    (entry as any).expiresAt = Date.now() - 1000;

    expect(store2.clearExpired()).toBe(1);
    expect(store2.list()).toHaveLength(0);
  });

  it("pauses expired workflows instead of deleting them", () => {
    const workflow = store.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });
    workflow.expiresAt = Date.now() - 1;

    expect(store.clearExpired()).toBe(1);
    expect(store.get(workflow.id)?.status).toBe("paused");
  });

  it("clears all loops", () => {
    store.create(cronTrigger, "a", { recurring: true });
    store.create(cronTrigger, "b", { recurring: true });
    expect(store.clearAll()).toBe(2);
    expect(store.list()).toHaveLength(0);
  });

  it("can clear ordinary loops while preserving workflows for safe reconciliation", () => {
    store.create(cronTrigger, "ordinary", { recurring: true });
    const workflow = store.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });

    expect(store.clearAll({ preserveWorkflows: true })).toBe(2);
    expect(store.get("1")).toBeUndefined();
    expect(store.get(workflow.id)?.status).toBe("paused");
  });

  it("expires event-triggered loops on session start", () => {
    const s = new LoopStore();
    const eventTrigger = { type: "event" as const, source: "monitor:done" };
    const cronT = { type: "cron" as const, schedule: "*/5 * * * *" };

    s.create(eventTrigger, "event loop", { recurring: false });
    s.create(cronT, "cron loop", { recurring: true });
    s.create(eventTrigger, "another event", { recurring: true });
    s.create({ type: "event", source: "tasks:created" }, "backlog worker", { recurring: true, taskBacklog: true });

    // sessionStartedAt is set after creation — simulating loop persisted from prior session
    const sessionStartedAt = Date.now() + 1;
    expect(s.expireEventLoops(sessionStartedAt)).toBe(2);

    expect(s.get("2")!.status).toBe("active"); // cron loop untouched
    expect(s.get("1")).toBeUndefined(); // ordinary event loops deleted
    expect(s.get("3")).toBeUndefined();
    expect(s.get("4")?.status).toBe("active"); // backlog controller survives to adopt unfinished work
  });

  it("does not expire event loops created in current session", () => {
    const s = new LoopStore();
    const eventTrigger = { type: "event" as const, source: "monitor:done" };
    const hybridTrigger = {
      type: "hybrid" as const, cron: "*/5 * * * *", event: { source: "test" }, debounceMs: 30000,
    };

    // sessionStartedAt before creation — simulating loops created in current session
    const sessionStartedAt = Date.now();
    s.create(eventTrigger, "event loop", { recurring: true });
    s.create(hybridTrigger, "hybrid loop", { recurring: true });

    expect(s.expireEventLoops(sessionStartedAt)).toBe(0);
    expect(s.get("1")!.status).toBe("active");
    expect(s.get("2")!.status).toBe("active");
  });

  it("enforces max loop limit", () => {
    for (let i = 0; i < 25; i++) {
      store.create(cronTrigger, `loop ${i}`, { recurring: true });
    }
    expect(() => store.create(cronTrigger, "overflow", { recurring: true })).toThrow("Maximum of 25 loops");
  });

  it("stores event triggers", () => {
    const eventTrigger: Trigger = { type: "event", source: "tool_execution_start" };
    const l = store.create(eventTrigger, "react to event", { recurring: false });
    expect(l.trigger.type).toBe("event");
    expect((l.trigger as any).source).toBe("tool_execution_start");
  });

  it("stores hybrid triggers", () => {
    const hybridTrigger: Trigger = {
      type: "hybrid",
      cron: "*/5 * * * *",
      event: { source: "tool_execution_start" },
      debounceMs: 30000,
    };
    const l = store.create(hybridTrigger, "hybrid check", { recurring: true });
    expect(l.trigger.type).toBe("hybrid");
    expect((l.trigger as any).debounceMs).toBe(30000);
  });

  it("stores dynamic loop state", () => {
    const dynamicTrigger: Trigger = { type: "dynamic" };
    const l = store.create(dynamicTrigger, "finish release", {
      recurring: true,
      maxFires: 20,
      dynamic: {
        goal: "finish release",
        state: "tests pending",
        metrics: "0/3 checks passing",
        doneCriteria: "lint/typecheck/test pass",
      },
    });

    expect(l.trigger.type).toBe("dynamic");
    expect(l.dynamic).toMatchObject({
      goal: "finish release",
      state: "tests pending",
      metrics: "0/3 checks passing",
      doneCriteria: "lint/typecheck/test pass",
      iteration: 0,
      awaitingUpdate: false,
    });
    expect(l.dynamic?.lastUpdatedAt).toBe(l.createdAt);
  });

  it("rejects a stale dynamic continuation without overwriting newer progress", () => {
    const entry = store.create({ type: "dynamic" }, "ship", { recurring: true });
    const expected = { status: entry.status, iteration: entry.dynamic?.iteration ?? 0, updatedAt: entry.updatedAt };
    store.updateDynamic(entry.id, { dynamic: { state: "newer", iteration: 1 } });

    expect(store.continueDynamic(entry.id, { dynamic: { state: "stale", iteration: 1 } }, expected)).toBeUndefined();
    expect(store.stopDynamic(entry.id, "completed", expected)).toBe(false);
    expect(store.get(entry.id)?.dynamic?.state).toBe("newer");
  });

  it("defaults dynamic goal to the prompt", () => {
    const l = store.create({ type: "dynamic" }, "ship the fix", { recurring: true });
    expect(l.dynamic?.goal).toBe("ship the fix");
    expect(l.dynamic?.iteration).toBe(0);
  });

  it("stores autoTask flag", () => {
    const l = store.create(cronTrigger, "test", { recurring: true, autoTask: true });
    expect(l.autoTask).toBe(true);
  });

  it("stores maxFires and initializes fireCount to 0", () => {
    const l = store.create(cronTrigger, "limited", { recurring: true, maxFires: 5 });
    expect(l.maxFires).toBe(5);
    expect(l.fireCount).toBe(0);
  });

  it("keeps short-lived deletion tombstones", () => {
    store.create(cronTrigger, "auto worker", { recurring: true });
    const tombstone = store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    store.delete("1");

    expect(tombstone).toMatchObject({
      id: "1",
      reason: "task_backlog_empty",
      prompt: "auto worker",
      pendingCount: 0,
    });
    expect(store.getDeletionTombstone("1")?.reason).toBe("task_backlog_empty");
  });

  it("drops stale deletion tombstones", () => {
    store.create(cronTrigger, "auto worker", { recurring: true });
    const tombstone = store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 })!;
    store.delete("1");
    tombstone.deletedAt = Date.now() - 11 * 60 * 1000;

    expect(store.getDeletionTombstone("1")).toBeUndefined();
  });

  it("does not record deletion tombstones for missing loops", () => {
    expect(store.recordDeletionTombstone("404", { reason: "task_backlog_empty", pendingCount: 0 })).toBeUndefined();
  });

  it("increments fireCount via explicit fire", () => {
    store.create(cronTrigger, "count test", { recurring: true });
    store.fire("1");
    store.fire("1");
    store.fire("1");
    expect(store.get("1")!.fireCount).toBe(3);
  });
});

describe("LoopStore (file-backed)", () => {
  const filePath = join(tmpdir(), `pi-loop-store-${Date.now()}.json`);

  afterEach(() => {
    rmSync(filePath, { force: true });
    rmSync(filePath + ".lock", { force: true });
    rmSync(filePath + ".tmp", { force: true });
  });

  it("persists loops to disk", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "persist test", { recurring: true });

    const store2 = new LoopStore(filePath);
    const loops = store2.list();
    expect(loops).toHaveLength(1);
    expect(loops[0].prompt).toBe("persist test");
  });

  it("persists dynamic loop state to disk", () => {
    const store1 = new LoopStore(filePath);
    store1.create({ type: "dynamic" }, "finish dynamic loop", {
      recurring: true,
      dynamic: {
        goal: "finish dynamic loop",
        state: "router done",
        metrics: "1/5 tasks complete",
      },
    });

    const store2 = new LoopStore(filePath);
    expect(store2.get("1")?.dynamic).toMatchObject({
      goal: "finish dynamic loop",
      state: "router done",
      metrics: "1/5 tasks complete",
      iteration: 0,
    });
  });

  it("keeps deletion tombstones process-local", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "auto worker", { recurring: true });
    store1.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    store1.delete("1");

    const store2 = new LoopStore(filePath);
    expect(store1.getDeletionTombstone("1")?.reason).toBe("task_backlog_empty");
    expect(store2.getDeletionTombstone("1")).toBeUndefined();
  });

  it("persists ID counter across instances", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "first", { recurring: true });

    const store2 = new LoopStore(filePath);
    const l = store2.create(cronTrigger, "second", { recurring: true });
    expect(l.id).toBe("2");
  });

  it("refreshes reads only when the backing file changes", () => {
    const store1 = new LoopStore(filePath);
    const store2 = new LoopStore(filePath);

    store1.create(cronTrigger, "first", { recurring: true });
    expect(store2.list()).toHaveLength(1);

    store1.create(cronTrigger, "second", { recurring: true });
    expect(store2.list()).toHaveLength(2);
    expect(store2.get("2")?.prompt).toBe("second");
  });

  it("persists paused status updates", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "test", { recurring: true });
    store1.pause("1");

    const store2 = new LoopStore(filePath);
    expect(store2.get("1")!.status).toBe("paused");
  });

  it("persists deletions", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "test", { recurring: true });
    store1.delete("1");

    const store2 = new LoopStore(filePath);
    expect(store2.list()).toHaveLength(0);
  });

  it("does not restore a completed workflow controller after restart", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Finish", {
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

    expect(store1.transitionWorkflow(workflow.id, { outcome: "done" }).terminal).toBe("completed");

    const restartedStore = new LoopStore(filePath);
    expect(restartedStore.get(workflow.id)).toBeUndefined();
  });

  it("allows another project runtime to claim the next workflow phase immediately", () => {
    const implementer = { sessionId: "session-a", runtimeId: "runtime-a" };
    const reviewer = { sessionId: "session-b", runtimeId: "runtime-b" };
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Implement and review", {
      recurring: true,
      actor: implementer,
      workflow: {
        version: 1,
        initialState: "implement",
        states: {
          implement: {
            prompt: "Implement the change.",
            task: { subject: "Implement", description: "Write the change." },
            on: { ready: "review" },
          },
          review: {
            prompt: "Review the change.",
            task: { subject: "Review", description: "Review the implementation." },
            on: { approved: "done" },
          },
          done: { prompt: "Report completion.", terminal: "completed" },
        },
      },
    });

    expect(store1.transitionWorkflow(workflow.id, {
      outcome: "ready",
      evidence: "Implementation complete",
      actor: implementer,
    }).applied).toBe(true);

    const store2 = new LoopStore(filePath);
    const claim = store2.claimWorkflowExecution(workflow.id, reviewer, 60);

    expect(claim.claimed, claim.error).toBe(true);
    expect(claim.entry).toMatchObject({
      workflow: {
        currentState: "review",
        activeExecution: {
          stateId: "review",
          lease: { ownerSessionId: "session-b", ownerRuntimeId: "runtime-b" },
        },
      },
    });
  });

  it("does not arm a persisted legacy active terminal workflow after restart", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Finish", {
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
    const activeTerminal = store1.get(workflow.id)!;
    const snapshot = {
      ...activeTerminal,
      dynamic: { ...activeTerminal.dynamic, state: "done" },
      workflow: { ...activeTerminal.workflow!, currentState: "done" },
    };
    writeFileSync(filePath, JSON.stringify({ nextId: 2, loops: [snapshot] }));

    const restartedStore = new LoopStore(filePath);
    const scheduler = new CronScheduler(restartedStore, () => {
      throw new Error("terminal workflow must not fire");
    });
    scheduler.start();

    expect(scheduler.nextFire(workflow.id)).toBeUndefined();
  });
});

describe("LoopStore (absolute path)", () => {
  const absFilePath = join(tmpdir(), `pi-loop-test-${Date.now()}.json`);

  afterEach(() => {
    rmSync(absFilePath, { force: true });
    rmSync(absFilePath + ".lock", { force: true });
    rmSync(absFilePath + ".tmp", { force: true });
  });

  it("accepts absolute path", () => {
    const store1 = new LoopStore(absFilePath);
    store1.create(cronTrigger, "abs test", { recurring: true });

    const store2 = new LoopStore(absFilePath);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].prompt).toBe("abs test");
  });

  it("attaches a monitor wait and clears only its matching terminal result", () => {
    const store = new LoopStore();
    const workflow = store.create({ type: "dynamic" }, "Validate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: { prompt: "Run validation.", on: { passed: "done", failed: "blocked" } },
          done: { prompt: "Report success.", terminal: "completed" },
          blocked: { prompt: "Report failure.", terminal: "paused" },
        },
      },
    });
    const attached = store.attachWorkflowMonitor(workflow.id, "18", {
      stateId: "validate",
      transitionSeq: 0,
    });
    const wait = attached?.workflow?.waitingMonitor;

    expect(wait).toMatchObject({ monitorId: "18", stateId: "validate", transitionSeq: 0 });
    expect(store.completeWorkflowMonitorWait(workflow.id, {
      ...wait!,
      monitorId: "other",
    })).toBeUndefined();
    expect(store.get(workflow.id)?.workflow?.waitingMonitor).toMatchObject({ monitorId: "18" });

    const completed = store.completeWorkflowMonitorWait(workflow.id, wait!);
    expect(completed?.workflow?.waitingMonitor).toBeUndefined();
  });

  it("clears a monitor wait when an explicit workflow transition wins", () => {
    const store = new LoopStore();
    const workflow = store.create({ type: "dynamic" }, "Validate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "validate",
        states: {
          validate: { prompt: "Run validation.", on: { passed: "done" } },
          done: { prompt: "Report success.", terminal: "completed" },
        },
      },
    });
    store.attachWorkflowMonitor(workflow.id, "18", { stateId: "validate", transitionSeq: 0 });

    const transition = store.transitionWorkflow(workflow.id, { outcome: "passed" });

    expect(transition.entry?.workflow?.waitingMonitor).toBeUndefined();
  });

  it("clears stale pid-based lock on create", () => {
    const lPath = join(tmpdir(), `pi-loop-stale-${Date.now()}.json`);
    const lockPath = lPath + ".lock";
    try {
      writeFileSync(lockPath, "99999");
      const s = new LoopStore(lPath);
      const entry = s.create(cronTrigger, "stale lock test", { recurring: true });
      expect(entry.id).toBe("1");
      expect(entry.prompt).toBe("stale lock test");
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it("clears stale pid-based lock on delete", () => {
    const lPath = join(tmpdir(), `pi-loop-stale-${Date.now()}.json`);
    const lockPath = lPath + ".lock";
    try {
      const s1 = new LoopStore(lPath);
      s1.create(cronTrigger, "setup", { recurring: true });

      writeFileSync(lockPath, "99999");
      const s2 = new LoopStore(lPath);
      expect(s2.delete("1")).toBe(true);
      expect(s2.list()).toHaveLength(0);
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it("survives stale lock with unparseable pid", () => {
    const lPath = join(tmpdir(), `pi-loop-stale-${Date.now()}.json`);
    const lockPath = lPath + ".lock";
    try {
      writeFileSync(lockPath, "garbage");
      const s = new LoopStore(lPath);
      const entry = s.create(cronTrigger, "bad lock", { recurring: true });
      expect(entry.id).toBe("1");
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });
});

describe("LoopStore workflow execution leases", () => {
  const workflow = {
    version: 1 as const,
    initialState: "work",
    states: {
      work: {
        prompt: "Do the work.",
        task: { subject: "Work", description: "Complete it." },
        on: { done: "complete" },
      },
      complete: { prompt: "Report.", terminal: "completed" as const },
    },
  };

  it("normalizes legacy activeTaskId on load and fails closed until claimed", () => {
    const lPath = join(tmpdir(), `pi-loop-legacy-workflow-${Date.now()}.json`);
    const legacy = {
      nextId: 2,
      loops: [{
        id: "1",
        prompt: "legacy",
        trigger: { type: "dynamic" },
        status: "active",
        recurring: true,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000,
        dynamic: { goal: "legacy", state: "work", iteration: 0 },
        workflow: {
          definition: {
            version: 1,
            initialState: "work",
            states: {
              work: {
                prompt: "Do the work.",
                task: { subject: "Legacy work", description: "Old model task." },
                on: { done: "complete" },
              },
              complete: { prompt: "Report.", terminal: "completed" },
            },
          },
          currentState: "work",
          transitionSeq: 2,
          stateEnteredAt: 1,
          attemptsByState: { work: 3 },
          stateFireCounts: {},
          activeTaskId: "7",
        },
      }],
    };
    writeFileSync(lPath, JSON.stringify(legacy));
    try {
      const store = new LoopStore(lPath);
      const workflow = store.get("1")?.workflow as (WorkflowRunState & { activeTaskId?: string }) | undefined;
      expect(workflow?.activeTaskId).toBeUndefined();
      expect(workflow?.activeExecution).toMatchObject({
        id: "work:2",
        stateId: "work",
        transitionSeq: 2,
        status: "active",
        subject: "Legacy work",
      });
      expect(workflow?.activeExecution?.lease).toBeUndefined();
      const foreign = { sessionId: "session-b", runtimeId: "runtime-b" };
      expect(store.claimWorkflowExecution("1", foreign, 60).claimed).toBe(true);
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it("renews its owner and only permits takeover after expiry", () => {
    const store = new LoopStore();
    const owner = { sessionId: "session-a", runtimeId: "runtime-a" };
    const foreign = { sessionId: "session-b", runtimeId: "runtime-b" };
    store.create({ type: "dynamic" }, "workflow", { recurring: true, workflow, actor: owner });

    expect(store.claimWorkflowExecution("1", owner, 60).claimed).toBe(true);
    expect(store.claimWorkflowExecution("1", foreign, 60)).toMatchObject({
      claimed: false,
      error: "Workflow execution is leased to another active runtime",
    });

    const active = store.get("1")?.workflow?.activeExecution;
    if (!active?.lease) throw new Error("expected active lease");
    active.lease.expiresAt = Date.now() - 1;
    expect(store.claimWorkflowExecution("1", foreign, 60)).toMatchObject({
      claimed: true,
      entry: { workflow: { activeExecution: { lease: { ownerSessionId: "session-b", ownerRuntimeId: "runtime-b", attempt: 2 } } } },
    });
  });

  it("clamps out-of-range lease durations", () => {
    const store = new LoopStore();
    const owner = { sessionId: "session-a", runtimeId: "runtime-a" };
    store.create({ type: "dynamic" }, "workflow", { recurring: true, workflow, actor: owner });

    expect(store.claimWorkflowExecution("1", owner, 1).claimed).toBe(true);
    expect(store.get("1")?.workflow?.activeExecution?.lease?.expiresAt).toBeGreaterThan(Date.now() + 55_000);

    expect(store.claimWorkflowExecution("1", owner, 999_999).claimed).toBe(true);
    expect(store.get("1")?.workflow?.activeExecution?.lease?.expiresAt).toBeLessThan(Date.now() + 3_700_000);
  });
});
