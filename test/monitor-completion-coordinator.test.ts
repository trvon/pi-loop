import { describe, expect, it } from "vitest";
import { createCoordinator, type ReducerEffect, type ReducerHandler } from "../src/coordinator.js";
import {
  type MonitorCompletionEvent,
  reduceMonitorCompletionEvent,
} from "../src/monitor-completion-coordinator.js";

function event(loopId = "7", monitorId = "3"): MonitorCompletionEvent {
  return {
    type: "MONITOR_ONDONE_TRIGGERED",
    at: 100,
    source: "monitor",
    entityType: "monitor",
    entityId: monitorId,
    payload: { loopId, monitorId },
  };
}

describe("monitor completion coordinator", () => {
  it("reduces a monitor completion wake request into a delivery effect", () => {
    expect(reduceMonitorCompletionEvent(event())).toEqual([
      {
        type: "DELIVER_MONITOR_ONDONE_WAKE",
        entityType: "monitor",
        entityId: "3",
        payload: { loopId: "7", monitorId: "3" },
      },
    ]);
  });

  it("delivers monitor completion wakes through the coordinator", async () => {
    const delivered: Array<{ loopId: string; monitorId: string }> = [];
    const reducer: ReducerHandler = incoming => reduceMonitorCompletionEvent(incoming as MonitorCompletionEvent);

    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        DELIVER_MONITOR_ONDONE_WAKE: (effect: ReducerEffect) => {
          delivered.push(effect.payload as { loopId: string; monitorId: string });
        },
      },
    });

    await coordinator.dispatch(event("11", "5"));

    expect(delivered).toEqual([{ loopId: "11", monitorId: "5" }]);
  });
});
