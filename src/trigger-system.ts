import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { sameLoopActivation } from "./loop-activation.js";
import { atMaxFires } from "./loop-reducer.js";
import type { CronScheduler } from "./scheduler.js";
import type { LoopStore } from "./store.js";
import type { LoopEntry, LoopFireOrigin } from "./types.js";
import { isTerminalWorkflowRun } from "./workflow-reducer.js";

interface EventRegistration {
  entry: LoopEntry;
  unsubscribe: () => void;
}

interface HybridTimer {
  registration: EventRegistration;
  handle: NodeJS.Timeout;
}

interface DebounceReservation {
  registration: EventRegistration;
  at: number;
}

export class TriggerSystem {
  private eventSubscriptions = new Map<string, EventRegistration>();
  private hybridTimers = new Map<string, HybridTimer>();
  private lastFireTime = new Map<string, DebounceReservation>();

  constructor(
    private pi: ExtensionAPI,
    private scheduler: CronScheduler,
    private store: LoopStore,
    private onFire: ((entry: LoopEntry, origin: LoopFireOrigin) => boolean)
      | ((entry: LoopEntry, origin: LoopFireOrigin) => void),
  ) {}

  start(): void {
    this.scheduler.start();
    for (const entry of this.store.list()) this.subscribeEvent(entry);
  }

  stop(): void {
    const registrations = [...this.eventSubscriptions.values()];
    const timers = [...this.hybridTimers.values()];
    // Node EventEmitter retains listeners already selected for an emission.
    // Invalidate all ownership before invoking external unsubscribe functions.
    this.eventSubscriptions.clear();
    this.hybridTimers.clear();
    this.lastFireTime.clear();
    this.scheduler.stop();
    for (const registration of registrations) registration.unsubscribe();
    for (const timer of timers) clearTimeout(timer.handle);
  }

  add(entry: LoopEntry): void {
    this.scheduler.add(entry);
    this.subscribeEvent(entry);
  }

  remove(id: string): void {
    this.scheduler.remove(id);
    this.unsubscribeEvent(id);
  }

  private owns(registration: EventRegistration): boolean {
    return this.eventSubscriptions.get(registration.entry.id) === registration;
  }

  private currentActivation(registration: EventRegistration): LoopEntry | undefined {
    if (!this.owns(registration)) return undefined;
    const current = this.store.get(registration.entry.id);
    if (current?.status !== "active" || current.orchestration || current.workflow?.waitingMonitor
      || isTerminalWorkflowRun(current.workflow) || !sameLoopActivation(current, registration.entry)) return undefined;
    return current;
  }

  private unsubscribeEvent(id: string): void {
    const registration = this.eventSubscriptions.get(id);
    const timer = this.hybridTimers.get(id);
    this.eventSubscriptions.delete(id);
    this.hybridTimers.delete(id);
    this.lastFireTime.delete(id);
    registration?.unsubscribe();
    if (timer) clearTimeout(timer.handle);
  }

  private subscribeEvent(sourceEntry: LoopEntry): void {
    const entry = structuredClone(sourceEntry);
    const previous = this.eventSubscriptions.get(entry.id);
    if (entry.status !== "active" || entry.orchestration || entry.workflow?.waitingMonitor
      || isTerminalWorkflowRun(entry.workflow) || (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid")) {
      if (previous) this.unsubscribeEvent(entry.id);
      return;
    }
    if (previous && sameLoopActivation(entry, previous.entry) && entry.expiresAt === previous.entry.expiresAt) return;
    if (previous) this.unsubscribeEvent(entry.id);

    const event = entry.trigger.type === "hybrid" ? entry.trigger.event : entry.trigger;
    const registration: EventRegistration = { entry, unsubscribe: () => {} };
    this.eventSubscriptions.set(entry.id, registration);
    registration.unsubscribe = this.pi.events.on(event.source, (data: unknown) => {
      if (!this.currentActivation(registration)) return;
      if (!this.matchesFilter(data, event.filter) || !this.currentActivation(registration)) return;
      if (entry.trigger.type === "hybrid") this.handleHybridFire(registration);
      else this.fireLoop(registration);
    });
  }

  private handleHybridFire(registration: EventRegistration): void {
    if (!this.currentActivation(registration)) return;
    const { entry } = registration;
    const now = Date.now();
    const reservation = this.lastFireTime.get(entry.id);
    const last = reservation?.registration === registration ? reservation.at : 0;
    const debounceMs = entry.trigger.type === "hybrid" ? entry.trigger.debounceMs : 0;
    const existing = this.hybridTimers.get(entry.id);
    if (existing?.registration === registration) {
      this.hybridTimers.delete(entry.id);
      clearTimeout(existing.handle);
    }

    const remaining = debounceMs - (now - last);
    if (remaining <= 0) {
      this.fireLoop(registration);
      return;
    }

    const timer: HybridTimer = {
      registration,
      handle: setTimeout(() => {
        if (!this.owns(registration) || this.hybridTimers.get(entry.id) !== timer) return;
        this.hybridTimers.delete(entry.id);
        this.fireLoop(registration);
      }, remaining),
    };
    this.hybridTimers.set(entry.id, timer);
  }

  private retire(entry: LoopEntry, registration: EventRegistration): void {
    if (!this.currentActivation(registration)) return;
    if (entry.workflow || entry.taskBacklog) this.store.pause(entry.id, "controller_limit", "trigger fire cap reached");
    else this.store.delete(entry.id);
    if (this.owns(registration)) this.remove(entry.id);
  }

  private fireLoop(registration: EventRegistration): void {
    const current = this.currentActivation(registration);
    if (!current) return;
    const { entry } = registration;
    const now = Date.now();
    if (now >= current.expiresAt) {
      const lifetime = structuredClone(current);
      const expired = this.scheduler.expire(lifetime, now);
      if (!expired || !this.owns(registration)) return;
      const fresh = this.store.get(entry.id);
      if (!fresh || (sameLoopActivation(fresh, entry) && fresh.expiresAt === lifetime.expiresAt)) this.remove(entry.id);
      return;
    }

    // Reserve before dispatch to fence synchronous source re-entry. A denial
    // can restore only its own reservation, not a reentrant replacement's.
    const previousFireTime = this.lastFireTime.get(entry.id);
    const reservation: DebounceReservation = { registration, at: now };
    this.lastFireTime.set(entry.id, reservation);
    const accepted = this.onFire(structuredClone(current), "event") !== false;
    if (!this.owns(registration)) return;
    if (!accepted) {
      if (this.lastFireTime.get(entry.id) === reservation) {
        if (previousFireTime === undefined) this.lastFireTime.delete(entry.id);
        else this.lastFireTime.set(entry.id, previousFireTime);
      }
      return;
    }

    const fresh = this.store.get(entry.id);
    if (!fresh) {
      if (this.owns(registration)) this.remove(entry.id);
      return;
    }
    // Store-owned cap settlement may already have paused this activation.
    // Release only its listener, without repeating settlement or touching a replacement.
    if (fresh.status === "paused" && sameLoopActivation(fresh, entry) && atMaxFires(fresh)) {
      if (this.owns(registration)) this.remove(entry.id);
      return;
    }
    if (!this.currentActivation(registration)) return;
    if (!fresh.recurring || atMaxFires(fresh)) this.retire(fresh, registration);
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
