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
import type { LoopEntry, MonitorEntry } from "../types.js";

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

function appendMonitorOutcome(prompt: string, monitor: MonitorEntry | undefined): string {
  if (!monitor) return prompt;

  const lines = [
    prompt,
    "",
    `Monitor #${monitor.id} outcome: status=${monitor.status}; exitCode=${monitor.exitCode ?? "unavailable"}; outputLines=${monitor.outputLines}.`,
  ];
  const outputTail = monitor.outputBuffer.slice(-5);
  if (outputTail.length > 0) lines.push("Output tail:", ...outputTail.map(line => `  ${line}`));
  return lines.join("\n");
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
        const { loopId, monitorId, monitor } = effect.payload as {
          loopId: string;
          monitorId: string;
          monitor?: MonitorEntry;
        };
        const current = getLoop(loopId);
        if (!current) return;
        debug?.(`onDone loop #${loopId} — monitor #${monitorId} completed, delivering through coordinator`);
        onLoopFire({
          ...current,
          prompt: appendMonitorOutcome(current.prompt, monitor ?? monitorManager.get(monitorId)),
        });
        deleteLoop(loopId);
      },
    },
  });

  function register(doneLoop: LoopEntry, monitorId: string): void {
    const deliver = (monitor?: MonitorEntry) => {
      void monitorCompletionCoordinator.dispatch({
        type: "MONITOR_ONDONE_TRIGGERED",
        at: Date.now(),
        source: "monitor",
        entityType: "monitor",
        entityId: monitorId,
        payload: { loopId: doneLoop.id, monitorId, monitor },
      });
    };

    const registered = monitorManager.onComplete(monitorId, deliver);
    if (registered) return;

    const monitor = monitorManager.get(monitorId);
    if (monitor && monitor.status !== "running") {
      if (monitor.status === "completed" || monitor.status === "error") {
        deliver();
        return;
      }
      debug?.(`onDone loop #${doneLoop.id} — monitor #${monitorId} already ${monitor.status}, expiring`);
      deleteLoop(doneLoop.id);
    }
  }

  return { register };
}
