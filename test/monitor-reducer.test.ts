import { describe, expect, it } from "vitest";
import {
  type MonitorReducerEntry,
  type MonitorReducerEvent,
  type MonitorReducerState,
  reduceMonitorState,
} from "../src/monitor-reducer.js";

function makeState(monitors: MonitorReducerEntry[] = [], nextId = 1): MonitorReducerState {
  return {
    nextId,
    monitorsById: Object.fromEntries(monitors.map(monitor => [monitor.id, monitor])),
  };
}

function apply(state: MonitorReducerState, event: MonitorReducerEvent) {
  return reduceMonitorState(state, event);
}

describe("monitor reducer", () => {
  it("creates a running monitor and increments nextId", () => {
    const { state, effects } = apply(makeState(), {
      type: "MONITOR_CREATED",
      at: 100,
      source: "tool",
      entityType: "monitor",
      payload: {
        command: "echo hello",
        description: "test",
        timeout: 300000,
      },
    });

    expect(state.nextId).toBe(2);
    expect(state.monitorsById["1"]).toMatchObject({
      id: "1",
      command: "echo hello",
      description: "test",
      timeout: 300000,
      status: "running",
      startedAt: 100,
      outputLines: 0,
      outputBuffer: [],
    });
    expect(effects).toEqual([
      {
        type: "PERSIST_MONITOR",
        entityType: "monitor",
        entityId: "1",
        payload: { monitor: state.monitorsById["1"] },
      },
    ]);
  });

  it("records output lines and buffers them", () => {
    const initial = makeState([
      {
        id: "1",
        command: "echo hello",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 0,
        outputBuffer: [],
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "MONITOR_OUTPUT",
      at: 200,
      source: "monitor",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1", line: "stdout line" },
    });

    expect(state.monitorsById["1"].outputLines).toBe(1);
    expect(state.monitorsById["1"].outputBuffer).toEqual(["stdout line"]);
    expect(effects).toEqual([
      {
        type: "PERSIST_MONITOR",
        entityType: "monitor",
        entityId: "1",
        payload: { monitor: state.monitorsById["1"] },
      },
    ]);
  });

  it("caps buffered output at 200 lines", () => {
    const initial = makeState([
      {
        id: "1",
        command: "echo hello",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 200,
        outputBuffer: Array.from({ length: 200 }, (_, i) => `line-${i}`),
      },
    ], 2);

    const { state } = apply(initial, {
      type: "MONITOR_OUTPUT",
      at: 201,
      source: "monitor",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1", line: "overflow" },
    });

    expect(state.monitorsById["1"].outputLines).toBe(201);
    expect(state.monitorsById["1"].outputBuffer).toHaveLength(200);
    expect(state.monitorsById["1"].outputBuffer.at(-1)).toBe("line-199");
  });

  it("completes a monitor and records exit code", () => {
    const initial = makeState([
      {
        id: "1",
        command: "echo hello",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 2,
        outputBuffer: ["a", "b"],
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "MONITOR_COMPLETED",
      at: 300,
      source: "monitor",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1", exitCode: 0 },
    });

    expect(state.monitorsById["1"].status).toBe("completed");
    expect(state.monitorsById["1"].exitCode).toBe(0);
    expect(state.monitorsById["1"].completedAt).toBe(300);
    expect(effects).toEqual([
      {
        type: "PERSIST_MONITOR",
        entityType: "monitor",
        entityId: "1",
        payload: { monitor: state.monitorsById["1"] },
      },
    ]);
  });

  it("errors a monitor and stamps completedAt", () => {
    const initial = makeState([
      {
        id: "1",
        command: "exit 1",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 0,
        outputBuffer: [],
      },
    ], 2);

    const { state } = apply(initial, {
      type: "MONITOR_ERRORED",
      at: 400,
      source: "monitor",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1", exitCode: 1, error: "boom" },
    });

    expect(state.monitorsById["1"].status).toBe("error");
    expect(state.monitorsById["1"].exitCode).toBe(1);
    expect(state.monitorsById["1"].completedAt).toBe(400);
  });

  it("stops a monitor", () => {
    const initial = makeState([
      {
        id: "1",
        command: "sleep 30",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 0,
        outputBuffer: [],
      },
    ], 2);

    const { state } = apply(initial, {
      type: "MONITOR_STOPPED",
      at: 500,
      source: "tool",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1", reason: "manual" },
    });

    expect(state.monitorsById["1"].status).toBe("stopped");
    expect(state.monitorsById["1"].completedAt).toBe(500);
  });

  it("marks onDone registration", () => {
    const initial = makeState([
      {
        id: "1",
        command: "echo done",
        timeout: 300000,
        status: "running",
        startedAt: 10,
        outputLines: 0,
        outputBuffer: [],
      },
    ], 2);

    const { state } = apply(initial, {
      type: "MONITOR_ONDONE_REGISTERED",
      at: 600,
      source: "tool",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.monitorsById["1"].onDoneRegistered).toBe(true);
  });

  it("prunes a monitor", () => {
    const initial = makeState([
      {
        id: "1",
        command: "echo done",
        timeout: 300000,
        status: "completed",
        startedAt: 10,
        completedAt: 20,
        outputLines: 0,
        outputBuffer: [],
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "MONITOR_PRUNED",
      at: 700,
      source: "system",
      entityType: "monitor",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.monitorsById["1"]).toBeUndefined();
    expect(effects).toEqual([
      {
        type: "DELETE_MONITOR",
        entityType: "monitor",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("leaves state unchanged for unknown monitor ids", () => {
    const initial = makeState([], 3);

    const { state, effects } = apply(initial, {
      type: "MONITOR_COMPLETED",
      at: 800,
      source: "monitor",
      entityType: "monitor",
      entityId: "99",
      payload: { id: "99", exitCode: 0 },
    });

    expect(state).toEqual(initial);
    expect(effects).toEqual([]);
  });
});
