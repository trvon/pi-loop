import { computeJitter, cronToNextFire } from "./loop-parse.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry } from "./types.js";

const _MAX_EXPIRY_DAYS = 7;

function computeNextFire(entry: LoopEntry): Date {
  if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
    return cronToNextFire(entry.trigger.type === "hybrid" ? entry.trigger.cron : entry.trigger.schedule);
  }
  return new Date(Date.now() + 60000);
}

export class CronScheduler {
  private fireTimes = new Map<string, number>();

  constructor(
    private store: LoopStore,
    private onFire: (entry: LoopEntry) => void,
  ) {}

  start(): void {
    for (const entry of this.store.list()) {
      if (entry.status !== "active") continue;
      if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
        this.armTimer(entry);
      }
    }
  }

  stop(): void {
    this.fireTimes.clear();
  }

  add(entry: LoopEntry): void {
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
      this.armTimer(entry);
    }
  }

  remove(id: string): void {
    this.fireTimes.delete(id);
  }

  nextFire(id: string): number | undefined {
    return this.fireTimes.get(id);
  }

  private armTimer(entry: LoopEntry): void {
    const _scheduleExpr = entry.trigger.type === "hybrid" ? entry.trigger.cron : (entry.trigger as { schedule: string }).schedule;

    const nextFire = computeNextFire(entry);
    const minuteField = _scheduleExpr.trim().split(/\s+/)[0];
    const minuteStep = minuteField.startsWith("*/") ? parseInt(minuteField.slice(2), 10) || 30 : 30;
    const jitter = computeJitter(entry.id, entry.recurring, minuteStep);
    const fireTime = nextFire.getTime() + jitter;

    if (fireTime > entry.expiresAt) {
      this.store.delete(entry.id);
      return;
    }

    this.fireTimes.set(entry.id, fireTime);
  }

  pump(now: number, filter?: (entry: LoopEntry) => boolean): void {
    for (const [id, fireTime] of this.fireTimes) {
      if (now < fireTime) continue;

      const entry = this.store.get(id);
      if (!entry || entry.status !== "active") {
        this.fireTimes.delete(id);
        continue;
      }

      if (filter && !filter(entry)) continue;

      if (now >= entry.expiresAt) {
        this.store.delete(id);
        this.fireTimes.delete(id);
        continue;
      }

      this.onFire(entry);

      const fresh = this.store.get(id);
      if (!fresh) {
        this.fireTimes.delete(id);
        continue;
      }

      if (fresh.recurring && fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
        this.store.delete(id);
        this.fireTimes.delete(id);
        continue;
      }

      if (fresh.recurring) {
        this.armTimer(fresh);
      } else {
        this.fireTimes.delete(id);
      }
    }
  }
}
