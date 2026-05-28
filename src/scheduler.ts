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
  private timers = new Map<string, NodeJS.Timeout>();
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
    for (const [id, timer] of this.timers) {
      clearTimeout(timer);
      this.timers.delete(id);
      this.fireTimes.delete(id);
    }
  }

  add(entry: LoopEntry): void {
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
      this.armTimer(entry);
    }
  }

  remove(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
    this.fireTimes.delete(id);
  }

  nextFire(id: string): number | undefined {
    return this.fireTimes.get(id);
  }

  private armTimer(entry: LoopEntry): void {
    const _scheduleExpr = entry.trigger.type === "hybrid" ? entry.trigger.cron : (entry.trigger as { schedule: string }).schedule;

    const nextFire = computeNextFire(entry);
    const jitter = computeJitter(entry.id, entry.recurring, 30);
    const fireTime = nextFire.getTime() + jitter;
    const now = Date.now();

    if (fireTime > entry.expiresAt) {
      this.store.update(entry.id, { status: "expired" });
      return;
    }

    const delay = Math.max(0, fireTime - now);
    this.fireTimes.set(entry.id, fireTime);

    const existing = this.timers.get(entry.id);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      const current = this.store.get(entry.id);
      if (!current || current.status !== "active") {
        this.timers.delete(entry.id);
        this.fireTimes.delete(entry.id);
        return;
      }

      const now2 = Date.now();
      if (now2 >= current.expiresAt) {
        this.store.update(entry.id, { status: "expired" });
        this.timers.delete(entry.id);
        this.fireTimes.delete(entry.id);
        return;
      }

      this.onFire(current);

      if (current.recurring) {
        const fresh = this.store.get(entry.id);
        if (fresh && fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires) {
          this.store.update(entry.id, { status: "expired" });
          this.timers.delete(entry.id);
          this.fireTimes.delete(entry.id);
          return;
        }
        this.armTimer(current);
      } else {
        this.timers.delete(entry.id);
        this.fireTimes.delete(entry.id);
      }
    }, delay);

    this.timers.set(entry.id, timer);
  }
}
