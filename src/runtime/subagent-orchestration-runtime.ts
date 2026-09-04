import { randomUUID } from "node:crypto";
import { getOrchestrationCounts } from "../orchestration-reducer.js";
import { RpcError, type RpcEventBus } from "../rpc/cross-extension-rpc.js";
import type { LoopStore } from "../store.js";
import type {
  LoopEntry,
  LoopExpiryDisposition,
  OrchestrationActor,
  OrchestrationDispatch,
  OrchestrationPendingWake,
  OrchestrationState,
  OrchestrationUsage,
  OrchestrationWorkItem,
} from "../types.js";
import type { LoopScope } from "./scope.js";

const SPAWN_RPC = "subagents:rpc:spawn";
const STOP_RPC = "subagents:rpc:stop";
const CONSUME_RPC = "subagents:rpc:consume";
const SPAWN_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 1_000;
const EARLY_EVENT_TTL_MS = 30_000;
const MAX_EARLY_EVENTS = 64;
const OWNER_RENEW_WINDOW_MS = 60_000;

interface LifecycleEvent {
  kind: "started" | "completed" | "failed";
  id: string;
  result?: string;
  error?: string;
  status?: string;
  toolUses?: number;
  durationMs?: number;
  tokens?: { input: number; output: number; total: number };
}

interface EarlyLifecycleEvent {
  event: LifecycleEvent;
  expiresAt: number;
}

export interface SubagentOrchestrationRuntimeOptions {
  events: RpcEventBus;
  getStore: () => LoopStore;
  getScope: () => LoopScope;
  getPiLoopEnv?: () => string | undefined;
  getActor: () => OrchestrationActor | undefined;
  getGeneration: () => number;
  rpcCall: (channel: string, params?: Record<string, unknown>, timeoutMs?: number) => Promise<unknown>;
  emitWake: (entry: LoopEntry, wake: OrchestrationPendingWake) => void;
  onExpired?: (entry: LoopEntry, disposition: LoopExpiryDisposition) => void;
  updateWidget: () => void;
  now?: () => number;
  scheduleReconcile?: (fn: () => void) => void;
  isContextCurrent?: () => boolean;
  debug?: (...args: unknown[]) => void;
}

export interface SubagentOrchestrationRuntime {
  pump(): Promise<void>;
  recover(): Promise<void>;
  shutdown(): Promise<void>;
  cancel(id: string, action: "pause" | "delete"): Promise<boolean>;
  acknowledgeWake(id: string, sequence: number): boolean;
  dispose(): void;
}

function expected(state: OrchestrationState) {
  return {
    revision: state.revision,
    ownerRuntimeId: state.owner.runtimeId,
    generation: state.owner.generation,
  };
}

function currentDispatch(item: OrchestrationWorkItem): OrchestrationDispatch | undefined {
  const dispatch = item.dispatches.at(-1);
  return dispatch && (dispatch.status === "spawning" || dispatch.status === "queued" || dispatch.status === "running")
    ? dispatch
    : undefined;
}

function normalizeLifecycle(kind: LifecycleEvent["kind"], raw: unknown): LifecycleEvent | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const data = raw as Record<string, unknown>;
  if (typeof data.id !== "string" || data.id.length === 0) return undefined;
  const tokens = data.tokens;
  const normalizedTokens = tokens && typeof tokens === "object"
    && Number.isFinite((tokens as Record<string, unknown>).input)
    && Number.isFinite((tokens as Record<string, unknown>).output)
    && Number.isFinite((tokens as Record<string, unknown>).total)
    ? {
        input: Number((tokens as Record<string, unknown>).input),
        output: Number((tokens as Record<string, unknown>).output),
        total: Number((tokens as Record<string, unknown>).total),
      }
    : undefined;
  return {
    kind,
    id: data.id,
    result: typeof data.result === "string" ? data.result : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    status: typeof data.status === "string" ? data.status : undefined,
    toolUses: Number.isFinite(data.toolUses) ? Number(data.toolUses) : undefined,
    durationMs: Number.isFinite(data.durationMs) ? Number(data.durationMs) : undefined,
    tokens: normalizedTokens,
  };
}

function buildWorkerPrompt(entry: LoopEntry, item: OrchestrationWorkItem): string {
  return [
    `Orchestration goal: ${entry.orchestration?.goal ?? entry.prompt}`,
    `Work item ${item.id}: ${item.prompt}`,
    "Complete only this bounded work item. Do not call TaskCreate, TaskUpdate, LoopUpdate, LoopDelete, WorkflowClaim, WorkflowRevise, or WorkflowTransition.",
    "Return concise evidence and any exact file paths or commands needed by the parent controller.",
  ].join("\n\n");
}

function asSpawnReply(value: unknown): { id: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const id = (value as Record<string, unknown>).id;
  return typeof id === "string" && id.length > 0 ? { id } : undefined;
}

export function createSubagentOrchestrationRuntime(
  options: SubagentOrchestrationRuntimeOptions,
): SubagentOrchestrationRuntime {
  const {
    events,
    getStore,
    getScope,
    getActor,
    getGeneration,
    rpcCall,
    emitWake,
    updateWidget,
    debug,
  } = options;
  const now = options.now ?? Date.now;
  const scheduleReconcile = options.scheduleReconcile ?? queueMicrotask;
  const isContextCurrent = options.isContextCurrent ?? (() => true);
  const getPiLoopEnv = options.getPiLoopEnv ?? (() => undefined);
  const onExpired = options.onExpired ?? (() => {});
  const earlyEvents = new Map<string, EarlyLifecycleEvent>();
  const wakeQueued = new Set<string>();
  const consumeInFlight = new Set<string>();
  const dispatchesInFlight = new Map<string, Set<Promise<void>>>();
  let active = true;
  let reconcileQueued = false;
  let pumpPromise: Promise<void> | undefined;

  function actorOwns(state: OrchestrationState): boolean {
    const actor = getActor();
    return !!actor
      && actor.sessionId === state.owner.sessionId
      && actor.runtimeId === state.owner.runtimeId
      && actor.generation === state.owner.generation
      && actor.generation === getGeneration();
  }

  function pruneEarlyEvents(): void {
    const timestamp = now();
    for (const [id, item] of earlyEvents) {
      if (item.expiresAt <= timestamp) earlyEvents.delete(id);
    }
    while (earlyEvents.size > MAX_EARLY_EVENTS) {
      const oldest = earlyEvents.keys().next().value as string | undefined;
      if (!oldest) break;
      earlyEvents.delete(oldest);
    }
  }

  function rememberEarly(event: LifecycleEvent): void {
    pruneEarlyEvents();
    earlyEvents.set(event.id, { event, expiresAt: now() + EARLY_EVENT_TTL_MS });
    pruneEarlyEvents();
  }

  function findActiveAgent(agentId: string): { entry: LoopEntry; state: OrchestrationState } | undefined {
    for (const entry of getStore().list()) {
      const state = entry.orchestration;
      if (!state || !actorOwns(state)) continue;
      if (state.work.some((item) => currentDispatch(item)?.agentId === agentId)) return { entry, state };
    }
    return undefined;
  }

  function findSettledAgent(agentId: string): { entry: LoopEntry; dispatch: OrchestrationDispatch } | undefined {
    for (const entry of getStore().list()) {
      const state = entry.orchestration;
      if (!state || !actorOwns(state)) continue;
      const dispatch = state.work.flatMap((item) => item.dispatches).find((candidate) => candidate.agentId === agentId && candidate.settledAt !== undefined);
      if (dispatch) return { entry, dispatch };
    }
    return undefined;
  }

  function trackDispatch(loopId: string, promise: Promise<void>): Promise<void> {
    const pending = dispatchesInFlight.get(loopId) ?? new Set<Promise<void>>();
    pending.add(promise);
    dispatchesInFlight.set(loopId, pending);
    const remove = () => {
      pending.delete(promise);
      if (pending.size === 0) dispatchesInFlight.delete(loopId);
    };
    void promise.then(remove, remove);
    return promise;
  }

  async function drainDispatches(loopId?: string): Promise<void> {
    const pending = loopId
      ? [...(dispatchesInFlight.get(loopId) ?? [])]
      : [...dispatchesInFlight.values()].flatMap((items) => [...items]);
    await Promise.allSettled(pending);
  }

  function schedulePump(): void {
    if (!active || reconcileQueued) return;
    reconcileQueued = true;
    scheduleReconcile(() => {
      reconcileQueued = false;
      void pump().catch((error) => debug?.("orchestration reconcile failed", error));
    });
  }

  function recordConsume(loopId: string, agentId: string, consumed: boolean): void {
    if (!isContextCurrent()) return;
    const entry = getStore().get(loopId);
    const state = entry?.orchestration;
    if (!state || !actorOwns(state)) return;
    getStore().mutateOrchestration(loopId, {
      type: "consume_recorded",
      at: now(),
      expected: expected(state),
      agentId,
      consumed,
    });
  }

  function canConsume(loopId: string, agentId: string): boolean {
    const state = getStore().get(loopId)?.orchestration;
    if (!state || !actorOwns(state)) return false;
    const dispatch = state.work.flatMap((item) => item.dispatches).find((candidate) => candidate.agentId === agentId);
    return dispatch?.consumeStatus === "pending" && dispatch.consumeAttempts < 3;
  }

  function consumeSettled(loopId: string, agentId: string): void {
    if (consumeInFlight.has(agentId) || !canConsume(loopId, agentId)) return;
    consumeInFlight.add(agentId);
    let call: Promise<unknown>;
    try {
      call = rpcCall(CONSUME_RPC, { agentId }, STOP_TIMEOUT_MS);
    } catch {
      consumeInFlight.delete(agentId);
      recordConsume(loopId, agentId, false);
      return;
    }
    void call.then(
      () => recordConsume(loopId, agentId, true),
      () => recordConsume(loopId, agentId, false),
    ).finally(() => {
      consumeInFlight.delete(agentId);
    });
  }

  function handleLifecycle(event: LifecycleEvent, rememberUnknown = true): boolean {
    if (!active || !isContextCurrent()) return false;
    const match = findActiveAgent(event.id);
    if (match && now() >= match.entry.expiresAt) {
      void retireExpiredOrchestration(match.entry, now());
      return true;
    }
    if (!match) {
      const settled = event.kind === "started" ? undefined : findSettledAgent(event.id);
      if (settled) {
        if (settled.dispatch.consumeStatus === "pending" && settled.dispatch.consumeAttempts < 3) {
          consumeSettled(settled.entry.id, event.id);
        }
        return true;
      }
      if (rememberUnknown) rememberEarly(event);
      return false;
    }
    const state = match.entry.orchestration!;
    if (event.kind === "started") {
      const result = getStore().mutateOrchestration(match.entry.id, {
        type: "dispatch_started",
        at: now(),
        expected: expected(state),
        agentId: event.id,
      });
      if (result.applied) {
        updateWidget();
        schedulePump();
      }
      return result.applied;
    }

    const usage: OrchestrationUsage = {
      toolUses: event.toolUses,
      durationMs: event.durationMs,
      tokens: event.tokens,
    };
    const result = getStore().mutateOrchestration(match.entry.id, {
      type: "dispatch_settled",
      at: now(),
      expected: expected(state),
      agentId: event.id,
      outcome: event.kind === "completed" ? "completed" : "failed",
      result: event.result,
      error: event.error ?? (event.kind === "failed" ? event.status : undefined),
      usage,
    });
    if (!result.applied) return false;
    updateWidget();
    schedulePump();
    return true;
  }

  const unsubStarted = events.on("subagents:started", (raw) => {
    const event = normalizeLifecycle("started", raw);
    if (event) handleLifecycle(event);
  });
  const unsubCompleted = events.on("subagents:completed", (raw) => {
    const event = normalizeLifecycle("completed", raw);
    if (event) handleLifecycle(event);
  });
  const unsubFailed = events.on("subagents:failed", (raw) => {
    const event = normalizeLifecycle("failed", raw);
    if (event) handleLifecycle(event);
  });

  function replayEarly(agentId: string): void {
    const early = earlyEvents.get(agentId);
    if (!early || early.expiresAt <= now()) {
      earlyEvents.delete(agentId);
      return;
    }
    earlyEvents.delete(agentId);
    handleLifecycle(early.event, false);
  }

  function isAgentBound(agentId: string): boolean {
    return getStore().list().some((entry) => entry.orchestration?.work.some((item) =>
      item.dispatches.some((dispatch) => dispatch.agentId === agentId)));
  }

  async function stopUnboundSpawn(agentId: string): Promise<void> {
    if (isAgentBound(agentId)) return;
    try {
      await rpcCall(STOP_RPC, { agentId }, STOP_TIMEOUT_MS);
      if (isAgentBound(agentId)) return;
      await rpcCall(CONSUME_RPC, { agentId }, STOP_TIMEOUT_MS);
    } catch (error) {
      debug?.("orchestration orphan spawn cleanup failed", { agentId, error });
    }
  }

  async function dispatchWork(entry: LoopEntry, item: OrchestrationWorkItem): Promise<void> {
    if (!isContextCurrent()) return;
    if (now() >= entry.expiresAt && await retireExpiredOrchestration(entry, now())) return;
    const state = entry.orchestration;
    if (!state || !actorOwns(state) || state.status !== "active") return;
    const dispatchId = randomUUID();
    const requested = getStore().mutateOrchestration(entry.id, {
      type: "dispatch_requested",
      at: now(),
      expected: expected(state),
      workId: item.id,
      dispatchId,
    });
    if (!requested.applied) return;

    const reservedEntry = requested.entry;
    const reserved = reservedEntry?.orchestration;
    const reservedItem = reserved?.work.find((candidate) => candidate.id === item.id);
    if (!reservedEntry || !reserved || !reservedItem) return;
    try {
      const rawReply = await rpcCall(SPAWN_RPC, {
        type: item.agentType ?? "general-purpose",
        prompt: buildWorkerPrompt(reservedEntry, item),
        options: {
          description: `Orchestration #${entry.id} work #${item.id}`,
          model: reserved.model,
          maxTurns: reserved.maxTurns,
          isBackground: true,
          isolated: true,
          inheritContext: false,
        },
      }, SPAWN_TIMEOUT_MS);
      const reply = asSpawnReply(rawReply);
      if (!reply) throw new Error("Invalid subagent spawn reply");
      if (!isContextCurrent()) {
        await stopUnboundSpawn(reply.id);
        return;
      }
      const freshEntry = getStore().get(entry.id);
      if (!freshEntry || (now() >= freshEntry.expiresAt && await retireExpiredOrchestration(freshEntry, now()))) {
        await stopUnboundSpawn(reply.id);
        return;
      }
      const fresh = freshEntry.orchestration;
      if (!fresh || !actorOwns(fresh)) {
        await stopUnboundSpawn(reply.id);
        return;
      }
      const bound = getStore().mutateOrchestration(entry.id, {
        type: "dispatch_bound",
        at: now(),
        expected: expected(fresh),
        workId: item.id,
        dispatchId,
        agentId: reply.id,
      });
      if (bound.applied) {
        replayEarly(reply.id);
      } else {
        const latest = getStore().get(entry.id)?.orchestration;
        if (latest && actorOwns(latest)) {
          getStore().mutateOrchestration(entry.id, {
            type: "dispatch_uncertain",
            at: now(),
            expected: expected(latest),
            workId: item.id,
            dispatchId,
            error: `Spawn reply could not be bound safely: ${bound.reason ?? "state changed"}.`,
          });
        }
        await stopUnboundSpawn(reply.id);
      }
    } catch (error) {
      if (!isContextCurrent()) return;
      const freshEntry = getStore().get(entry.id);
      if (!freshEntry || (now() >= freshEntry.expiresAt && await retireExpiredOrchestration(freshEntry, now()))) return;
      const fresh = freshEntry.orchestration;
      if (!fresh || !actorOwns(fresh)) return;
      const message = error instanceof Error ? error.message : String(error);
      const uncertain = error instanceof RpcError && error.timedOut;
      getStore().mutateOrchestration(entry.id, {
        type: uncertain ? "dispatch_uncertain" : "dispatch_spawn_failed",
        at: now(),
        expected: expected(fresh),
        workId: item.id,
        dispatchId,
        error: message,
      });
    }
  }

  function retryPendingConsumes(entry: LoopEntry): void {
    const state = entry.orchestration;
    if (!state || !actorOwns(state)) return;
    for (const dispatch of state.work.flatMap((item) => item.dispatches)) {
      if (dispatch.agentId && dispatch.consumeStatus === "pending" && dispatch.consumeAttempts < 3) {
        consumeSettled(entry.id, dispatch.agentId);
      }
    }
  }

  function providerOwnsTerminalWake(state: OrchestrationState): boolean {
    const counts = getOrchestrationCounts(state);
    if (counts.pending > 0 || counts.active > 0 || counts.uncertain > 0) return false;
    return state.work.length > 0 && state.work.every((item) => {
      const dispatch = item.dispatches.at(-1);
      return (item.status === "completed" || item.status === "failed")
        && dispatch?.consumeStatus === "provider_owned";
    });
  }

  async function retireExpiredOrchestration(entry: LoopEntry, timestamp: number): Promise<boolean> {
    const current = getStore().get(entry.id);
    const state = current?.orchestration;
    if (!current || !state || timestamp < current.expiresAt) return false;
    const agentIds = state.work.flatMap((item) => {
      const agentId = currentDispatch(item)?.agentId;
      return agentId ? [agentId] : [];
    });
    if (state.status !== "cancelled") {
      getStore().mutateOrchestration(current.id, {
        type: "cancelled",
        at: timestamp,
        expected: expected(state),
      });
    }
    const expired = getStore().expireEntry(current.id, timestamp);
    if (expired) onExpired(expired.entry, expired.disposition);
    for (const key of wakeQueued) {
      if (key.startsWith(`${current.id}:`)) wakeQueued.delete(key);
    }
    await Promise.all(agentIds.map((agentId) => stopCancelledAgent(current.id, agentId)));
    updateWidget();
    return true;
  }

  function emitPendingWakes(): void {
    for (const entry of getStore().list()) {
      if (now() >= entry.expiresAt) {
        void retireExpiredOrchestration(entry, now());
        continue;
      }
      const state = entry.orchestration;
      const wake = state?.pendingWake;
      if (!state || !wake || !actorOwns(state)) continue;
      if (getOrchestrationCounts(state).active > 0) continue;
      const key = `${entry.id}:${wake.sequence}`;
      if (wakeQueued.has(key)) continue;
      if (state.status === "completed" || (state.status === "needs_attention" && getOrchestrationCounts(state).active === 0)) {
        getStore().pause(entry.id, "orchestration_settlement", `orchestration ${state.status}`);
      }
      if (providerOwnsTerminalWake(state)) {
        acknowledgeWake(entry.id, wake.sequence);
        continue;
      }
      wakeQueued.add(key);
      emitWake(getStore().get(entry.id) ?? entry, wake);
    }
  }

  async function runPump(): Promise<void> {
    if (!active || !isContextCurrent() || getScope() !== "session" || getPiLoopEnv()) return;
    const actor = getActor();
    if (!actor || actor.generation !== getGeneration()) return;

    for (const listed of getStore().list()) {
      let entry = listed;
      let state = entry.orchestration;
      if (!state) continue;
      if (now() >= entry.expiresAt && await retireExpiredOrchestration(entry, now())) continue;
      const recoveringWake = entry.status === "paused" && state.pendingWake !== undefined
        && getOrchestrationCounts(state).active === 0;
      if (entry.status !== "active" && !recoveringWake) continue;
      if (!actorOwns(state)) {
        const adopted = getStore().mutateOrchestration(entry.id, {
          type: "owner_adopted",
          at: now(),
          expectedRevision: state.revision,
          owner: actor,
        });
        if (!adopted.applied) continue;
        entry = adopted.entry!;
        state = entry.orchestration!;
      } else if (state.owner.leaseExpiresAt - now() <= OWNER_RENEW_WINDOW_MS) {
        const renewed = getStore().mutateOrchestration(entry.id, {
          type: "owner_renewed",
          at: now(),
          expected: expected(state),
        });
        if (!renewed.applied) continue;
        entry = renewed.entry!;
        state = entry.orchestration!;
      }
      retryPendingConsumes(entry);
      if (entry.status !== "active" || state.status !== "active") continue;

      while (true) {
        const freshEntry = getStore().get(entry.id);
        const fresh = freshEntry?.orchestration;
        if (!freshEntry || !fresh || freshEntry.status !== "active" || !actorOwns(fresh) || fresh.status !== "active") break;
        if (getOrchestrationCounts(fresh).active >= fresh.concurrency) break;
        const pending = fresh.work.find((item) => item.status === "pending");
        if (!pending) break;
        await trackDispatch(entry.id, dispatchWork(freshEntry, pending));
      }
    }
    if (active) emitPendingWakes();
    updateWidget();
  }

  function pump(): Promise<void> {
    if (pumpPromise) return pumpPromise;
    pumpPromise = runPump().finally(() => {
      pumpPromise = undefined;
    });
    return pumpPromise;
  }

  async function stopDispatch(loopId: string, workId: string, dispatch: OrchestrationDispatch): Promise<void> {
    if (!dispatch.agentId) return;
    let stopped = false;
    let error = "Worker stop could not be confirmed.";
    try {
      await rpcCall(STOP_RPC, { agentId: dispatch.agentId }, STOP_TIMEOUT_MS);
      stopped = true;
      error = "Worker stopped during session teardown.";
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
    }
    const state = getStore().get(loopId)?.orchestration;
    if (!state) return;
    const settled = getStore().mutateOrchestration(loopId, {
      type: stopped ? "dispatch_interrupted" : "dispatch_uncertain",
      at: now(),
      expected: expected(state),
      workId,
      dispatchId: dispatch.dispatchId,
      error,
    });
    if (stopped && settled.applied) consumeSettled(loopId, dispatch.agentId);
  }

  async function shutdown(): Promise<void> {
    active = false;
    const stops: Promise<void>[] = [];
    for (const entry of getStore().list()) {
      const state = entry.orchestration;
      if (!state || state.owner.runtimeId !== getActor()?.runtimeId) continue;
      for (const item of state.work) {
        const dispatch = currentDispatch(item);
        if (dispatch?.agentId) stops.push(stopDispatch(entry.id, item.id, { ...dispatch }));
        else if (dispatch) {
          const fresh = getStore().get(entry.id)?.orchestration;
          if (fresh) {
            getStore().mutateOrchestration(entry.id, {
              type: "dispatch_uncertain",
              at: now(),
              expected: expected(fresh),
              workId: item.id,
              dispatchId: dispatch.dispatchId,
              error: "Session ended before the spawn reply identified the worker.",
            });
          }
        }
      }
    }
    await Promise.all(stops);
    await drainDispatches();
    wakeQueued.clear();
    updateWidget();
  }

  async function stopCancelledAgent(loopId: string, agentId: string): Promise<void> {
    try {
      await rpcCall(STOP_RPC, { agentId }, STOP_TIMEOUT_MS);
      consumeSettled(loopId, agentId);
    } catch {
      // The controller is already fenced as cancelled; stop is best effort.
    }
  }

  async function cancel(id: string, action: "pause" | "delete"): Promise<boolean> {
    const entry = getStore().get(id);
    const state = entry?.orchestration;
    if (!entry || !state) return false;
    const agentIds: string[] = [];
    for (const item of state.work) {
      const agentId = currentDispatch(item)?.agentId;
      if (agentId) agentIds.push(agentId);
    }
    const result = getStore().mutateOrchestration(id, {
      type: "cancelled",
      at: now(),
      expected: expected(state),
    });
    if (!result.applied) return false;
    await Promise.all(agentIds.map((agentId) => stopCancelledAgent(id, agentId)));
    await drainDispatches(id);
    if (action === "delete") getStore().delete(id);
    else getStore().pause(id, "administrative", "orchestration cancelled by operator");
    for (const key of wakeQueued) {
      if (key.startsWith(`${id}:`)) wakeQueued.delete(key);
    }
    updateWidget();
    return true;
  }

  function acknowledgeWake(id: string, sequence: number): boolean {
    const entry = getStore().get(id);
    const state = entry?.orchestration;
    if (!state || !actorOwns(state)) return false;
    const result = getStore().mutateOrchestration(id, {
      type: "wake_acknowledged",
      at: now(),
      expected: expected(state),
      sequence,
    });
    if (result.applied) wakeQueued.delete(`${id}:${sequence}`);
    return result.applied;
  }

  async function recover(): Promise<void> {
    active = true;
    wakeQueued.clear();
    await pump();
  }

  return {
    pump,
    recover,
    shutdown,
    cancel,
    acknowledgeWake,
    dispose() {
      active = false;
      unsubStarted();
      unsubCompleted();
      unsubFailed();
      earlyEvents.clear();
      wakeQueued.clear();
      consumeInFlight.clear();
      dispatchesInFlight.clear();
    },
  };
}
