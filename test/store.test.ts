import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LOOP_EXPIRY_MS } from "../src/loop-expiry.js";
import { CronScheduler } from "../src/scheduler.js";
import { LoopStore } from "../src/store.js";
import type { Trigger, WorkflowRunState } from "../src/types.js";
import { currentMonitorAttachmentIdentity, currentWorkflowIdentity } from "./helpers/workflow-identity.js";

const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };
const trustedAdmission = {
  claimClass: "environmental" as const,
  provider: "test",
  subject: "release",
  fact: "failed",
  expected: true,
  observations: ["test@1"],
  decidedAt: 1,
};

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

  it("uses the seven-day fallback, configured default, and per-loop override", () => {
    const fallback = store.create(cronTrigger, "fallback", { recurring: true });
    expect(fallback.expiresAt - fallback.createdAt).toBe(DEFAULT_LOOP_EXPIRY_MS);

    const configured = new LoopStore(undefined, 14 * 24 * 60 * 60 * 1000);
    const inherited = configured.create(cronTrigger, "inherited", { recurring: true });
    const overridden = configured.create(cronTrigger, "overridden", { recurring: true, expiresIn: "12h" });

    expect(inherited.expiresAt - inherited.createdAt).toBe(14 * 24 * 60 * 60 * 1000);
    expect(overridden.expiresAt - overridden.createdAt).toBe(12 * 60 * 60 * 1000);
  });

  it("rejects fire and workflow mutations at the absolute expiry boundary", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const entry = store.create({ type: "dynamic" }, "Ship", {
      recurring: true,
      actor,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Work.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    entry.expiresAt = Date.now();
    const before = structuredClone(store.get(entry.id));

    expect(store.fire(entry.id)).toBeUndefined();
    expect(store.reviseWorkflow(entry.id, {
      expectedRevision: 1,
      expectedState: "work",
      expectedTransitionSeq: 0,
      reason: "Too late",
      changes: [],
    }, actor)).toMatchObject({ applied: false, error: expect.stringContaining("expired") });
    expect(store.transitionWorkflow(entry.id, { outcome: "done", actor }, currentWorkflowIdentity(store, entry.id))).toMatchObject({
      applied: false,
      error: expect.stringContaining("expired"),
    });
    expect(store.claimWorkflowExecution(entry.id, actor)).toMatchObject({
      claimed: false,
      error: expect.stringContaining("expired"),
    });
    expect(store.attachWorkflowMonitor(entry.id, "monitor-1", currentMonitorAttachmentIdentity(store, entry.id), actor)).toBeUndefined();
    expect(store.get(entry.id)).toEqual(before);

    expect(store.fireOrExpire(entry.id)).toMatchObject({
      kind: "expired",
      record: { disposition: "paused" },
    });
    expect(store.transitionWorkflow(entry.id, { outcome: "done", evidence: "late", actor }, currentWorkflowIdentity(store, entry.id))).toMatchObject({
      applied: false,
      error: expect.stringContaining("expired"),
    });
    expect(store.get(entry.id)?.status).toBe("paused");
  });

  it("treats a missing legacy fire count as zero in expected fire identity", () => {
    const entry = store.create(cronTrigger, "legacy", { recurring: true });
    const internal = store as unknown as { entries: Map<string, { fireCount?: number }> };
    delete internal.entries.get(entry.id)?.fireCount;

    expect(store.fireOrExpire(entry.id, "scheduler", entry.createdAt + 1, {
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      status: entry.status,
      fireCount: 0,
    }).kind).toBe("fired");
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

    expect(entry).toMatchObject({
      status: "paused",
      pause: { kind: "administrative" },
    });
  });

  it("records controller-limit pause provenance", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const entry = store.pause("1", "controller_limit", "workflow fire cap reached");

    expect(entry).toMatchObject({
      status: "paused",
      pause: { kind: "controller_limit", reason: "workflow fire cap reached" },
    });
  });

  it("resumes loops explicitly", () => {
    store.create(cronTrigger, "test", { recurring: true });
    store.pause("1");
    const entry = store.resume("1");

    expect(entry).toMatchObject({ status: "active" });
    expect(entry?.pause).toBeUndefined();
  });

  it("rejects resuming a controller after its expiry boundary", () => {
    const created = store.create(cronTrigger, "expired", { recurring: true });
    const paused = store.pause(created.id)!;
    paused.expiresAt = Date.now();

    expect(store.resume(created.id)).toBeUndefined();
    expect(store.get(created.id)?.status).toBe("paused");
  });

  it.each(["autoTask", "taskBacklog"] as const)("RA-08: rejects workflow projection through %s", (flag) => {
    const store = new LoopStore();
    expect(() => store.create({ type: "dynamic" }, "Workflow", {
      recurring: true,
      [flag]: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Work.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    })).toThrow(/workflow.*standalone tasks/i);
    expect(store.list()).toEqual([]);
  });

  it("rejects metadata that would mix workflow and standalone task authority", () => {
    store.create({ type: "dynamic" }, "Workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Work.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const before = store.get("1");

    expect(() => store.updateMetadata("1", { taskBacklog: true })).toThrow(/workflow.*standalone/i);
    expect(store.get("1")).toEqual(before);
  });

  it("rejects metadata that would give a workflow a standalone event trigger", () => {
    store.create({ type: "dynamic" }, "Workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Work.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });

    expect(() => store.updateMetadata("1", { trigger: { type: "event", source: "tasks:created" } }))
      .toThrow(/dynamic trigger/i);
    expect(store.get("1")?.trigger).toEqual({ type: "dynamic" });
  });

  it("rejects a paused terminal transition without trusted admission", () => {
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
    const result = store.transitionWorkflow("1", { outcome: "blocked" }, currentWorkflowIdentity(store, "1"));

    expect(result).toMatchObject({ applied: false, error: expect.stringContaining("require trusted admission") });
    expect(store.get("1")).toMatchObject({ status: "active", workflow: { currentState: "investigate" } });
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
    const result = store.transitionWorkflow("1", { outcome: "blocked", admission: trustedAdmission }, currentWorkflowIdentity(store, "1"));

    expect(result.terminal).toBe("paused");
    expect(store.resume("1")).toBeUndefined();
    expect(store.get("1")).toMatchObject({
      status: "paused",
      pause: { kind: "semantic_terminal" },
    });
    store.pause("1", "administrative", "later duplicate pause");
    expect(store.get("1")?.pause).toMatchObject({ kind: "semantic_terminal" });
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

    const result = store.transitionWorkflow(workflow.id, { outcome: "done" }, currentWorkflowIdentity(store, workflow.id));

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

  it("returns bounded retirement records for recovered expiries", () => {
    const ordinary = store.create(cronTrigger, "ordinary", { recurring: true });
    const workflow = store.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });
    const backlog = store.create({ type: "event", source: "tasks:created" }, "backlog", {
      recurring: true,
      taskBacklog: true,
    });
    ordinary.expiresAt = 10;
    workflow.expiresAt = 10;
    backlog.expiresAt = 10;

    expect(store.expireEntries(10)).toEqual([
      { entry: ordinary, disposition: "deleted", reason: "expires_at" },
      { entry: workflow, disposition: "paused", reason: "expires_at" },
      { entry: backlog, disposition: "paused", reason: "expires_at" },
    ]);
    expect(store.get(ordinary.id)).toBeUndefined();
    expect(store.get(workflow.id)?.status).toBe("paused");
    expect(store.get(backlog.id)?.status).toBe("paused");
    expect(store.expireEntries(11)).toEqual([]);
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

    const first = s.create(eventTrigger, "event loop", { recurring: false });
    s.create(cronT, "cron loop", { recurring: true });
    const second = s.create(eventTrigger, "another event", { recurring: true });
    s.create({ type: "event", source: "tasks:created" }, "backlog worker", { recurring: true, taskBacklog: true });

    // sessionStartedAt is set after creation — simulating loop persisted from prior session
    const sessionStartedAt = Date.now() + 1;
    expect(s.expireEventLoopEntries(sessionStartedAt)).toEqual([
      { entry: first, disposition: "deleted", reason: "resume_event_stale" },
      { entry: second, disposition: "deleted", reason: "resume_event_stale" },
    ]);

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

  it("rejects dynamic continuation at the authoritative expiry boundary", () => {
    const entry = store.create({ type: "dynamic" }, "ship", { recurring: true });
    entry.expiresAt = Date.now();

    expect(store.continueDynamic(entry.id, { dynamic: { state: "too late", iteration: 1 } })).toBeUndefined();
    expect(store.get(entry.id)?.dynamic?.state).toBeUndefined();
    expect(store.get(entry.id)?.status).toBe("active");
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

  it("settles expiry once across stores sharing a project snapshot", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "workflow", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: { work: { prompt: "Work.", on: { done: "done" } }, done: { prompt: "Done.", terminal: "completed" } },
      },
    });
    const store2 = new LoopStore(filePath);

    expect(store1.expireEntry(workflow.id, workflow.expiresAt)).toMatchObject({
      entry: { id: workflow.id },
      disposition: "paused",
    });
    expect(store2.expireEntry(workflow.id, workflow.expiresAt)).toBeUndefined();
    expect(store2.get(workflow.id)).toMatchObject({
      status: "paused",
      pause: { kind: "controller_limit", reason: "loop expiry reached" },
    });
  });

  it.each([
    ["administrative", "operator hold", "administratively paused"],
    ["controller_limit", "loop fire cap reached", "cannot bypass the controller limit"],
  ] as const)("rejects %s-paused self-transitions without changing persisted bytes", (kind, reason, expectedError) => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Await authority", {
      recurring: true,
      maxFires: 1,
      workflow: {
        version: 1,
        initialState: "wait",
        states: {
          wait: { prompt: "Wait.", maxAttempts: 3, on: { still_missing: "wait", received: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    store1.pause(workflow.id, kind, reason);
    const before = readFileSync(filePath);

    const result = store1.transitionWorkflow(workflow.id, {
      outcome: "still_missing",
      evidence: "No authority change.",
    }, currentWorkflowIdentity(store1, workflow.id));

    expect(result).toMatchObject({ applied: false, error: expect.stringContaining(expectedError) });
    expect(readFileSync(filePath)).toEqual(before);
    expect(store1.get(workflow.id)).toMatchObject({
      status: "paused",
      pause: { kind, reason },
      workflow: { currentState: "wait", transitionSeq: 0, attemptsByState: { wait: 1 } },
    });
  });

  it("atomically resumes only an evidenced exit from a state-local cadence cap", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Poll release", {
      recurring: true,
      maxFires: 10,
      workflow: {
        version: 1,
        initialState: "poll",
        states: {
          poll: {
            prompt: "Poll once.",
            loop: { schedule: "* * * * *", maxFires: 1 },
            on: { ready: "finish" },
          },
          finish: { prompt: "Finish the work.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    store1.fire(workflow.id, "scheduler");
    store1.pause(workflow.id, "controller_limit", "workflow state fire cap reached");
    expect(store1.resume(workflow.id)).toBeUndefined();
    expect(store1.get(workflow.id)?.status).toBe("paused");
    const before = readFileSync(filePath);

    expect(store1.transitionWorkflow(workflow.id, { outcome: "ready" }, currentWorkflowIdentity(store1, workflow.id))).toMatchObject({
      applied: false,
      error: expect.stringContaining("requires evidence"),
    });
    expect(readFileSync(filePath)).toEqual(before);

    expect(store1.transitionWorkflow(workflow.id, {
      outcome: "ready",
      evidence: "Release endpoint reports ready.",
    }, currentWorkflowIdentity(store1, workflow.id))).toMatchObject({ applied: true, entry: { status: "active" } });
    expect(store1.get(workflow.id)).toMatchObject({
      status: "active",
      workflow: { currentState: "finish", transitionSeq: 1 },
    });
    expect(store1.get(workflow.id)?.pause).toBeUndefined();
  });

  it("rejects a nonterminal exit after the workflow-wide cap is exhausted", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Await release", {
      recurring: true,
      maxFires: 1,
      workflow: {
        version: 1,
        initialState: "wait",
        states: {
          wait: { prompt: "Wait.", on: { ready: "finish" } },
          finish: { prompt: "Finish.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    store1.fire(workflow.id);
    store1.pause(workflow.id, "controller_limit", "loop fire cap reached");
    expect(store1.resume(workflow.id)).toBeUndefined();
    const before = readFileSync(filePath);

    expect(store1.transitionWorkflow(workflow.id, {
      outcome: "ready",
      evidence: "Release is ready.",
    }, currentWorkflowIdentity(store1, workflow.id))).toMatchObject({
      applied: false,
      error: expect.stringContaining("only a terminal transition may proceed"),
    });
    expect(readFileSync(filePath)).toEqual(before);
  });

  it("allows a completed terminal transition after the workflow-wide cap", () => {
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Finish release", {
      recurring: true,
      maxFires: 1,
      workflow: {
        version: 1,
        initialState: "finish",
        states: {
          finish: { prompt: "Finish.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    store1.fire(workflow.id);
    store1.pause(workflow.id, "controller_limit", "loop fire cap reached");

    expect(store1.transitionWorkflow(workflow.id, {
      outcome: "done",
      evidence: "Acceptance checks passed before the cap.",
    }, currentWorkflowIdentity(store1, workflow.id))).toMatchObject({
      applied: true,
      terminal: "completed",
      entry: { status: "active", pause: undefined },
    });
    expect(store1.get(workflow.id)).toBeUndefined();
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
    expect(store2.get("1")).toMatchObject({ status: "paused", pause: { kind: "administrative" } });
  });

  it("loads legacy paused snapshots without synthesized provenance", () => {
    const store = new LoopStore(filePath);
    store.create(cronTrigger, "test", { recurring: true });
    store.pause("1");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    delete data.loops[0].pause;
    writeFileSync(filePath, JSON.stringify(data));
    rmSync(`${filePath}.prev`, { force: true });

    expect(new LoopStore(filePath).get("1")).toMatchObject({ status: "paused" });
    expect(new LoopStore(filePath).get("1")?.pause).toBeUndefined();
  });

  it("fails closed on malformed persisted pause provenance", () => {
    const store = new LoopStore(filePath);
    store.create(cronTrigger, "test", { recurring: true });
    store.pause("1");
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.loops[0].pause.kind = "invented";
    writeFileSync(filePath, JSON.stringify(data));
    rmSync(`${filePath}.prev`, { force: true });

    expect(() => new LoopStore(filePath)).toThrow("Corrupt store");
  });

  it("fails closed on malformed persisted admission provenance", () => {
    const store = new LoopStore(filePath);
    store.create({ type: "dynamic" }, "Investigate", {
      recurring: true,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: { prompt: "Work.", on: { blocked: "blocked" } },
          blocked: { prompt: "Blocked.", terminal: "paused" },
        },
      },
    });
    store.transitionWorkflow("1", {
      outcome: "blocked",
      admission: {
        claimClass: "environmental",
        provider: "monitor",
        subject: "m1",
        fact: "status",
        expected: "error",
        observations: ["monitor@1"],
        decidedAt: Date.now(),
      },
    }, currentWorkflowIdentity(store, "1"));
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.loops[0].workflow.lastTransition.admission.observations = Array.from({ length: 9 }, () => "monitor@1");
    writeFileSync(filePath, JSON.stringify(data));
    rmSync(`${filePath}.prev`, { force: true });

    expect(() => new LoopStore(filePath)).toThrow("Corrupt store");
  });

  it("persists deletions", () => {
    const store1 = new LoopStore(filePath);
    store1.create(cronTrigger, "test", { recurring: true });
    store1.delete("1");

    const store2 = new LoopStore(filePath);
    expect(store2.list()).toHaveLength(0);
  });

  it("does not rewrite persisted expiry when the runtime default changes", () => {
    const original = new LoopStore(filePath, 2 * 24 * 60 * 60 * 1000);
    const created = original.create(cronTrigger, "test", { recurring: true });

    const restarted = new LoopStore(filePath, 30 * 24 * 60 * 60 * 1000);
    expect(restarted.get(created.id)?.expiresAt).toBe(created.expiresAt);
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

    expect(store1.transitionWorkflow(workflow.id, { outcome: "done" }, currentWorkflowIdentity(store1, workflow.id)).terminal).toBe("completed");

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
    }, currentWorkflowIdentity(store1, workflow.id)).applied).toBe(true);

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

  it("serializes revisions, fences transition races, and preserves history after restart", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const workflowDefinition = {
      version: 1 as const,
      initialState: "investigate",
      states: {
        investigate: {
          prompt: "Investigate.",
          task: { subject: "Investigate", description: "Find requirements." },
          on: { ready: "implement" },
        },
        implement: {
          prompt: "Implement.",
          task: { subject: "Implement", description: "Apply requirements." },
          on: { done: "complete" },
        },
        complete: { prompt: "Report.", terminal: "completed" as const },
      },
    };
    const store1 = new LoopStore(filePath);
    const workflow = store1.create({ type: "dynamic" }, "Adaptive workflow", {
      recurring: true,
      workflow: workflowDefinition,
      actor,
    });
    const store2 = new LoopStore(filePath);
    const input = {
      expectedRevision: 1,
      expectedState: "investigate",
      expectedTransitionSeq: 0,
      reason: "Add validation before implementation.",
      changes: [
        {
          op: "add_state" as const,
          stateId: "validate",
          state: { prompt: "Validate.", on: { validated: "implement" } },
        },
        {
          op: "redirect_transition" as const,
          from: "investigate",
          outcome: "ready",
          expectedTo: "implement",
          to: "validate",
        },
      ],
    };

    expect(store1.reviseWorkflow(workflow.id, input, actor).applied).toBe(true);
    expect(store2.reviseWorkflow(workflow.id, input, actor)).toMatchObject({
      applied: false,
      failure: { code: "revision_conflict", expectedRevision: 1, currentRevision: 2 },
    });
    expect(store2.transitionWorkflow(workflow.id, { outcome: "ready", actor }, {
      currentState: "investigate",
      transitionSeq: 0,
      definitionRevision: 1,
      activeExecutionId: "investigate:0",
    })).toMatchObject({ applied: false, error: expect.stringContaining("changed") });

    const restarted = new LoopStore(filePath);
    expect(restarted.get(workflow.id)?.workflow).toMatchObject({
      definitionRevision: 2,
      revisionHistory: [{ revision: 1, reason: input.reason }],
      definition: { states: { investigate: { on: { ready: "validate" } } } },
    });

    const second = restarted.create({ type: "dynamic" }, "Transition wins", {
      recurring: true,
      workflow: workflowDefinition,
      actor,
    });
    expect(restarted.transitionWorkflow(second.id, { outcome: "ready", actor }, currentWorkflowIdentity(restarted, second.id)).applied).toBe(true);
    expect(store2.reviseWorkflow(second.id, { ...input, reason: "Stale after transition." }, actor)).toMatchObject({
      applied: false,
      failure: { code: "run_conflict", currentState: "implement", currentTransitionSeq: 1 },
    });
  });

  it("persists reissued instructions, cancelled work, and the replacement lease atomically", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const store = new LoopStore(filePath);
    const entry = store.create({ type: "dynamic" }, "Open the PR", {
      recurring: true,
      actor,
      workflow: {
        version: 1,
        initialState: "open-pr",
        states: {
          "open-pr": {
            prompt: "Push now.",
            task: { subject: "Open PR", description: "Push now." },
            on: { opened: "done" },
          },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const lease = structuredClone(entry.workflow?.activeExecution?.lease);

    expect(store.reviseWorkflow(entry.id, {
      expectedRevision: 1,
      expectedState: "open-pr",
      expectedTransitionSeq: 0,
      reason: "Wait for Brick.",
      changes: [{
        op: "reissue_state",
        stateId: "open-pr",
        prompt: "Wait for Brick; do not push.",
        task: { subject: "Wait", description: "Wait for user confirmation." },
      }],
    }, actor)).toMatchObject({ applied: true, summary: { reissuedStates: ["open-pr"] } });
    expect(store.transitionWorkflow(entry.id, { outcome: "opened", actor }, {
      currentState: "open-pr",
      transitionSeq: 0,
      definitionRevision: 2,
      activeExecutionId: "open-pr:0",
    })).toMatchObject({ applied: false, error: expect.stringContaining("changed") });

    const restarted = new LoopStore(filePath);
    expect(restarted.get(entry.id)?.workflow).toMatchObject({
      definitionRevision: 2,
      definition: { states: { "open-pr": { prompt: "Wait for Brick; do not push." } } },
      activeExecution: { id: "open-pr:0:r2", subject: "Wait", lease },
      executionHistory: [{ id: "open-pr:0", status: "cancelled" }],
      revisionHistory: [{ revision: 1, reason: "Wait for Brick." }],
    });
    expect(restarted.get(entry.id)?.workflow?.executionHistory?.[0]?.lease).toBeUndefined();
  });

  it("reissues through administrative pauses but rejects exhausted controllers", () => {
    const actor = { sessionId: "session-a", runtimeId: "runtime-a" };
    const store = new LoopStore(filePath);
    const entry = store.create({ type: "dynamic" }, "Paused work", {
      recurring: true,
      actor,
      workflow: {
        version: 1,
        initialState: "work",
        states: {
          work: {
            prompt: "Work.",
            task: { subject: "Work", description: "Do it." },
            on: { done: "complete" },
          },
          complete: { prompt: "Complete.", terminal: "completed" },
        },
      },
    });
    store.pause(entry.id, "administrative", "Hold.");
    const beforeBytes = readFileSync(filePath, "utf8");

    expect(store.reviseWorkflow(entry.id, {
      expectedRevision: 1,
      expectedState: "work",
      expectedTransitionSeq: 0,
      reason: "Replace paused instructions.",
      changes: [{ op: "reissue_state", stateId: "work", prompt: "Changed." }],
    }, actor)).toMatchObject({ applied: true, summary: { reissuedStates: ["work"] } });
    expect(store.get(entry.id)).toMatchObject({
      status: "paused",
      workflow: { definitionRevision: 2, activeExecution: { id: "work:0:r2" } },
    });
    expect(readFileSync(filePath, "utf8")).not.toBe(beforeBytes);

    store.resume(entry.id);
    store.pause(entry.id, "controller_limit", "loop fire cap reached");
    const cappedBytes = readFileSync(filePath, "utf8");
    expect(store.reviseWorkflow(entry.id, {
      expectedRevision: 3,
      expectedState: "work",
      expectedTransitionSeq: 0,
      reason: "Do not renew bounded work implicitly.",
      changes: [{ op: "reissue_state", stateId: "work", prompt: "Changed again." }],
    }, actor)).toMatchObject({ applied: false, failure: { code: "workflow_paused" } });
    expect(store.get(entry.id)?.workflow?.definitionRevision).toBe(2);
    expect(readFileSync(filePath, "utf8")).toBe(cappedBytes);
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
    const attached = store.attachWorkflowMonitor(
      workflow.id,
      "18",
      currentMonitorAttachmentIdentity(store, workflow.id),
    );
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

  it("settles monitor expiry and wait completion atomically", () => {
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
    const attached = store.attachWorkflowMonitor(
      workflow.id,
      "18",
      currentMonitorAttachmentIdentity(store, workflow.id),
    );
    const wait = attached?.workflow?.waitingMonitor;

    expect(store.settleWorkflowMonitorWait(workflow.id, wait!, workflow.expiresAt)).toMatchObject({
      kind: "expired",
      disposition: "paused",
      reason: "expires_at",
    });
    expect(store.get(workflow.id)).toMatchObject({
      status: "paused",
      pause: { kind: "controller_limit", reason: "loop expiry reached" },
      workflow: { waitingMonitor: wait },
    });
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
    store.attachWorkflowMonitor(workflow.id, "18", currentMonitorAttachmentIdentity(store, workflow.id));

    const transition = store.transitionWorkflow(workflow.id, { outcome: "passed" }, currentWorkflowIdentity(store, workflow.id));

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
      expect(workflow).toMatchObject({ definitionRevision: 1, revisionHistory: [] });
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

  it("does not rewrite a legacy snapshot when a workflow revision is rejected", () => {
    const lPath = join(tmpdir(), `pi-loop-rejected-legacy-revision-${Date.now()}.json`);
    const raw = JSON.stringify({
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
        workflow: {
          definition: workflow,
          currentState: "work",
          transitionSeq: 0,
          stateEnteredAt: 1,
          attemptsByState: { work: 1 },
          stateFireCounts: {},
        },
      }],
    });
    writeFileSync(lPath, raw);
    try {
      const store = new LoopStore(lPath);
      expect(store.reviseWorkflow("1", {
        expectedRevision: 2,
        expectedState: "work",
        expectedTransitionSeq: 0,
        reason: "Stale revision.",
        changes: [{ op: "revise_state", stateId: "complete", prompt: "Changed." }],
      }, { sessionId: "session-a", runtimeId: "runtime-a" })).toMatchObject({
        applied: false,
        failure: { code: "revision_conflict" },
      });
      expect(readFileSync(lPath, "utf8")).toBe(raw);
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".prev", { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it("loads and revises legacy workflow history with unreachable states", () => {
    const lPath = join(tmpdir(), `pi-loop-legacy-unreachable-history-${Date.now()}.json`);
    const legacyDefinition = {
      version: 1 as const,
      initialState: "work",
      states: {
        work: { prompt: "Work.", on: { done: "complete" } },
        complete: { prompt: "Report.", terminal: "completed" as const },
        orphan: { prompt: "Legacy unreachable state." },
      },
    };
    writeFileSync(lPath, JSON.stringify({
      nextId: 2,
      loops: [{
        id: "1",
        prompt: "legacy unreachable",
        trigger: { type: "dynamic" },
        status: "active",
        recurring: true,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000,
        workflow: {
          definition: legacyDefinition,
          definitionRevision: 2,
          revisionHistory: [{
            revision: 1,
            definition: legacyDefinition,
            reason: "Legacy revision.",
            supersededAt: 2,
            supersededBy: { sessionId: "session-a", runtimeId: "runtime-a" },
            changes: [{ op: "revise_state", stateId: "complete", prompt: "Report." }],
          }],
          currentState: "work",
          transitionSeq: 0,
          stateEnteredAt: 1,
          attemptsByState: { work: 1 },
          stateFireCounts: {},
        },
      }],
    }));
    try {
      const store = new LoopStore(lPath);
      expect(store.get("1")?.workflow?.revisionHistory).toHaveLength(1);
      expect(store.reviseWorkflow("1", {
        expectedRevision: 2,
        expectedState: "work",
        expectedTransitionSeq: 0,
        reason: "Revise reachable reporting.",
        changes: [{ op: "revise_state", stateId: "complete", prompt: "Report revised." }],
      }, { sessionId: "session-a", runtimeId: "runtime-a" })).toMatchObject({ applied: true });
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".prev", { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it.each([
    ["reason", { reason: 7 }],
    ["timestamp", { supersededAt: "later" }],
    ["actor", { supersededBy: null }],
    ["change", { changes: [{ op: "unknown" }] }],
    ["definition", { definition: { version: 1, initialState: "missing", states: {} } }],
  ])("fails closed when persisted workflow revision history has a malformed %s", (_label, malformed) => {
    const lPath = join(tmpdir(), `pi-loop-malformed-history-${String(_label)}-${Date.now()}.json`);
    const revision = {
      revision: 1,
      definition: workflow,
      reason: "Original definition superseded.",
      supersededAt: 2,
      supersededBy: { sessionId: "session-a", runtimeId: "runtime-a" },
      changes: [{ op: "revise_state", stateId: "complete", prompt: "Revised report." }],
      ...malformed,
    };
    writeFileSync(lPath, JSON.stringify({
      nextId: 2,
      loops: [{
        id: "1",
        prompt: "malformed",
        trigger: { type: "dynamic" },
        status: "active",
        recurring: true,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000,
        workflow: {
          definition: workflow,
          definitionRevision: 2,
          revisionHistory: [revision],
          currentState: "work",
          transitionSeq: 0,
          stateEnteredAt: 1,
          attemptsByState: { work: 1 },
          stateFireCounts: {},
        },
      }],
    }));
    try {
      expect(() => new LoopStore(lPath)).toThrow("Corrupt store");
    } finally {
      rmSync(lPath, { force: true });
      rmSync(lPath + ".prev", { force: true });
      rmSync(lPath + ".lock", { force: true });
      rmSync(lPath + ".tmp", { force: true });
    }
  });

  it("fails closed when persisted workflow revision metadata is partial", () => {
    const lPath = join(tmpdir(), `pi-loop-malformed-revision-${Date.now()}.json`);
    writeFileSync(lPath, JSON.stringify({
      nextId: 2,
      loops: [{
        id: "1",
        prompt: "malformed",
        trigger: { type: "dynamic" },
        status: "active",
        recurring: true,
        createdAt: 1,
        updatedAt: 1,
        expiresAt: Date.now() + 60_000,
        workflow: {
          definition: workflow,
          definitionRevision: 2,
          currentState: "work",
          transitionSeq: 0,
          stateEnteredAt: 1,
          attemptsByState: { work: 1 },
          stateFireCounts: {},
        },
      }],
    }));
    try {
      expect(() => new LoopStore(lPath)).toThrow("Corrupt store");
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
