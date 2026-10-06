import type { LoopEntry, Trigger } from "./types.js";

function sameTrigger(left: Trigger, right: Trigger): boolean {
  switch (left.type) {
    case "cron":
      return right.type === "cron" && left.schedule === right.schedule;
    case "event":
      return right.type === "event" && left.source === right.source && left.filter === right.filter;
    case "hybrid":
      return right.type === "hybrid" && left.cron === right.cron
        && left.event.source === right.event.source && left.event.filter === right.event.filter
        && left.debounceMs === right.debounceMs;
    case "dynamic":
      return right.type === "dynamic";
  }
}

/** Fire counters and bookkeeping change within an activation; policy and work identity do not. */
export function sameLoopActivation(current: LoopEntry, captured: LoopEntry): boolean {
  return current.id === captured.id && current.createdAt === captured.createdAt
    && sameTrigger(current.trigger, captured.trigger)
    && current.workflow?.currentState === captured.workflow?.currentState
    && current.workflow?.transitionSeq === captured.workflow?.transitionSeq
    && current.workflow?.definitionRevision === captured.workflow?.definitionRevision
    && current.workflow?.activeExecution?.id === captured.workflow?.activeExecution?.id
    && current.workflow?.waitingMonitor?.monitorId === captured.workflow?.waitingMonitor?.monitorId;
}
