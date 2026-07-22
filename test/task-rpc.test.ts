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

function workflowLoop(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    ...autoTaskLoop({ autoTask: false }),
    trigger: { type: "dynamic" },
    workflow: {
      definition: {
        version: 1,
        initialState: "investigate",
        states: {
          investigate: {
            prompt: "Find the cause.",
            task: { subject: "Investigate regression", description: "Find and reproduce the root cause." },
          },
        },
      },
      currentState: "investigate",
      transitionSeq: 3,
      stateEnteredAt: 10,
      attemptsByState: { investigate: 1 },
    },
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

  it("ignores pi-loop's own native ping reply", async () => {
    const mock = createMockPi();
    const setTasksAvailable = vi.fn();
    // Simulate the native server answering its own extension's probe.
    mock.pi.events.on("tasks:rpc:ping", (raw: unknown) => {
      const { requestId } = raw as { requestId: string };
      mock.pi.events.emit(`tasks:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 2, provider: "pi-loop-native" },
      });
    });
    const bridge = createTaskRuntimeBridge({
      pi: mock.pi,
      isTasksAvailable: () => false,
      setTasksAvailable,
      getNativeTaskStore: () => undefined,
    });

    bridge.checkTasksVersion();
    await flushAsync();

    expect(setTasksAvailable).not.toHaveBeenCalled();
  });

  it("still detects an external provider that replies after the native self-reply", async () => {
    const mock = createMockPi();
    const setTasksAvailable = vi.fn();
    mock.pi.events.on("tasks:rpc:ping", (raw: unknown) => {
      const { requestId } = raw as { requestId: string };
      // Native self-reply lands first…
      mock.pi.events.emit(`tasks:rpc:ping:reply:${requestId}`, {
        success: true,
        data: { version: 2, provider: "pi-loop-native" },
      });
      // …and the external pi-tasks provider replies a tick later.
      queueMicrotask(() => {
        mock.pi.events.emit(`tasks:rpc:ping:reply:${requestId}`, {
          success: true,
          data: { version: 1 },
        });
      });
    });
    const bridge = createTaskRuntimeBridge({
      pi: mock.pi,
      isTasksAvailable: () => false,
      setTasksAvailable,
      getNativeTaskStore: () => undefined,
    });

    bridge.checkTasksVersion();
    await flushAsync();

    expect(setTasksAvailable).toHaveBeenCalledWith(true);
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

describe("task-rpc createWorkflowTask", () => {
  it("creates a native task with typed workflow ownership", async () => {
    const { pi, emittedEvents } = createMockPi();
    const store = new TaskStore();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
    });

    const id = await bridge.createWorkflowTask(workflowLoop());

    expect(store.get(id!)?.workflow).toEqual({ loopId: "1", stateId: "investigate", transitionSeq: 3 });
    expect(store.get(id!)?.metadata).toEqual({ workflow: { loopId: "1", stateId: "investigate", transitionSeq: 3 } });
    expect(emittedEvents.some((event) => event.name === "tasks:created" && event.payload.taskId === id)).toBe(true);
  });

  it("does not create a task for a state without a task definition", async () => {
    const { pi } = createMockPi();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => new TaskStore(),
    });

    expect(await bridge.createWorkflowTask(workflowLoop({
      workflow: {
        ...workflowLoop().workflow!,
        definition: {
          ...workflowLoop().workflow!.definition,
          states: { investigate: { prompt: "Find the cause." } },
        },
      },
    }))).toBeUndefined();
  });

  it("waits for provider detection before creating native workflow state", async () => {
    const { pi } = createMockPi();
    const store = new TaskStore();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      isDetectionSettled: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
    });

    expect(await bridge.createWorkflowTask(workflowLoop())).toBeUndefined();
    expect(store.list()).toHaveLength(0);
  });
});

describe("task-rpc completeWorkflowTask", () => {
  it("completes a native workflow task, emits its lifecycle event, and refreshes native state", async () => {
    const { pi, emittedEvents } = createMockPi();
    const store = new TaskStore();
    const task = store.create("Investigate regression", "Find the cause.");
    const onNativeTaskCompleted = vi.fn();
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
      onNativeTaskCompleted,
    });

    expect(await bridge.completeWorkflowTask(task.id)).toBe(true);
    expect(store.get(task.id)?.status).toBe("completed");
    expect(onNativeTaskCompleted).toHaveBeenCalledWith(store);
    expect(emittedEvents.some((event) => event.name === "tasks:completed" && event.payload.taskId === task.id)).toBe(true);
  });

  it("uses the existing update RPC when pi-tasks owns workflow tasks", async () => {
    const { pi, emittedEvents } = createMockPi({
      respondToTaskUpdate: (request) => ({
        task: {
          id: request.id,
          subject: "Investigate regression",
          description: "Find the cause.",
          status: request.status,
          createdAt: 1,
          updatedAt: 2,
        },
      }),
    });
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => true,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => undefined,
    });

    expect(await bridge.completeWorkflowTask("external-7")).toBe(true);
    expect(emittedEvents.some((event) => event.name === "tasks:rpc:update" && event.payload.id === "external-7" && event.payload.status === "completed")).toBe(true);
  });

  it("does not re-emit completion for an already completed native task", async () => {
    const { pi, emittedEvents } = createMockPi();
    const store = new TaskStore();
    const task = store.create("Investigate regression", "Find the cause.");
    store.complete(task.id);
    const bridge = createTaskRuntimeBridge({
      pi,
      isTasksAvailable: () => false,
      setTasksAvailable: vi.fn(),
      getNativeTaskStore: () => store,
    });

    expect(await bridge.completeWorkflowTask(task.id)).toBe(true);
    expect(emittedEvents.filter((event) => event.name === "tasks:completed")).toHaveLength(0);
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
