import { computeJitter, cronToNextFire } from "./loop-parse.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry, LoopFireOrigin } from "./types.js";
import { atWorkflowStateFireLimit, getActiveWorkflowStateLoop, isTerminalWorkflowRun } from "./workflow-reducer.js";

function computeNextFire(entry: LoopEntry): Date {
  const workflowLoop = entry.workflow && getActiveWorkflowStateLoop(entry.workflow);
  if (workflowLoop) return cronToNextFire(workflowLoop.schedule);
  if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
    return cronToNextFire(entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule);
  }
  if (entry.trigger.type === "dynamic") {
    return new Date(entry.dynamic?.nextWakeAt ?? Date.now());
  }
  return new Date(Date.now() + 60000);
}

export class CronScheduler {
  private fireTimes = new Map<string, number>();

  constructor(
    private store: LoopStore,
    private onFire: (entry: LoopEntry, origin: LoopFireOrigin) => void,
  ) {}

  start(): void {
    for (const storedEntry of this.store.list()) {
      let entry = storedEntry;
      if (entry.status !== "active" || entry.orchestration || entry.workflow?.waitingMonitor || isTerminalWorkflowRun(entry.workflow)) continue;
      if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.trigger.type === "dynamic") {
        if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate && !this.fireTimes.has(entry.id)) {
          entry = this.store.updateDynamic(entry.id, {
            dynamic: {
              awaitingUpdate: false,
              nextWakeAt: undefined,
              lastUpdatedAt: Date.now(),
            },
          }) ?? entry;
        }
        this.armTimer(entry);
      }
    }
  }

  stop(): void {
    this.fireTimes.clear();
  }

  add(entry: LoopEntry): void {
    if (!entry.orchestration && !entry.workflow?.waitingMonitor && !isTerminalWorkflowRun(entry.workflow) && (entry.trigger.type === "cron" || entry.trigger.type === "hybrid" || entry.trigger.type === "dynamic")) {
      this.armTimer(entry);
    }
  }

  remove(id: string): void {
    this.fireTimes.delete(id);
  }

  nextFire(id: string): number | undefined {
    return this.fireTimes.get(id);
  }

  private retire(entry: LoopEntry): void {
    if (entry.workflow || entry.taskBacklog) this.store.pause(entry.id, "controller_limit", "scheduler fire cap reached");
    else this.store.delete(entry.id);
    this.fireTimes.delete(entry.id);
  }

  private armTimer(entry: LoopEntry): void {
    if (entry.workflow?.waitingMonitor) return;
    const nextFire = computeNextFire(entry);
    let jitter = 0;
    const workflowLoop = entry.workflow && getActiveWorkflowStateLoop(entry.workflow);
    if (workflowLoop || entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
      const scheduleExpr = workflowLoop?.schedule
        ?? (entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.type === "cron" ? entry.trigger.schedule : "");
      const minuteField = scheduleExpr.trim().split(/\s+/)[0] ?? "";
      const minuteStep = minuteField.startsWith("*/") ? parseInt(minuteField.slice(2), 10) || 30 : 30;
      jitter = computeJitter(entry.id, entry.recurring, minuteStep);
    }
    const fireTime = nextFire.getTime() + jitter;

    if (fireTime > entry.expiresAt) {
      this.retire(entry);
      return;
    }

    this.fireTimes.set(entry.id, fireTime);
  }

  pump(now: number, filter?: (entry: LoopEntry) => boolean): void {
    for (const [id, fireTime] of this.fireTimes) {
      if (now < fireTime) continue;

      const entry = this.store.get(id);
      if (entry?.status !== "active" || entry.orchestration || entry.workflow?.waitingMonitor || isTerminalWorkflowRun(entry.workflow)) {
        this.fireTimes.delete(id);
        continue;
      }

      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) continue;

      if (filter && !filter(entry)) continue;

      if (now >= entry.expiresAt) {
        this.retire(entry);
        continue;
      }

      this.onFire(entry, "scheduler");

      const fresh = this.store.get(id);
      if (!fresh) {
        this.fireTimes.delete(id);
        continue;
      }

      if (!fresh.recurring) {
        this.retire(fresh);
        continue;
      }

      if (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
        this.retire(fresh);
        continue;
      }

      if (fresh.workflow && atWorkflowStateFireLimit(fresh.workflow)) {
        this.retire(fresh);
        continue;
      }

      this.armTimer(fresh);
    }
  }
}
