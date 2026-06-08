import type { ReducerEffect, ReducerEvent } from "./coordinator.js";
import type { GoalReducerState } from "./goal-types.js";
import { verifyGoal } from "./goal-verifier.js";
import type { LoopReducerState } from "./loop-reducer.js";
import type { MonitorReducerState } from "./monitor-reducer.js";
import type { TaskReducerState } from "./task-reducer.js";

export type GoalVerificationRequestedEvent = ReducerEvent<
  "GOAL_VERIFICATION_REQUESTED",
  { id: string }
>;

export interface GoalCoordinatorSnapshot {
  goalState: GoalReducerState;
  taskState: TaskReducerState;
  loopState: LoopReducerState;
  monitorState: MonitorReducerState;
}

export function reduceGoalVerificationRequest(
  event: GoalVerificationRequestedEvent,
  snapshot: GoalCoordinatorSnapshot,
): ReducerEffect[] {
  if (event.type !== "GOAL_VERIFICATION_REQUESTED") return [];

  const goal = snapshot.goalState.goalsById[event.payload.id];
  if (!goal) return [];

  return verifyGoal({
    goal,
    taskState: snapshot.taskState,
    loopState: snapshot.loopState,
    monitorState: snapshot.monitorState,
    at: event.at,
  }).effects;
}

export interface GoalCoordinatorOptions {
  getGoalState: () => GoalReducerState;
  getTaskState: () => TaskReducerState;
  getLoopState: () => LoopReducerState;
  getMonitorState: () => MonitorReducerState;
}

export function createGoalCoordinatorReducer(options: GoalCoordinatorOptions) {
  const { getGoalState, getTaskState, getLoopState, getMonitorState } = options;

  return (event: ReducerEvent): ReducerEffect[] => {
    if (event.type !== "GOAL_VERIFICATION_REQUESTED") return [];

    return reduceGoalVerificationRequest(event as GoalVerificationRequestedEvent, {
      goalState: getGoalState(),
      taskState: getTaskState(),
      loopState: getLoopState(),
      monitorState: getMonitorState(),
    });
  };
}
