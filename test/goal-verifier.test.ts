import { describe, expect, it } from "vitest";
import type { GoalEntry } from "../src/goal-types.js";
import { verifyGoal } from "../src/goal-verifier.js";
import type { LoopReducerState } from "../src/loop-reducer.js";
import type { MonitorReducerState } from "../src/monitor-reducer.js";
import type { TaskReducerState } from "../src/task-reducer.js";
import type { TaskEntry } from "../src/task-types.js";
import type { LoopEntry, MonitorEntry } from "../src/types.js";

function makeGoal(overrides: Partial<GoalEntry> = {}): GoalEntry {
  return {
    id: "1",
    title: "Ship reducer migration",
    description: "verify reducer-backed state",
    status: "active",
    verificationStatus: "unknown",
    createdAt: 10,
    updatedAt: 10,
    scope: {
      taskIds: ["t1", "t2"],
      loopIds: ["l1"],
      monitorIds: ["m1"],
    },
    criteria: {
      success: {
        minCompletedTasks: 2,
        requiredTaskIds: ["t1", "t2"],
        requiredMonitorIdsCompleted: ["m1"],
        requiredLoopIdsPresent: ["l1"],
        requireNoPendingTasksInScope: true,
      },
    },
    progress: {
      totalTasks: 0,
      pendingTasks: 0,
      inProgressTasks: 0,
      completedTasks: 0,
      activeLoops: 0,
      pausedLoops: 0,
      runningMonitors: 0,
      completedMonitors: 0,
      erroredMonitors: 0,
      stoppedMonitors: 0,
    },
    verification: {
      attempts: 0,
      passes: 0,
      failures: 0,
    },
    ...overrides,
  };
}

function taskState(tasks: TaskEntry[]): TaskReducerState {
  return {
    nextId: tasks.length + 1,
    tasksById: Object.fromEntries(tasks.map(task => [task.id, task])),
  };
}

function loopState(loops: LoopEntry[]): LoopReducerState {
  return {
    nextId: loops.length + 1,
    loopsById: Object.fromEntries(loops.map(loop => [loop.id, loop])),
  };
}

function monitorState(monitors: MonitorEntry[]): MonitorReducerState {
  return {
    nextId: monitors.length + 1,
    monitorsById: Object.fromEntries(monitors.map(monitor => [monitor.id, monitor])),
  };
}

describe("goal verifier", () => {
  it("passes when scoped success criteria are satisfied", () => {
    const result = verifyGoal({
      goal: makeGoal(),
      at: 200,
      taskState: taskState([
        { id: "t1", subject: "A", description: "", status: "completed", createdAt: 1, updatedAt: 100, completedAt: 100 },
        { id: "t2", subject: "B", description: "", status: "completed", createdAt: 1, updatedAt: 120, completedAt: 120 },
        { id: "t3", subject: "Out of scope", description: "", status: "pending", createdAt: 1, updatedAt: 190 },
      ]),
      loopState: loopState([
        { id: "l1", prompt: "worker", trigger: { type: "event", source: "tasks:created" }, status: "active", recurring: true, createdAt: 1, updatedAt: 150, expiresAt: 999, fireCount: 0 },
      ]),
      monitorState: monitorState([
        { id: "m1", command: "echo done", timeout: 0, status: "completed", startedAt: 1, completedAt: 180, outputLines: 1, outputBuffer: ["done"] },
      ]),
    });

    expect(result.verdict).toBe("passed");
    expect(result.reason).toBe("success criteria satisfied");
    expect(result.progress).toMatchObject({
      totalTasks: 2,
      pendingTasks: 0,
      inProgressTasks: 0,
      completedTasks: 2,
      activeLoops: 1,
      completedMonitors: 1,
      erroredMonitors: 0,
      lastProgressAt: 180,
    });
    expect(result.effects.map(effect => effect.type)).toEqual([
      "DISPATCH_EVENT",
      "DISPATCH_EVENT",
      "DISPATCH_EVENT",
    ]);
    expect((result.effects[2].payload as { event: { type: string } }).event.type).toBe("GOAL_VERIFICATION_PASSED");
  });

  it("fails when configured errored monitor is present", () => {
    const goal = makeGoal({
      criteria: {
        success: {},
        failure: {
          anyMonitorIdsErrored: ["m1"],
        },
      },
      scope: { monitorIds: ["m1"] },
    });

    const result = verifyGoal({
      goal,
      at: 200,
      taskState: taskState([]),
      loopState: loopState([]),
      monitorState: monitorState([
        { id: "m1", command: "echo fail", timeout: 0, status: "error", startedAt: 1, completedAt: 50, outputLines: 0, outputBuffer: [] },
      ]),
    });

    expect(result.verdict).toBe("failed");
    expect(result.reason).toBe("monitor #m1 errored");
    expect((result.effects[2].payload as { event: { type: string } }).event.type).toBe("GOAL_FAILED");
  });

  it("blocks when required loop is missing and blocked policy is enabled", () => {
    const goal = makeGoal({
      criteria: {
        success: {
          requiredLoopIdsPresent: ["l1"],
        },
        blocked: {
          blockedIfRequiredLoopMissing: true,
        },
      },
      scope: { loopIds: ["l1"] },
    });

    const result = verifyGoal({
      goal,
      at: 200,
      taskState: taskState([]),
      loopState: loopState([]),
      monitorState: monitorState([]),
    });

    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("required loop missing");
    expect((result.effects[2].payload as { event: { type: string } }).event.type).toBe("GOAL_BLOCKED");
  });

  it("blocks when no scoped progress has occurred within the configured interval", () => {
    const goal = makeGoal({
      criteria: {
        success: {
          minCompletedTasks: 1,
        },
        blocked: {
          blockedIfNoScopedProgressSinceMs: 50,
        },
      },
      scope: { taskIds: ["t1"] },
    });

    const result = verifyGoal({
      goal,
      at: 200,
      taskState: taskState([
        { id: "t1", subject: "A", description: "", status: "pending", createdAt: 1, updatedAt: 100 },
      ]),
      loopState: loopState([]),
      monitorState: monitorState([]),
    });

    expect(result.verdict).toBe("blocked");
    expect(result.reason).toBe("no scoped progress within configured interval");
  });

  it("fails verification when success criteria are not yet satisfied but no hard failure or block applies", () => {
    const result = verifyGoal({
      goal: makeGoal(),
      at: 200,
      taskState: taskState([
        { id: "t1", subject: "A", description: "", status: "completed", createdAt: 1, updatedAt: 100, completedAt: 100 },
        { id: "t2", subject: "B", description: "", status: "in_progress", createdAt: 1, updatedAt: 140 },
      ]),
      loopState: loopState([
        { id: "l1", prompt: "worker", trigger: { type: "event", source: "tasks:created" }, status: "active", recurring: true, createdAt: 1, updatedAt: 150, expiresAt: 999, fireCount: 0 },
      ]),
      monitorState: monitorState([
        { id: "m1", command: "echo done", timeout: 0, status: "running", startedAt: 1, outputLines: 0, outputBuffer: [] },
      ]),
    });

    expect(result.verdict).toBe("failed");
    expect(result.reason).toBe("success criteria not yet satisfied");
    expect((result.effects[2].payload as { event: { type: string } }).event.type).toBe("GOAL_VERIFICATION_FAILED");
  });
});
