import { describe, expect, it } from "vitest";
import { createCoordinator, type ReducerEffect, type ReducerHandler } from "../src/coordinator.js";
import {
  reduceTaskBacklogEvent,
  type TaskBacklogEvent,
} from "../src/task-backlog-coordinator.js";

function event(pendingCount: number, threshold = 5): TaskBacklogEvent {
  return {
    type: "TASK_BACKLOG_EVALUATED",
    at: 100,
    source: "system",
    entityType: "task",
    payload: { pendingCount, threshold },
  };
}

describe("task backlog coordinator", () => {
  it("emits worker-ensure effect when pending count reaches the threshold", () => {
    expect(reduceTaskBacklogEvent(event(5))).toEqual([
      {
        type: "ENSURE_AUTO_TASK_WORKER",
        entityType: "task",
        payload: { pendingCount: 5, threshold: 5 },
      },
    ]);
  });

  it("emits cleanup effect when the pending count drops to zero", () => {
    expect(reduceTaskBacklogEvent(event(0))).toEqual([
      {
        type: "CLEANUP_TASK_BACKLOG_LOOPS",
        entityType: "task",
        payload: { pendingCount: 0 },
      },
    ]);
  });

  it("emits no effects for intermediate pending counts", () => {
    expect(reduceTaskBacklogEvent(event(3))).toEqual([]);
  });

  it("routes backlog effects through the coordinator", async () => {
    const handled: string[] = [];
    const reducer: ReducerHandler = incoming => reduceTaskBacklogEvent(incoming as TaskBacklogEvent);
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        ENSURE_AUTO_TASK_WORKER: (effect: ReducerEffect) => {
          handled.push(`${effect.type}:${(effect.payload as { pendingCount: number }).pendingCount}`);
        },
      },
    });

    await coordinator.dispatch(event(6));

    expect(handled).toEqual(["ENSURE_AUTO_TASK_WORKER:6"]);
  });
});
