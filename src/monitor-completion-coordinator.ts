import type { ReducerEffect, ReducerEvent } from "./coordinator.js";

export type MonitorCompletionEvent = ReducerEvent<
  "MONITOR_ONDONE_TRIGGERED",
  { loopId: string; monitorId: string }
>;

export type MonitorCompletionEffect = ReducerEffect<
  "DELIVER_MONITOR_ONDONE_WAKE",
  { loopId: string; monitorId: string }
>;

export function reduceMonitorCompletionEvent(event: MonitorCompletionEvent): MonitorCompletionEffect[] {
  if (event.type !== "MONITOR_ONDONE_TRIGGERED") return [];
  return [{
    type: "DELIVER_MONITOR_ONDONE_WAKE",
    entityType: "monitor",
    entityId: event.payload.monitorId,
    payload: {
      loopId: event.payload.loopId,
      monitorId: event.payload.monitorId,
    },
  }];
}
