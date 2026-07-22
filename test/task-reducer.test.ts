import { describe, expect, it } from "vitest";
import {
  reduceTaskState,
  type TaskReducerEvent,
  type TaskReducerState,
} from "../src/task-reducer.js";
import type { TaskEntry } from "../src/task-types.js";

function makeState(tasks: TaskEntry[] = [], nextId = 1): TaskReducerState {
  return {
    nextId,
    tasksById: Object.fromEntries(tasks.map(task => [task.id, task])),
  };
}

function apply(state: TaskReducerState, event: TaskReducerEvent) {
  return reduceTaskState(state, event);
}

describe("task reducer", () => {
  it("creates a pending task and increments nextId", () => {
    const { state, effects } = apply(makeState(), {
      type: "TASK_CREATED",
      at: 100,
      source: "tool",
      entityType: "task",
      payload: {
        subject: "Write reducer tests",
        description: "Add pure task reducer coverage",
      },
    });

    expect(state.nextId).toBe(2);
    expect(state.tasksById["1"]).toMatchObject({
      id: "1",
      subject: "Write reducer tests",
      description: "Add pure task reducer coverage",
      status: "pending",
      createdAt: 100,
      updatedAt: 100,
    });
    expect(effects).toEqual([
      {
        type: "PERSIST_TASK",
        entityType: "task",
        entityId: "1",
        payload: { task: state.tasksById["1"] },
      },
    ]);
  });

  it("preserves typed workflow ownership on a created task", () => {
    const { state } = apply(makeState(), {
      type: "TASK_CREATED",
      at: 100,
      source: "tool",
      entityType: "task",
      payload: {
        subject: "Investigate regression",
        description: "Find the root cause.",
        workflow: { loopId: "7", stateId: "investigate", transitionSeq: 0 },
      },
    });

    expect(state.tasksById["1"].workflow).toEqual({
      loopId: "7",
      stateId: "investigate",
      transitionSeq: 0,
    });
  });

  it("starts a task", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Task",
        description: "Desc",
        status: "pending",
        createdAt: 10,
        updatedAt: 10,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "TASK_STARTED",
      at: 200,
      source: "tool",
      entityType: "task",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.tasksById["1"].status).toBe("in_progress");
    expect(state.tasksById["1"].updatedAt).toBe(200);
    expect(effects).toEqual([
      {
        type: "PERSIST_TASK",
        entityType: "task",
        entityId: "1",
        payload: { task: state.tasksById["1"] },
      },
    ]);
  });

  it("completes an in-progress task and stamps completedAt", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Task",
        description: "Desc",
        status: "in_progress",
        createdAt: 10,
        updatedAt: 50,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "TASK_COMPLETED",
      at: 300,
      source: "tool",
      entityType: "task",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.tasksById["1"].status).toBe("completed");
    expect(state.tasksById["1"].updatedAt).toBe(300);
    expect(state.tasksById["1"].completedAt).toBe(300);
    expect(effects).toEqual([
      {
        type: "PERSIST_TASK",
        entityType: "task",
        entityId: "1",
        payload: { task: state.tasksById["1"] },
      },
    ]);
  });

  it("reopens a completed task and preserves completedAt", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Task",
        description: "Desc",
        status: "completed",
        createdAt: 10,
        updatedAt: 300,
        completedAt: 300,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "TASK_REOPENED",
      at: 400,
      source: "tool",
      entityType: "task",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.tasksById["1"].status).toBe("pending");
    expect(state.tasksById["1"].updatedAt).toBe(400);
    expect(state.tasksById["1"].completedAt).toBe(300);
    expect(effects).toEqual([
      {
        type: "PERSIST_TASK",
        entityType: "task",
        entityId: "1",
        payload: { task: state.tasksById["1"] },
      },
    ]);
  });

  it("updates subject and description without changing task status", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Old",
        description: "Old desc",
        status: "pending",
        createdAt: 10,
        updatedAt: 10,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "TASK_UPDATED",
      at: 500,
      source: "tool",
      entityType: "task",
      entityId: "1",
      payload: {
        id: "1",
        subject: "New",
        description: "New desc",
      },
    });

    expect(state.tasksById["1"]).toMatchObject({
      subject: "New",
      description: "New desc",
      status: "pending",
      updatedAt: 500,
    });
    expect(effects).toEqual([
      {
        type: "PERSIST_TASK",
        entityType: "task",
        entityId: "1",
        payload: { task: state.tasksById["1"] },
      },
    ]);
  });

  it("deletes a task", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Task",
        description: "Desc",
        status: "pending",
        createdAt: 10,
        updatedAt: 10,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "TASK_DELETED",
      at: 600,
      source: "tool",
      entityType: "task",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.tasksById["1"]).toBeUndefined();
    expect(state.nextId).toBe(2);
    expect(effects).toEqual([
      {
        type: "DELETE_TASK",
        entityType: "task",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("prunes only completed tasks and preserves nextId", () => {
    const initial = makeState([
      {
        id: "1",
        subject: "Done",
        description: "d1",
        status: "completed",
        createdAt: 10,
        updatedAt: 10,
        completedAt: 10,
      },
      {
        id: "2",
        subject: "Active",
        description: "d2",
        status: "in_progress",
        createdAt: 20,
        updatedAt: 20,
      },
      {
        id: "3",
        subject: "Pending",
        description: "d3",
        status: "pending",
        createdAt: 30,
        updatedAt: 30,
      },
    ], 4);

    const { state, effects } = apply(initial, {
      type: "TASKS_PRUNED",
      at: 700,
      source: "system",
      entityType: "task",
      payload: { reason: "git_commit" },
    });

    expect(Object.keys(state.tasksById)).toEqual(["2", "3"]);
    expect(state.nextId).toBe(4);
    expect(effects).toEqual([
      {
        type: "DELETE_TASK",
        entityType: "task",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("leaves state unchanged when an event targets a missing task", () => {
    const initial = makeState([], 3);

    const { state, effects } = apply(initial, {
      type: "TASK_COMPLETED",
      at: 800,
      source: "tool",
      entityType: "task",
      entityId: "99",
      payload: { id: "99" },
    });

    expect(state).toEqual(initial);
    expect(effects).toEqual([]);
  });
});
