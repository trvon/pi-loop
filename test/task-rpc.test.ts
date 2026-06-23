import { describe, expect, it, vi } from "vitest";
import { createTaskRuntimeBridge } from "../src/runtime/task-rpc.js";
import { TaskStore } from "../src/task-store.js";
import type { LoopEntry } from "../src/types.js";
import { createMockPi, flushAsync } from "./helpers/mock-pi.js";

function autoTaskLoop(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: "1",
    prompt: "do the thing",
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    status: "active",
    recurring: true,
    autoTask: true,
    createdAt: 10,
    updatedAt: 10,
    expiresAt: 10 + 7 * 24 * 60 * 60 * 1000,
    fireCount: 0,
    ...overrides,
  };
}

describe("task-rpc checkTasksVersion", () => {
  it("marks tasks available when pi-tasks replies with a version", async () => {
    const { pi } = createMockPi({ respondToTaskPing: true });
    const setTasksAvailable = vi.fn();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable,
      getNativeTaskStore: () => undefined,
    });

    bridge.checkTasksVersion();
    await flushAsync();

    expect(setTasksAvailable).toHaveBeenCalledWith(true);
  });

  it("leaves tasks unavailable when nobody replies", async () => {
    const { pi } = createMockPi();
    const setTasksAvailable = vi.fn();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable,
      getNativeTaskStore: () => undefined,
    });

    bridge.checkTasksVersion();
    await flushAsync();

    expect(setTasksAvailable).not.toHaveBeenCalled();
  });
});

describe("task-rpc hasPendingTasks", () => {
  it("returns the RPC count when pi-tasks is available", async () => {
    const { pi } = createMockPi({ pendingTaskCount: () => 7 });
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => true,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => undefined,
    });

    expect(await bridge.hasPendingTasks()).toBe(7);
  });

  it("falls back to the native store count when pi-tasks is absent", async () => {
    const { pi } = createMockPi();
    const store = new TaskStore();
    store.create("a", "d");
    store.create("b", "d");
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
    });

    expect(await bridge.hasPendingTasks()).toBe(2);
  });

  it("returns -1 when neither RPC nor native store is available", async () => {
    const { pi } = createMockPi();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => undefined,
    });

    expect(await bridge.hasPendingTasks()).toBe(-1);
  });
});

describe("task-rpc autoCreateTask", () => {
  it("returns undefined for a non-autoTask loop", async () => {
    const { pi } = createMockPi();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => new TaskStore(),
    });

    expect(await bridge.autoCreateTask(autoTaskLoop({ autoTask: false }))).toBeUndefined();
  });

  it("creates via RPC when pi-tasks is available", async () => {
    const { pi } = createMockPi({ respondToTaskCreate: () => "rpc-42" });
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => true,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => undefined,
    });

    expect(await bridge.autoCreateTask(autoTaskLoop())).toBe("rpc-42");
  });

  it("creates in the native store, emits tasks:created, and notifies when pi-tasks is absent", async () => {
    const { pi, emittedEvents } = createMockPi();
    const store = new TaskStore();
    const onNativeTaskCreated = vi.fn();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
      onNativeTaskCreated,
    });

    const id = await bridge.autoCreateTask(autoTaskLoop());
    expect(id).toBeDefined();
    expect(store.get(id!)?.subject).toBe("do the thing");
    expect(onNativeTaskCreated).toHaveBeenCalledWith(store);
    expect(emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === id)).toBe(true);
  });
});

describe("task-rpc cleanDoneTasks", () => {
  it("prunes the native store and notifies when pi-tasks is absent", async () => {
    const { pi } = createMockPi();
    const store = new TaskStore();
    const t = store.create("a", "d");
    store.complete(t.id);
    const onNativeTasksPruned = vi.fn();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
      onNativeTasksPruned,
    });

    await bridge.cleanDoneTasks();
    expect(store.list()).toHaveLength(0);
    expect(onNativeTasksPruned).toHaveBeenCalledWith(store);
  });

  it("issues the RPC clean request when pi-tasks is available", async () => {
    const { pi, emittedEvents } = createMockPi();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => true,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => undefined,
    });

    await bridge.cleanDoneTasks();
    expect(emittedEvents.some((e) => e.name === "tasks:rpc:clean")).toBe(true);
  });
});
