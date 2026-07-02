import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PROTOCOL_VERSION } from "../src/rpc/cross-extension-rpc.js";
import { NATIVE_TASKS_PROVIDER, registerNativeTaskRpc } from "../src/runtime/native-task-rpc.js";
import { TaskStore } from "../src/task-store.js";
import { createMockPi, flushAsync, type MockPi } from "./helpers/mock-pi.js";

let tmpDir: string;
let n = 0;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "pi-loop-rpc-"));
  n = 0;
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function setup(opts: { store?: boolean; detectionSettled?: boolean } = {}) {
  const mock = createMockPi({ respondToTaskClean: false });
  const store = opts.store === false ? undefined : new TaskStore(join(tmpDir, `tasks-${n++}.json`));
  const evaluateTaskBacklog = vi.fn(async () => ({ created: false }));
  const updateWidget = vi.fn();
  const debug = vi.fn();
  let enabled = true;
  let settled = opts.detectionSettled ?? true;
  registerNativeTaskRpc({
    pi: mock.pi,
    getNativeTaskStore: () => store,
    isEnabled: () => enabled,
    isDetectionSettled: () => settled,
    evaluateTaskBacklog,
    updateWidget,
    debug,
  });
  return {
    mock,
    store,
    evaluateTaskBacklog,
    updateWidget,
    debug,
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    setSettled: (v: boolean) => {
      settled = v;
    },
  };
}

function replyOf(mock: MockPi, channel: string, id: string) {
  return mock.emittedEvents.find((e) => e.name === `${channel}:reply:${id}`)?.payload;
}

function repliesFor(mock: MockPi, channel: string) {
  return mock.emittedEvents.filter((e) => e.name.startsWith(`${channel}:reply`));
}

describe("tasks:rpc:ping", () => {
  it("replies with the protocol version and native provider tag", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:ping", { requestId: "r1" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:ping", "r1")).toEqual({
      success: true,
      data: { version: PROTOCOL_VERSION, provider: NATIVE_TASKS_PROVIDER },
    });
  });

  it("drops the request silently when requestId is missing, but debugs it", async () => {
    const { mock, debug } = setup();
    mock.pi.events.emit("tasks:rpc:ping", {});
    await flushAsync();

    expect(repliesFor(mock, "tasks:rpc:ping")).toHaveLength(0);
    expect(debug).toHaveBeenCalled();
  });

  it("still replies when no native task store is registered", async () => {
    const { mock } = setup({ store: false });
    mock.pi.events.emit("tasks:rpc:ping", { requestId: "r2" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:ping", "r2")).toEqual({
      success: true,
      data: { version: PROTOCOL_VERSION, provider: NATIVE_TASKS_PROVIDER },
    });
  });

  it("is a silent no-op when disabled", async () => {
    const { mock, setEnabled } = setup();
    setEnabled(false);
    mock.pi.events.emit("tasks:rpc:ping", { requestId: "r3" });
    await flushAsync();

    expect(repliesFor(mock, "tasks:rpc:ping")).toHaveLength(0);
  });
});

describe("tasks:rpc:pending", () => {
  it("returns the pending count from the store", async () => {
    const { mock, store } = setup();
    store!.create("a", "d");
    store!.create("b", "d");

    mock.pi.events.emit("tasks:rpc:pending", { requestId: "r1" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:pending", "r1")).toEqual({
      success: true,
      data: { pending: 2 },
    });
  });

  it("fails when the native task store is unavailable", async () => {
    const { mock } = setup({ store: false });
    mock.pi.events.emit("tasks:rpc:pending", { requestId: "r1" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:pending", "r1")).toEqual({
      success: false,
      error: "native task store unavailable",
    });
  });
});

describe("tasks:rpc:create", () => {
  it("creates a task, persists it, emits tasks:created, and settles the backlog", async () => {
    const { mock, store, evaluateTaskBacklog, updateWidget } = setup();
    mock.pi.events.emit("tasks:rpc:create", {
      requestId: "r1",
      subject: "Fix bug",
      description: "the details",
      metadata: { source: "test" },
    });
    await flushAsync();

    const reply = replyOf(mock, "tasks:rpc:create", "r1");
    expect(reply.success).toBe(true);
    expect(reply.data.id).toBeDefined();
    expect(reply.data.task.subject).toBe("Fix bug");

    const persisted = store!.get(reply.data.id);
    expect(persisted?.subject).toBe("Fix bug");
    expect(persisted?.description).toBe("the details");
    expect(persisted?.metadata).toEqual({ source: "test" });

    expect(
      mock.emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === reply.data.id),
    ).toBe(true);
    expect(evaluateTaskBacklog).toHaveBeenCalledTimes(1);
    expect(evaluateTaskBacklog).toHaveBeenCalledWith(store, store!.pendingCount());
    expect(updateWidget).toHaveBeenCalled();
  });

  it("fails when subject is missing", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:create", { requestId: "r1", description: "d" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:create", "r1")).toEqual({
      success: false,
      error: "subject and description are required",
    });
  });

  it("fails when description is missing", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:create", { requestId: "r1", subject: "s" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:create", "r1")).toEqual({
      success: false,
      error: "subject and description are required",
    });
  });

  it("fails with the thrown Error message when store.create throws", async () => {
    const { mock, store } = setup();
    vi.spyOn(store!, "create").mockImplementation(() => {
      throw new Error("disk full");
    });

    mock.pi.events.emit("tasks:rpc:create", { requestId: "r1", subject: "s", description: "d" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:create", "r1")).toEqual({
      success: false,
      error: "disk full",
    });
  });

  it("stringifies a non-Error throw from store.create", async () => {
    const { mock, store } = setup();
    vi.spyOn(store!, "create").mockImplementation(() => {
      throw "boom";
    });

    mock.pi.events.emit("tasks:rpc:create", { requestId: "r1", subject: "s", description: "d" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:create", "r1")).toEqual({
      success: false,
      error: "boom",
    });
  });

  it("fails when the native task store is unavailable", async () => {
    const { mock } = setup({ store: false });
    mock.pi.events.emit("tasks:rpc:create", { requestId: "r1", subject: "s", description: "d" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:create", "r1")).toEqual({
      success: false,
      error: "native task store unavailable",
    });
  });

  it("drops the request silently when requestId is missing", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:create", { subject: "s", description: "d" });
    await flushAsync();

    expect(repliesFor(mock, "tasks:rpc:create")).toHaveLength(0);
  });
});

describe("tasks:rpc:clean", () => {
  it("prunes completed tasks and settles the backlog", async () => {
    const { mock, store, updateWidget, evaluateTaskBacklog, debug } = setup();
    const t = store!.create("done", "d");
    store!.complete(t.id);

    mock.pi.events.emit("tasks:rpc:clean", { requestId: "r1" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:clean", "r1")).toEqual({
      success: true,
      data: { pruned: 1 },
    });
    expect(updateWidget).toHaveBeenCalled();
    expect(evaluateTaskBacklog).toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  it("fails when the native task store is unavailable", async () => {
    const { mock } = setup({ store: false });
    mock.pi.events.emit("tasks:rpc:clean", { requestId: "r1" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:clean", "r1")).toEqual({
      success: false,
      error: "native task store unavailable",
    });
  });
});

describe("tasks:rpc:update", () => {
  it("fails when id is missing", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:update", { requestId: "r1", status: "completed" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:update", "r1")).toEqual({
      success: false,
      error: "id is required",
    });
  });

  it("fails for an unknown id", async () => {
    const { mock } = setup();
    mock.pi.events.emit("tasks:rpc:update", { requestId: "r1", id: "99", status: "completed" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:update", "r1")).toEqual({
      success: false,
      error: "Task #99 not found",
    });
  });

  it("walks status transitions and emits the matching lifecycle events", async () => {
    const { mock, store } = setup();
    store!.create("subject", "desc");

    mock.pi.events.emit("tasks:rpc:update", { requestId: "r1", id: "1", status: "in_progress" });
    await flushAsync();
    let reply = replyOf(mock, "tasks:rpc:update", "r1");
    expect(reply.success).toBe(true);
    expect(reply.data.task.status).toBe("in_progress");
    let evt = mock.emittedEvents.find((e) => e.name === "tasks:started" && e.payload.taskId === "1");
    expect(evt?.payload.previousStatus).toBe("pending");

    mock.pi.events.emit("tasks:rpc:update", { requestId: "r2", id: "1", status: "completed" });
    await flushAsync();
    reply = replyOf(mock, "tasks:rpc:update", "r2");
    expect(reply.data.task.status).toBe("completed");
    evt = mock.emittedEvents.find((e) => e.name === "tasks:completed" && e.payload.taskId === "1");
    expect(evt?.payload.previousStatus).toBe("in_progress");

    mock.pi.events.emit("tasks:rpc:update", { requestId: "r3", id: "1", status: "pending" });
    await flushAsync();
    reply = replyOf(mock, "tasks:rpc:update", "r3");
    expect(reply.data.task.status).toBe("pending");
    evt = mock.emittedEvents.find((e) => e.name === "tasks:reopened" && e.payload.taskId === "1");
    expect(evt?.payload.previousStatus).toBe("completed");
  });

  it("emits tasks:updated with the unchanged current status for a details-only edit", async () => {
    const { mock, store } = setup();
    store!.create("subject", "desc");

    mock.pi.events.emit("tasks:rpc:update", {
      requestId: "r1",
      id: "1",
      subject: "renamed",
      description: "new desc",
    });
    await flushAsync();

    const reply = replyOf(mock, "tasks:rpc:update", "r1");
    expect(reply.success).toBe(true);
    expect(store!.get("1")?.subject).toBe("renamed");

    const evt = mock.emittedEvents.find((e) => e.name === "tasks:updated" && e.payload.taskId === "1");
    expect(evt?.payload.previousStatus).toBe("pending");
  });

  it("emits both the transition event and tasks:updated when status and details change together", async () => {
    const { mock, store } = setup();
    store!.create("subject", "desc");

    mock.pi.events.emit("tasks:rpc:update", {
      requestId: "r1",
      id: "1",
      status: "completed",
      subject: "renamed",
    });
    await flushAsync();

    const completedEvt = mock.emittedEvents.find(
      (e) => e.name === "tasks:completed" && e.payload.taskId === "1",
    );
    expect(completedEvt?.payload.previousStatus).toBe("pending");

    const updatedEvt = mock.emittedEvents.find((e) => e.name === "tasks:updated" && e.payload.taskId === "1");
    expect(updatedEvt?.payload.previousStatus).toBe("completed");
  });

  it("fails with 'not found' when store.start returns undefined mid-update", async () => {
    const { mock, store } = setup();
    store!.create("subject", "desc");
    vi.spyOn(store!, "start").mockReturnValue(undefined);

    mock.pi.events.emit("tasks:rpc:update", { requestId: "r1", id: "1", status: "in_progress" });
    await flushAsync();

    expect(replyOf(mock, "tasks:rpc:update", "r1")).toEqual({
      success: false,
      error: "Task #1 not found",
    });
  });

  it("is a silent no-op when disabled", async () => {
    const { mock, store, setEnabled } = setup();
    store!.create("subject", "desc");
    setEnabled(false);

    mock.pi.events.emit("tasks:rpc:update", { requestId: "r1", id: "1", status: "completed" });
    await flushAsync();

    expect(repliesFor(mock, "tasks:rpc:update")).toHaveLength(0);
  });
});

describe("native-task-rpc detection-window gate", () => {
  it("answers ping but keeps mutating verbs silent until detection settles", async () => {
    const { mock, setSettled } = setup({ detectionSettled: false });

    mock.pi.events.emit("tasks:rpc:ping", { requestId: "gate-ping" });
    await flushAsync();
    expect(replyOf(mock, "tasks:rpc:ping", "gate-ping")).toMatchObject({ success: true });

    mock.pi.events.emit("tasks:rpc:create", {
      requestId: "gate-create",
      subject: "s",
      description: "d",
    });
    mock.pi.events.emit("tasks:rpc:pending", { requestId: "gate-pending" });
    await flushAsync();
    expect(replyOf(mock, "tasks:rpc:create", "gate-create")).toBeUndefined();
    expect(replyOf(mock, "tasks:rpc:pending", "gate-pending")).toBeUndefined();

    setSettled(true);
    mock.pi.events.emit("tasks:rpc:create", {
      requestId: "gate-create-2",
      subject: "s",
      description: "d",
    });
    await flushAsync();
    expect(replyOf(mock, "tasks:rpc:create", "gate-create-2")).toMatchObject({ success: true });
  });
});
