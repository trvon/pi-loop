import { rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TaskStore } from "../src/task-store.js";

describe("TaskStore (in-memory)", () => {
  let store: TaskStore;

  beforeEach(() => {
    store = new TaskStore();
  });

  it("creates tasks with auto-incrementing IDs", () => {
    const t1 = store.create("one", "desc one");
    const t2 = store.create("two", "desc two");

    expect(t1.id).toBe("1");
    expect(t2.id).toBe("2");
    expect(t1.status).toBe("pending");
  });

  it("starts tasks explicitly", () => {
    store.create("task", "desc");
    const entry = store.start("1");

    expect(entry?.status).toBe("in_progress");
  });

  it("completes tasks explicitly and stamps completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    const entry = store.complete("1");

    expect(entry?.status).toBe("completed");
    expect(typeof entry?.completedAt).toBe("number");
  });

  it("reopens tasks explicitly and preserves completedAt", () => {
    store.create("task", "desc");
    store.start("1");
    store.complete("1");
    const completedAt = store.get("1")?.completedAt;

    const entry = store.reopen("1");
    expect(entry?.status).toBe("pending");
    expect(entry?.completedAt).toBe(completedAt);
  });

  it("updates task details explicitly", () => {
    store.create("old", "old desc");
    const entry = store.updateDetails("1", { subject: "new", description: "new desc" });

    expect(entry?.subject).toBe("new");
    expect(entry?.description).toBe("new desc");
    expect(entry?.status).toBe("pending");
  });

  it("returns undefined for missing lifecycle/detail updates", () => {
    expect(store.start("999")).toBeUndefined();
    expect(store.complete("999")).toBeUndefined();
    expect(store.reopen("999")).toBeUndefined();
    expect(store.updateDetails("999", { subject: "missing" })).toBeUndefined();
  });

  it("prunes completed tasks only", () => {
    store.create("done", "d1");
    store.create("active", "d2");
    store.complete("1");
    store.start("2");

    expect(store.pruneCompleted()).toBe(1);
    expect(store.list()).toHaveLength(1);
    expect(store.get("1")).toBeUndefined();
    expect(store.get("2")?.status).toBe("in_progress");
  });
});

describe("TaskStore (file-backed)", () => {
  const testListId = `test-tasks-${Date.now()}`;
  const tasksDir = join(homedir(), ".pi", "tasks");
  const filePath = join(tasksDir, `${testListId}.json`);

  afterEach(() => {
    rmSync(filePath, { force: true });
    rmSync(filePath + ".lock", { force: true });
    rmSync(filePath + ".tmp", { force: true });
  });

  it("persists explicit lifecycle and detail updates", () => {
    const store1 = new TaskStore(testListId);
    store1.create("task", "desc");
    store1.start("1");
    store1.updateDetails("1", { subject: "updated" });

    const store2 = new TaskStore(testListId);
    expect(store2.get("1")?.status).toBe("in_progress");
    expect(store2.get("1")?.subject).toBe("updated");
  });

  it("preserves monotonic ids after prune", () => {
    const store1 = new TaskStore(testListId);
    store1.create("done", "desc");
    store1.complete("1");
    store1.pruneCompleted();

    const next = store1.create("next", "desc");
    expect(next.id).toBe("2");
  });
});
