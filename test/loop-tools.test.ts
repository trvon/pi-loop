import { beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { registerLoopTools } from "../src/tools/loop-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup() {
  const { pi, toolMap } = createMockPi();
  const store = new LoopStore(); // memory mode, no file I/O
  const triggerSystem = { add: vi.fn(), remove: vi.fn() };
  const scheduler = { nextFire: vi.fn(() => undefined) };
  const monitorManager = { get: vi.fn(() => undefined) };
  registerLoopTools({
    pi,
    getStore: () => store as any,
    getTriggerSystem: () => triggerSystem as any,
    getScheduler: () => scheduler as any,
    getMonitorManager: () => monitorManager as any,
    updateWidget: vi.fn(),
    maybeBootstrapTaskLoop: vi.fn(async () => false),
    isTaskSystemReady: () => true,
  });
  const text = async (name: string, args: any) =>
    (await toolMap.get(name)!.execute!("t", args)).content[0].text as string;
  return { store, triggerSystem, text };
}

describe("LoopCreate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
  });

  it("creates a cron loop from an interval and arms the trigger system", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "check build", triggerType: "cron" });
    expect(out).toContain("Loop #1 created");
    expect(out).toContain("schedule:");
    expect(out).toContain("Recurring: true");
    expect(h.triggerSystem.add).toHaveBeenCalledTimes(1);
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("creates an event loop that defaults to non-recurring", async () => {
    const out = await h.text("LoopCreate", { trigger: "tasks:created", prompt: "go", triggerType: "event" });
    expect(out).toContain("event: tasks:created");
    expect(out).toContain("Recurring: false");
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tasks:created" });
  });

  it("creates a hybrid loop", async () => {
    const out = await h.text("LoopCreate", { trigger: "5m", prompt: "go", triggerType: "hybrid" });
    expect(out).toContain("hybrid: cron");
    expect(h.store.get("1")?.trigger.type).toBe("hybrid");
  });

  it("rejects an empty event source with a validation message", async () => {
    const out = await h.text("LoopCreate", { trigger: "", prompt: "go", triggerType: "event" });
    expect(out).toContain("Invalid event trigger");
    expect(h.triggerSystem.add).not.toHaveBeenCalled();
    expect(h.store.list()).toHaveLength(0);
  });

  it("infers cron from an interval when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "30s", prompt: "poll" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers cron from a full 5-field cron expression when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "0 9 * * 1-5", prompt: "morning" });
    expect(h.store.get("1")?.trigger.type).toBe("cron");
  });

  it("infers event from a non-interval source when triggerType is omitted", async () => {
    await h.text("LoopCreate", { trigger: "tool_execution_start", prompt: "react" });
    expect(h.store.get("1")?.trigger).toEqual({ type: "event", source: "tool_execution_start" });
  });

  it("persists readOnly and maxFires flags", async () => {
    await h.text("LoopCreate", { trigger: "5m", prompt: "poll", triggerType: "cron", readOnly: true, maxFires: 20 });
    const entry = h.store.get("1");
    expect(entry?.readOnly).toBe(true);
    expect(entry?.maxFires).toBe(20);
  });
});

describe("LoopList", () => {
  it("reports when no loops are configured", async () => {
    const h = setup();
    expect(await h.text("LoopList", {})).toContain("No loops configured");
  });

  it("lists active loops with trigger info", async () => {
    const h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "build check", triggerType: "cron" });
    const out = await h.text("LoopList", {});
    expect(out).toContain("#1");
    expect(out).toContain("[active]");
    expect(out).toContain("cron:");
  });
});

describe("LoopUpdate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.store.create({ type: "dynamic" }, "finish goal", {
      recurring: true,
      dynamic: { goal: "finish goal", iteration: 0 },
    });
  });

  it("continues a dynamic loop with progress and next wake", async () => {
    const out = await h.text("LoopUpdate", {
      id: "1",
      status: "continue",
      state: "router done",
      metrics: "2/5 tasks complete",
      doneCriteria: "all tests pass",
      nextInterval: "3m",
    });

    expect(out).toContain("Dynamic loop #1 updated");
    expect(out).toContain("Iteration: 1");
    expect(h.store.get("1")?.dynamic).toMatchObject({
      goal: "finish goal",
      state: "router done",
      metrics: "2/5 tasks complete",
      doneCriteria: "all tests pass",
      iteration: 1,
      awaitingUpdate: false,
    });
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeGreaterThan(Date.now());
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.triggerSystem.add).toHaveBeenCalledWith(h.store.get("1"));
  });

  it("completes and deletes a dynamic loop", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "completed" });

    expect(out).toBe("Dynamic loop #1 completed and deleted");
    expect(h.store.get("1")).toBeUndefined();
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });

  it("pauses a dynamic loop", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "paused" });

    expect(out).toBe("Dynamic loop #1 paused");
    expect(h.store.get("1")?.status).toBe("paused");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
  });

  it("rejects non-dynamic loops", async () => {
    h.store.create({ type: "cron", schedule: "*/5 * * * *" }, "fixed", { recurring: true });

    expect(await h.text("LoopUpdate", { id: "2", status: "continue" })).toBe("Loop #2 is not a dynamic loop");
  });

  it("defaults continued dynamic loops to idle-driven next wake", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "continue" });

    expect(out).toContain("Next wake: when idle");
    expect(h.store.get("1")?.dynamic?.nextWakeAt).toBeUndefined();
  });

  it("reports invalid next intervals", async () => {
    const out = await h.text("LoopUpdate", { id: "1", status: "continue", nextInterval: "soon" });
    expect(out).toContain("Invalid nextInterval");
  });
});

describe("LoopDelete", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(async () => {
    h = setup();
    await h.text("LoopCreate", { trigger: "5m", prompt: "x", triggerType: "cron" });
  });

  it("deletes a loop and removes its trigger", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "delete" });
    expect(out).toBe("Loop #1 deleted");
    expect(h.triggerSystem.remove).toHaveBeenCalledWith("1");
    expect(h.store.get("1")).toBeUndefined();
  });

  it("pauses a loop without removing it", async () => {
    const out = await h.text("LoopDelete", { id: "1", action: "pause" });
    expect(out).toBe("Loop #1 paused");
    expect(h.store.get("1")?.status).toBe("paused");
  });

  it("reports auto-deletion tombstones for already deleted loops", async () => {
    h.store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    h.store.delete("1");

    expect(await h.text("LoopDelete", { id: "1", action: "delete" })).toBe("Loop #1 already auto-deleted: task_backlog_empty (pending: 0)");
  });

  it("reports auto-deletion tombstones consistently when pausing", async () => {
    h.store.recordDeletionTombstone("1", { reason: "task_backlog_empty", pendingCount: 0 });
    h.store.delete("1");

    expect(await h.text("LoopDelete", { id: "1", action: "pause" })).toBe("Loop #1 already auto-deleted: task_backlog_empty (pending: 0)");
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("LoopDelete", { id: "99", action: "delete" })).toBe("Loop #99 not found");
  });
});
