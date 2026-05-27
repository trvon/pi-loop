import { rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LoopStore } from "../src/store.js";
import type { Trigger } from "../src/types.js";

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

  it("updates loop status", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const { entry, changedFields } = store.update("1", { status: "paused" });

    expect(entry!.status).toBe("paused");
    expect(changedFields).toEqual(["status"]);
  });

  it("updates loop prompt", () => {
    store.create(cronTrigger, "original", { recurring: true });
    store.update("1", { prompt: "updated" });

    expect(store.get("1")!.prompt).toBe("updated");
  });

  it("updates trigger", () => {
    store.create(cronTrigger, "test", { recurring: true });
    const newTrigger: Trigger = { type: "event", source: "tool_execution_start" };
    store.update("1", { trigger: newTrigger });

    expect(store.get("1")!.trigger.type).toBe("event");
  });

  it("returns empty entry for non-existent update", () => {
    const { entry, changedFields } = store.update("999", { status: "paused" });
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

  it("clears all loops", () => {
    store.create(cronTrigger, "a", { recurring: true });
    store.create(cronTrigger, "b", { recurring: true });
    expect(store.clearAll()).toBe(2);
    expect(store.list()).toHaveLength(0);
  });

  it("expires event-triggered loops on session start", () => {
    const s = new LoopStore();
    const eventTrigger = { type: "event" as const, source: "monitor:done" };
    const cronT = { type: "cron" as const, schedule: "*/5 * * * *" };

    s.create(eventTrigger, "event loop", { recurring: false });
    s.create(cronT, "cron loop", { recurring: true });
    s.create(eventTrigger, "another event", { recurring: true });

    // sessionStartedAt is set after creation — simulating loop persisted from prior session
    const sessionStartedAt = Date.now() + 1;
    expect(s.expireEventLoops(sessionStartedAt)).toBe(2);

    expect(s.get("2")!.status).toBe("active"); // cron loop untouched
    expect(s.get("1")!.status).toBe("expired");
    expect(s.get("3")!.status).toBe("expired");
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

  it("stores autoTask flag", () => {
    const l = store.create(cronTrigger, "test", { recurring: true, autoTask: true });
    expect(l.autoTask).toBe(true);
  });
});

describe("LoopStore (file-backed)", () => {
  const testListId = `test-loops-${Date.now()}`;
  const loopsDir = join(homedir(), ".pi", "loops");
  const filePath = join(loopsDir, `${testListId}.json`);

  afterEach(() => {
    try { rmSync(filePath); } catch { /* */ }
    try { rmSync(filePath + ".lock"); } catch { /* */ }
    try { rmSync(filePath + ".tmp"); } catch { /* */ }
  });

  it("persists loops to disk", () => {
    const store1 = new LoopStore(testListId);
    store1.create(cronTrigger, "persist test", { recurring: true });

    const store2 = new LoopStore(testListId);
    const loops = store2.list();
    expect(loops).toHaveLength(1);
    expect(loops[0].prompt).toBe("persist test");
  });

  it("persists ID counter across instances", () => {
    const store1 = new LoopStore(testListId);
    store1.create(cronTrigger, "first", { recurring: true });

    const store2 = new LoopStore(testListId);
    const l = store2.create(cronTrigger, "second", { recurring: true });
    expect(l.id).toBe("2");
  });

  it("persists status updates", () => {
    const store1 = new LoopStore(testListId);
    store1.create(cronTrigger, "test", { recurring: true });
    store1.update("1", { status: "paused" });

    const store2 = new LoopStore(testListId);
    expect(store2.get("1")!.status).toBe("paused");
  });

  it("persists deletions", () => {
    const store1 = new LoopStore(testListId);
    store1.create(cronTrigger, "test", { recurring: true });
    store1.delete("1");

    const store2 = new LoopStore(testListId);
    expect(store2.list()).toHaveLength(0);
  });
});

describe("LoopStore (absolute path)", () => {
  const absFilePath = join(tmpdir(), `pi-loop-test-${Date.now()}.json`);

  afterEach(() => {
    try { rmSync(absFilePath); } catch { /* */ }
    try { rmSync(absFilePath + ".lock"); } catch { /* */ }
    try { rmSync(absFilePath + ".tmp"); } catch { /* */ }
  });

  it("accepts absolute path", () => {
    const store1 = new LoopStore(absFilePath);
    store1.create(cronTrigger, "abs test", { recurring: true });

    const store2 = new LoopStore(absFilePath);
    expect(store2.list()).toHaveLength(1);
    expect(store2.list()[0].prompt).toBe("abs test");
  });
});
