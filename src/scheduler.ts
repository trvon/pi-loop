import { sameLoopActivation } from "./loop-activation.js";
import { computeJitter, cronToNextFire } from "./loop-parse.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry, LoopExpiryDisposition, LoopFireOrigin } from "./types.js";
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

interface ScheduleRecord {
  entry: LoopEntry;
  at: number;
}

function schedulable(entry: LoopEntry | undefined): entry is LoopEntry {
  return entry?.status === "active" && !entry.orchestration && !entry.workflow?.waitingMonitor
    && !isTerminalWorkflowRun(entry.workflow);
}

function sameSchedule(current: LoopEntry, captured: LoopEntry): boolean {
  return sameLoopActivation(current, captured) && current.expiresAt === captured.expiresAt
    && (Boolean(current.workflow) || current.trigger.type !== "dynamic" || (
      current.dynamic?.nextWakeAt === captured.dynamic?.nextWakeAt
      && current.dynamic?.iteration === captured.dynamic?.iteration
    ));
}

export class CronScheduler {
  private fireTimes = new Map<string, ScheduleRecord>();
  private expiryTimes = new Map<string, ScheduleRecord>();

  constructor(
    private store: LoopStore,
    private onFire: ((entry: LoopEntry, origin: LoopFireOrigin) => boolean)
      | ((entry: LoopEntry, origin: LoopFireOrigin) => void),
    private onExpired?: (entry: LoopEntry, disposition: LoopExpiryDisposition) => void,
    private canExpire: () => boolean = () => true,
  ) {}

  start(): void {
    for (const storedEntry of this.store.list()) {
      let entry = storedEntry;
      if (!schedulable(entry)) continue;
      const existing = this.fireTimes.get(entry.id) ?? this.expiryTimes.get(entry.id);
      if (existing && sameSchedule(entry, existing.entry)) continue;
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate && !this.fireTimes.has(entry.id)) {
        entry = this.store.updateDynamic(entry.id, {
          dynamic: {
            awaitingUpdate: false,
            nextWakeAt: undefined,
            lastUpdatedAt: Date.now(),
          },
        }) ?? entry;
      }
      this.add(entry);
    }
  }

  stop(): void {
    this.fireTimes.clear();
    this.expiryTimes.clear();
  }

  add(entry: LoopEntry): void {
    this.remove(entry.id);
    if (!schedulable(entry)) return;
    this.armTimer(entry);
  }

  expire(entry: LoopEntry, now = Date.now()): boolean {
    const captured = structuredClone(entry);
    const owner = this.fireTimes.get(entry.id) ?? this.expiryTimes.get(entry.id);
    if (owner && !this.sameLifetime(owner.entry, captured)) return false;
    return this.retireExpired(captured, now, owner);
  }

  remove(id: string): void {
    this.fireTimes.delete(id);
    this.expiryTimes.delete(id);
  }

  nextFire(id: string): number | undefined {
    return this.fireTimes.get(id)?.at;
  }

  private owns(record: ScheduleRecord): boolean {
    return this.fireTimes.get(record.entry.id) === record || this.expiryTimes.get(record.entry.id) === record;
  }

  private reconcile(record: ScheduleRecord, current: LoopEntry | undefined): void {
    if (!this.owns(record)) return;
    this.remove(record.entry.id);
    if (schedulable(current)) this.armTimer(current);
  }

  private sameLifetime(current: LoopEntry, captured: LoopEntry): boolean {
    return current.createdAt === captured.createdAt && current.expiresAt === captured.expiresAt;
  }

  private retire(entry: LoopEntry, owner: ScheduleRecord): void {
    if (!this.owns(owner)) return;
    if (entry.workflow || entry.taskBacklog) this.store.pause(entry.id, "controller_limit", "scheduler fire cap reached");
    else this.store.delete(entry.id);
    if (this.owns(owner)) this.remove(entry.id);
  }

  private retireExpired(entry: LoopEntry, now: number, owner?: ScheduleRecord): boolean {
    const owns = () => owner ? this.owns(owner) : !this.fireTimes.has(entry.id) && !this.expiryTimes.has(entry.id);
    const reconcile = (current: LoopEntry | undefined) => {
      if (!owns()) return;
      if (owner) this.reconcile(owner, current);
      else if (schedulable(current)) this.armTimer(current);
    };
    if (!owns()) return false;
    const current = this.store.get(entry.id);
    if (current?.status !== "active") {
      reconcile(undefined);
      return true;
    }
    if (!this.sameLifetime(current, entry)) {
      reconcile(current);
      return false;
    }
    if (now < entry.expiresAt || !this.canExpire() || !owns()) return false;
    // The provider callback can replace the creation or deadline without a local
    // registration. The store repeats this lifetime check under its write lock.
    const record = this.store.expireEntry(entry.id, now, {
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
    });
    if (!record) {
      const fresh = this.store.get(entry.id);
      reconcile(fresh);
      return fresh?.status !== "active";
    }
    // Expiry remains committed, but a stopped/replaced dispatcher no longer
    // owns continuation effects such as a hook that removes triggers by ID.
    if (!owns()) return true;
    this.remove(entry.id);
    this.onExpired?.(record.entry, record.disposition);
    return true;
  }

  private armTimer(source: LoopEntry): void {
    const entry = structuredClone(source);
    if (entry.trigger.type === "event") {
      this.expiryTimes.set(entry.id, { entry, at: entry.expiresAt });
      return;
    }
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

    if (fireTime >= entry.expiresAt) {
      this.fireTimes.delete(entry.id);
      this.expiryTimes.set(entry.id, { entry, at: entry.expiresAt });
      return;
    }

    this.expiryTimes.delete(entry.id);
    this.fireTimes.set(entry.id, { entry, at: fireTime });
  }

  pump(now: number, filter?: (entry: LoopEntry) => boolean): void {
    // Snapshot both maps before callbacks: reconciliation must not dispatch a
    // newly registered destination during the pump that observed its old slot.
    const expiries = [...this.expiryTimes.values()];
    const fires = [...this.fireTimes.values()];
    for (const record of expiries) {
      if (!this.owns(record) || now < record.at) continue;
      this.retireExpired(record.entry, now, record);
    }

    for (const record of fires) {
      if (!this.owns(record) || now < record.at) continue;
      const { entry } = record;
      let current = this.store.get(entry.id);
      if (!schedulable(current) || !sameSchedule(current, entry)) {
        this.reconcile(record, current);
        continue;
      }
      if (current.trigger.type === "dynamic" && current.dynamic?.awaitingUpdate) continue;

      const allowed = !filter || filter(structuredClone(current));
      if (!this.owns(record)) continue;
      current = this.store.get(entry.id);
      if (!schedulable(current) || !sameSchedule(current, entry)) {
        this.reconcile(record, current);
        continue;
      }
      if (!allowed || (current.trigger.type === "dynamic" && current.dynamic?.awaitingUpdate)) continue;

      if (now >= current.expiresAt) {
        this.retireExpired(entry, now, record);
        continue;
      }

      const accepted = this.onFire(structuredClone(current), "scheduler") !== false;
      if (!this.owns(record)) continue;
      const fresh = this.store.get(entry.id);
      if (!schedulable(fresh) || !sameLoopActivation(fresh, entry) || fresh.expiresAt !== entry.expiresAt) {
        this.reconcile(record, fresh);
        continue;
      }
      if (!accepted) {
        // A denied unchanged activation remains pending; a peer's new cadence
        // must instead be armed from its own policy, never this old deadline.
        if (!sameSchedule(fresh, entry)) this.reconcile(record, fresh);
        continue;
      }

      if (!fresh.recurring || (fresh.maxFires && (fresh.fireCount ?? 0) >= fresh.maxFires)
        || (fresh.workflow && atWorkflowStateFireLimit(fresh.workflow))) {
        this.retire(fresh, record);
        continue;
      }
      this.reconcile(record, fresh);
    }
  }
}
