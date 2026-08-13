import type { ReducerEffect, ReducerEvent } from "./coordinator.js";
import type { MonitorEntry } from "./types.js";

export type MonitorCompletionEvent = ReducerEvent<
  "MONITOR_ONDONE_TRIGGERED",
  { loopId: string; monitorId: string; monitor?: MonitorEntry }
>;

export type MonitorCompletionEffect = ReducerEffect<
  "DELIVER_MONITOR_ONDONE_WAKE",
  { loopId: string; monitorId: string; monitor?: MonitorEntry }
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
      monitor: event.payload.monitor,
    },
  }];
}
