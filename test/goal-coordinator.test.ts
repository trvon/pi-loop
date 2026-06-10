import { describe, expect, it } from "vitest";
import { type Coordinator, createCoordinator, type ReducerEvent, type ReducerHandler } from "../src/coordinator.js";
import { createGoalCoordinatorReducer, type GoalVerificationRequestedEvent, reduceGoalVerificationRequest } from "../src/goal-coordinator.js";
import { type GoalReducerEvent, reduceGoalState } from "../src/goal-reducer.js";
import type { GoalCriteria, GoalEntry, GoalReducerState } from "../src/goal-types.js";
import type { LoopReducerState } from "../src/loop-reducer.js";
import type { MonitorReducerState } from "../src/monitor-reducer.js";
import type { TaskReducerState } from "../src/task-reducer.js";
import type { TaskEntry } from "../src/task-types.js";
import type { LoopEntry, MonitorEntry } from "../src/types.js";
import { emptyGoalProgress, emptyGoalVerification } from "./helpers/factories.js";

function criteria(): GoalCriteria {
  return {
    success: {
      minCompletedTasks: 1,
      requiredTaskIds: ["t1"],
      requireNoPendingTasksInScope: true,
    },
  };
}

function makeGoal(overrides: Partial<GoalEntry> = {}): GoalEntry {
  return {
    id: "1",
    title: "Ship goal runtime",
    description: "Add advisory goal coordinator",
    status: "active",
    verificationStatus: "unknown",
    createdAt: 10,
    updatedAt: 10,
    scope: { taskIds: ["t1"] },
    criteria: criteria(),
    progress: emptyGoalProgress(),
    verification: emptyGoalVerification(),
    ...overrides,
  };
}

function goalState(goals: GoalEntry[], nextId = 2): GoalReducerState {
  return {
    nextId,
    goalsById: Object.fromEntries(goals.map(goal => [goal.id, goal])),
  };
}

function taskState(tasks: TaskEntry[]): TaskReducerState {
  return {
    nextId: tasks.length + 1,
    tasksById: Object.fromEntries(tasks.map(task => [task.id, task])),
  };
}

function loopState(loops: LoopEntry[] = []): LoopReducerState {
  return {
    nextId: loops.length + 1,
    loopsById: Object.fromEntries(loops.map(loop => [loop.id, loop])),
  };
}

function monitorState(monitors: MonitorEntry[] = []): MonitorReducerState {
  return {
    nextId: monitors.length + 1,
    monitorsById: Object.fromEntries(monitors.map(monitor => [monitor.id, monitor])),
  };
}

function requestEvent(id = "1", at = 200): GoalVerificationRequestedEvent {
  return {
    type: "GOAL_VERIFICATION_REQUESTED",
    at,
    source: "coordinator",
    entityType: "goal",
    entityId: id,
    payload: { id },
  };
}

describe("goal coordinator", () => {
  it("projects current reducer state into goal verification effects", () => {
    const effects = reduceGoalVerificationRequest(requestEvent(), {
      goalState: goalState([makeGoal()]),
      taskState: taskState([
        { id: "t1", subject: "Task", description: "", status: "completed", createdAt: 1, updatedAt: 150, completedAt: 150 },
      ]),
      loopState: loopState(),
      monitorState: monitorState(),
    });

    expect(effects.map(effect => effect.type)).toEqual([
      "DISPATCH_EVENT",
      "DISPATCH_EVENT",
      "DISPATCH_EVENT",
    ]);
    expect((effects[2].payload as { event: { type: string } }).event.type).toBe("GOAL_VERIFICATION_PASSED");
  });

  it("returns no effects when the goal is missing", () => {
    const effects = reduceGoalVerificationRequest(requestEvent("999"), {
      goalState: goalState([]),
      taskState: taskState([]),
      loopState: loopState(),
      monitorState: monitorState(),
    });

    expect(effects).toEqual([]);
  });

  it("routes advisory verification through the coordinator", async () => {
    let goals = goalState([
      makeGoal({
        status: "pending",
        verificationStatus: "unknown",
        scope: { taskIds: ["t1"] },
        criteria: criteria(),
      }),
    ]);
    const tasks = taskState([
      { id: "t1", subject: "Task", description: "", status: "completed", createdAt: 1, updatedAt: 150, completedAt: 150 },
    ]);
    const loops = loopState();
    const monitors = monitorState();

    const goalReducer: ReducerHandler = (incoming) => {
      const result = reduceGoalState(goals, incoming as GoalReducerEvent);
      goals = result.state;
      return result.effects;
    };
    const advisoryReducer = createGoalCoordinatorReducer({
      getGoalState: () => goals,
      getTaskState: () => tasks,
      getLoopState: () => loops,
      getMonitorState: () => monitors,
    });

    let coordinator!: Coordinator;
    coordinator = createCoordinator({
      reducers: [goalReducer, advisoryReducer],
      effectHandlers: {
        REQUEST_GOAL_VERIFICATION: async (effect) => {
          const id = (effect.payload as { id: string }).id;
          await coordinator.dispatch(requestEvent(id, 250));
        },
      },
    });

    await coordinator.dispatch({
      type: "GOAL_ACTIVATED",
      at: 200,
      source: "tool",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1" },
    } as ReducerEvent);

    expect(goals.goalsById["1"].status).toBe("satisfied");
    expect(goals.goalsById["1"].verificationStatus).toBe("verified");
    expect(goals.goalsById["1"].progress.completedTasks).toBe(1);
    expect(goals.goalsById["1"].verification.passes).toBe(1);
  });

  it("can drive blocked advisory outcomes without mutating loops or monitors", async () => {
    let goals = goalState([
      makeGoal({
        status: "active",
        criteria: {
          success: { requiredLoopIdsPresent: ["l1"] },
          blocked: { blockedIfRequiredLoopMissing: true },
        },
        scope: { loopIds: ["l1"] },
      }),
    ]);

    const goalReducer: ReducerHandler = (incoming) => {
      const result = reduceGoalState(goals, incoming as GoalReducerEvent);
      goals = result.state;
      return result.effects;
    };

    const advisoryReducer = createGoalCoordinatorReducer({
      getGoalState: () => goals,
      getTaskState: () => taskState([]),
      getLoopState: () => loopState([]),
      getMonitorState: () => monitorState([]),
    });

    const coordinator = createCoordinator({
      reducers: [goalReducer, advisoryReducer],
    });

    await coordinator.dispatch(requestEvent("1", 300));

    expect(goals.goalsById["1"].status).toBe("blocked");
    expect(goals.goalsById["1"].verificationStatus).toBe("inconclusive");
  });
});
