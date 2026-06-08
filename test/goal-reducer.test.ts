import { describe, expect, it } from "vitest";
import { type GoalReducerEvent, reduceGoalState } from "../src/goal-reducer.js";
import type { GoalCriteria, GoalEntry, GoalReducerState } from "../src/goal-types.js";

function baseCriteria(): GoalCriteria {
  return {
    success: {
      minCompletedTasks: 1,
    },
  };
}

function makeState(goals: GoalEntry[] = [], nextId = 1): GoalReducerState {
  return {
    nextId,
    goalsById: Object.fromEntries(goals.map(goal => [goal.id, goal])),
  };
}

function makeGoal(overrides: Partial<GoalEntry> = {}): GoalEntry {
  return {
    id: "1",
    title: "Goal",
    description: "Desc",
    status: "pending",
    verificationStatus: "unknown",
    createdAt: 10,
    updatedAt: 10,
    scope: {},
    criteria: baseCriteria(),
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

function apply(state: GoalReducerState, event: GoalReducerEvent) {
  return reduceGoalState(state, event);
}

describe("goal reducer", () => {
  it("creates a pending goal and increments nextId", () => {
    const { state, effects } = apply(makeState(), {
      type: "GOAL_CREATED",
      at: 100,
      source: "tool",
      entityType: "goal",
      payload: {
        title: "Ship goal runtime",
        description: "Add reducer-driven goals",
        scope: { taskIds: ["1"] },
        criteria: baseCriteria(),
      },
    });

    expect(state.nextId).toBe(2);
    expect(state.goalsById["1"]).toMatchObject({
      id: "1",
      title: "Ship goal runtime",
      status: "pending",
      verificationStatus: "unknown",
      createdAt: 100,
      updatedAt: 100,
      scope: { taskIds: ["1"] },
    });
    expect(effects).toEqual([
      {
        type: "PERSIST_GOAL",
        entityType: "goal",
        entityId: "1",
        payload: { goal: state.goalsById["1"] },
      },
    ]);
  });

  it("activates a pending goal and requests verification", () => {
    const { state, effects } = apply(makeState([makeGoal()], 2), {
      type: "GOAL_ACTIVATED",
      at: 200,
      source: "tool",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.goalsById["1"].status).toBe("active");
    expect(state.goalsById["1"].activatedAt).toBe(200);
    expect(effects.map(effect => effect.type)).toEqual(["PERSIST_GOAL", "REQUEST_GOAL_VERIFICATION"]);
  });

  it("records projected progress", () => {
    const { state } = apply(makeState([makeGoal({ status: "active" })], 2), {
      type: "GOAL_PROGRESS_RECORDED",
      at: 250,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: {
        id: "1",
        progress: {
          totalTasks: 2,
          pendingTasks: 1,
          inProgressTasks: 1,
          completedTasks: 0,
          activeLoops: 1,
          pausedLoops: 0,
          runningMonitors: 1,
          completedMonitors: 0,
          erroredMonitors: 0,
          stoppedMonitors: 0,
          lastProgressAt: 240,
        },
      },
    });

    expect(state.goalsById["1"].progress.totalTasks).toBe(2);
    expect(state.goalsById["1"].progress.lastProgressAt).toBe(240);
  });

  it("marks verification as checking and increments attempts", () => {
    const { state } = apply(makeState([makeGoal({ status: "active" })], 2), {
      type: "GOAL_VERIFICATION_STARTED",
      at: 300,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.goalsById["1"].verificationStatus).toBe("checking");
    expect(state.goalsById["1"].verification.attempts).toBe(1);
    expect(state.goalsById["1"].verification.lastCheckedAt).toBe(300);
  });

  it("satisfies a goal on verification pass", () => {
    const activeGoal = makeGoal({
      status: "active",
      verificationStatus: "checking",
      verification: { attempts: 1, passes: 0, failures: 0 },
    });

    const { state } = apply(makeState([activeGoal], 2), {
      type: "GOAL_VERIFICATION_PASSED",
      at: 400,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1", reason: "success criteria satisfied" },
    });

    expect(state.goalsById["1"].status).toBe("satisfied");
    expect(state.goalsById["1"].verificationStatus).toBe("verified");
    expect(state.goalsById["1"].verification.passes).toBe(1);
    expect(state.goalsById["1"].resolvedAt).toBe(400);
  });

  it("records failed verification without forcing terminal failure", () => {
    const activeGoal = makeGoal({ status: "active", verification: { attempts: 1, passes: 0, failures: 0 } });

    const { state } = apply(makeState([activeGoal], 2), {
      type: "GOAL_VERIFICATION_FAILED",
      at: 500,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1", reason: "still waiting on monitor" },
    });

    expect(state.goalsById["1"].status).toBe("active");
    expect(state.goalsById["1"].verificationStatus).toBe("unverified");
    expect(state.goalsById["1"].verification.failures).toBe(1);
    expect(state.goalsById["1"].verification.lastReason).toBe("still waiting on monitor");
    expect(state.goalsById["1"].resolvedAt).toBeUndefined();
  });

  it("blocks and unblocks a goal", () => {
    const blocked = apply(makeState([makeGoal({ status: "active" })], 2), {
      type: "GOAL_BLOCKED",
      at: 600,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1", reason: "required loop missing" },
    });

    expect(blocked.state.goalsById["1"].status).toBe("blocked");
    expect(blocked.state.goalsById["1"].verificationStatus).toBe("inconclusive");

    const unblocked = apply(blocked.state, {
      type: "GOAL_UNBLOCKED",
      at: 650,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(unblocked.state.goalsById["1"].status).toBe("active");
  });

  it("marks a goal failed terminally", () => {
    const { state } = apply(makeState([makeGoal({ status: "active" })], 2), {
      type: "GOAL_FAILED",
      at: 700,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1", reason: "monitor errored" },
    });

    expect(state.goalsById["1"].status).toBe("failed");
    expect(state.goalsById["1"].resolvedAt).toBe(700);
    expect(state.goalsById["1"].verification.lastReason).toBe("monitor errored");
  });

  it("archives a goal", () => {
    const { state } = apply(makeState([makeGoal({ status: "active" })], 2), {
      type: "GOAL_ARCHIVED",
      at: 800,
      source: "tool",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1", reason: "manual close" },
    });

    expect(state.goalsById["1"].status).toBe("archived");
    expect(state.goalsById["1"].resolvedAt).toBe(800);
    expect(state.goalsById["1"].verification.lastReason).toBe("manual close");
  });

  it("updates title, description, scope, criteria, and metadata", () => {
    const { state } = apply(makeState([makeGoal()], 2), {
      type: "GOAL_UPDATED",
      at: 900,
      source: "tool",
      entityType: "goal",
      entityId: "1",
      payload: {
        id: "1",
        title: "Updated",
        description: "New desc",
        scope: { taskIds: ["2"] },
        criteria: { success: { requiredTaskIds: ["2"] } },
        metadata: { phase: "advisory" },
      },
    });

    expect(state.goalsById["1"]).toMatchObject({
      title: "Updated",
      description: "New desc",
      scope: { taskIds: ["2"] },
      criteria: { success: { requiredTaskIds: ["2"] } },
      metadata: { phase: "advisory" },
      updatedAt: 900,
    });
  });

  it("ignores lifecycle changes for terminal goals", () => {
    const terminal = makeGoal({ status: "satisfied", resolvedAt: 100 });
    const { state, effects } = apply(makeState([terminal], 2), {
      type: "GOAL_UNBLOCKED",
      at: 950,
      source: "coordinator",
      entityType: "goal",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state).toEqual(makeState([terminal], 2));
    expect(effects).toEqual([]);
  });
});
