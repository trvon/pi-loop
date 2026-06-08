import {
  createCoordinator,
  type ReducerEffect,
  type ReducerEvent,
  type ReducerHandler,
} from "../coordinator.js";
import {
  type MonitorCompletionEvent,
  reduceMonitorCompletionEvent,
} from "../monitor-completion-coordinator.js";
import type { MonitorManager } from "../monitor-manager.js";
import type { LoopEntry } from "../types.js";

export interface MonitorOnDoneRuntimeOptions {
  monitorManager: MonitorManager;
  getLoop: (id: string) => LoopEntry | undefined;
  deleteLoop: (id: string) => void;
  onLoopFire: (entry: LoopEntry) => void;
  debug?: (...args: unknown[]) => void;
}

export interface MonitorOnDoneRuntime {
  register(doneLoop: LoopEntry, monitorId: string): void;
}

export function createMonitorOnDoneRuntime(options: MonitorOnDoneRuntimeOptions): MonitorOnDoneRuntime {
  const { monitorManager, getLoop, deleteLoop, onLoopFire, debug } = options;

  const monitorCompletionReducerHandler: ReducerHandler = (incoming: ReducerEvent) => {
    if (incoming.type !== "MONITOR_ONDONE_TRIGGERED") return [];
    return reduceMonitorCompletionEvent(incoming as MonitorCompletionEvent);
  };

  const monitorCompletionCoordinator = createCoordinator({
    reducers: [monitorCompletionReducerHandler],
    effectHandlers: {
      DELIVER_MONITOR_ONDONE_WAKE: (effect: ReducerEffect) => {
        const { loopId, monitorId } = effect.payload as { loopId: string; monitorId: string };
        const current = getLoop(loopId);
        if (!current) return;
        debug?.(`onDone loop #${loopId} — monitor #${monitorId} completed, delivering through coordinator`);
        onLoopFire(current);
        deleteLoop(loopId);
      },
    },
  });

  function register(doneLoop: LoopEntry, monitorId: string): void {
    const deliver = () => {
      void monitorCompletionCoordinator.dispatch({
        type: "MONITOR_ONDONE_TRIGGERED",
        at: Date.now(),
        source: "monitor",
        entityType: "monitor",
        entityId: monitorId,
        payload: { loopId: doneLoop.id, monitorId },
      });
    };

    const registered = monitorManager.onComplete(monitorId, deliver);
    if (registered) return;

    const monitor = monitorManager.get(monitorId);
    if (monitor && monitor.status !== "running") {
      if (monitor.status === "completed") {
        deliver();
        return;
      }
      debug?.(`onDone loop #${doneLoop.id} — monitor #${monitorId} already ${monitor.status}, expiring`);
      deleteLoop(doneLoop.id);
    }
  }

  return { register };
}
