import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { atMaxFires } from "./loop-reducer.js";
import type { CronScheduler } from "./scheduler.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry } from "./types.js";

export class TriggerSystem {
  private eventSubscriptions = new Map<string, Map<string, () => void>>();
  private hybridTimers = new Map<string, NodeJS.Timeout>();
  private lastFireTime = new Map<string, number>();

  constructor(
    private pi: ExtensionAPI,
    private scheduler: CronScheduler,
    private store: LoopStore,
    private onFire: (entry: LoopEntry) => void,
  ) {}

  start(): void {
    this.scheduler.start();
  }

  stop(): void {
    this.scheduler.stop();
    for (const [_source, subs] of this.eventSubscriptions) {
      for (const unsub of subs.values()) unsub();
    }
    this.eventSubscriptions.clear();
    for (const timer of this.hybridTimers.values()) clearTimeout(timer);
    this.hybridTimers.clear();
  }

  add(entry: LoopEntry): void {
    if (entry.trigger.type === "cron" || entry.trigger.type === "hybrid") {
      this.scheduler.add(entry);
    }
    if (entry.trigger.type === "event" || entry.trigger.type === "hybrid") {
      const ev = entry.trigger.type === "hybrid" ? entry.trigger.event : entry.trigger;
      this.subscribeEvent(entry, ev.source, ev.filter);
    }
  }

  remove(id: string): void {
    this.scheduler.remove(id);
    for (const [source, subs] of this.eventSubscriptions) {
      const unsub = subs.get(id);
      if (unsub) { unsub(); subs.delete(id); }
      if (subs.size === 0) this.eventSubscriptions.delete(source);
    }
    const timer = this.hybridTimers.get(id);
    if (timer) { clearTimeout(timer); this.hybridTimers.delete(id); }
    this.lastFireTime.delete(id);
  }

  private subscribeEvent(entry: LoopEntry, source: string, filter?: string): void {
    if (!this.eventSubscriptions.has(source)) {
      this.eventSubscriptions.set(source, new Map());
    }
    const subs = this.eventSubscriptions.get(source)!;

    const unsub = this.pi.events.on(source, (data: unknown) => {
      if (entry.trigger.type === "hybrid") {
        this.handleHybridFire(entry, data);
      } else {
        if (this.matchesFilter(data, filter)) {
          this.fireLoop(entry);
        }
      }
    });

    subs.set(entry.id, unsub);
  }

  private handleHybridFire(entry: LoopEntry, _data: unknown): void {
    const now = Date.now();
    const last = this.lastFireTime.get(entry.id) ?? 0;
    const debounceMs = entry.trigger.type === "hybrid" ? entry.trigger.debounceMs : 0;

    if (now - last < debounceMs) {
      const existing = this.hybridTimers.get(entry.id);
      if (existing) clearTimeout(existing);
    }

    const remaining = debounceMs - (now - last);
    if (remaining <= 0) {
      this.fireLoop(entry);
      return;
    }

    const timer = setTimeout(() => {
      this.hybridTimers.delete(entry.id);
      this.fireLoop(entry);
    }, remaining);

    this.hybridTimers.set(entry.id, timer);
  }

  private fireLoop(entry: LoopEntry): void {
    const current = this.store.get(entry.id);
    if (!current || current.status !== "active") {
      this.remove(entry.id);
      return;
    }

    this.lastFireTime.set(current.id, Date.now());
    this.onFire(current);

    const fresh = this.store.get(entry.id);
    if (!fresh) {
      this.remove(entry.id);
      return;
    }

    if (fresh.recurring && atMaxFires(fresh)) {
      this.remove(fresh.id);
      this.store.delete(fresh.id);
      return;
    }

    if (!fresh.recurring) {
      this.remove(fresh.id);
      this.store.delete(fresh.id);
    }
  }

  private matchesFilter(data: unknown, filter?: string): boolean {
    if (!filter) return true;

    if (filter.startsWith("regex:")) {
      try {
        const regex = new RegExp(filter.slice(6));
        return regex.test(JSON.stringify(data));
      } catch {
        return false;
      }
    }

    try {
      const parsed = JSON.parse(filter);
      for (const [key, value] of Object.entries(parsed)) {
        const dataValue = (data as Record<string, unknown> | undefined)?.[key];
        if (dataValue === undefined) return false;
        if (typeof value === "object" && typeof dataValue === "object") {
          if (JSON.stringify(value) !== JSON.stringify(dataValue)) return false;
        } else if (String(dataValue) !== String(value)) {
          return false;
        }
      }
      return true;
    } catch {
      return true;
    }
  }
}
