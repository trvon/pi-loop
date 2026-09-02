import type {
  OrchestrationActor,
  OrchestrationDefinitionInput,
  OrchestrationDispatch,
  OrchestrationState,
  OrchestrationUsage,
  OrchestrationWakeReason,
  OrchestrationWorkItem,
  OrchestrationWorkStatus,
} from "./types.js";

export const MAX_ORCHESTRATION_RESULT_CHARS = 8_192;
export const MAX_ORCHESTRATION_ERROR_CHARS = 2_048;
export const ORCHESTRATION_OWNER_LEASE_MS = 120_000;
export const MAX_ORCHESTRATION_WORK_ITEMS = 32;
export const MAX_ORCHESTRATION_CONCURRENCY = 8;
export const MAX_ORCHESTRATION_ATTEMPTS = 3;
export const MAX_ORCHESTRATION_INPUT_BYTES = 65_536;

const ORCHESTRATION_STATUSES = new Set(["active", "needs_attention", "completed", "cancelled"]);
const WORK_STATUSES = new Set(["pending", "active", "completed", "failed", "uncertain", "cancelled"]);
const DISPATCH_STATUSES = new Set(["spawning", "queued", "running", "completed", "failed", "interrupted", "stopped", "uncertain"]);
const CONSUME_STATUSES = new Set(["not_applicable", "provider_owned", "pending", "consumed", "unavailable"]);
const WAKE_REASONS = new Set(["completed", "failed", "uncertain", "recovery"]);

export function validateOrchestrationDefinition(input: OrchestrationDefinitionInput): string | undefined {
  if (!input.goal.trim()) return "goal must not be empty";
  if (!Array.isArray(input.work) || input.work.length < 1 || input.work.length > MAX_ORCHESTRATION_WORK_ITEMS) {
    return `work must contain 1-${MAX_ORCHESTRATION_WORK_ITEMS} items`;
  }
  const concurrency = input.concurrency ?? 3;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_ORCHESTRATION_CONCURRENCY) return "invalid concurrency";
  const attempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ORCHESTRATION_ATTEMPTS) return "invalid maxAttempts";
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100)) return "invalid maxTurns";
  if (input.work.some((item) => !item.prompt.trim())) return "work prompts must not be empty";
  if (Buffer.byteLength(JSON.stringify(input), "utf8") > MAX_ORCHESTRATION_INPUT_BYTES) return "serialized input exceeds limit";
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function validatePersistedOrchestration(value: unknown): OrchestrationState {
  if (!isRecord(value) || value.version !== 1) throw new Error("Malformed orchestration state: unsupported version");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new Error("Malformed orchestration state: invalid revision");
  if (!ORCHESTRATION_STATUSES.has(String(value.status))) throw new Error("Malformed orchestration state: invalid status");
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new Error("Malformed orchestration state: invalid goal");
  if (!Number.isInteger(value.concurrency) || Number(value.concurrency) < 1 || Number(value.concurrency) > MAX_ORCHESTRATION_CONCURRENCY) throw new Error("Malformed orchestration state: invalid concurrency");
  if (!Number.isInteger(value.maxAttempts) || Number(value.maxAttempts) < 1 || Number(value.maxAttempts) > MAX_ORCHESTRATION_ATTEMPTS) throw new Error("Malformed orchestration state: invalid maxAttempts");
  if (value.model !== undefined && typeof value.model !== "string") throw new Error("Malformed orchestration state: invalid model");
  if (value.maxTurns !== undefined && (!Number.isInteger(value.maxTurns) || Number(value.maxTurns) < 1 || Number(value.maxTurns) > 100)) throw new Error("Malformed orchestration state: invalid maxTurns");
  if (!isRecord(value.owner) || typeof value.owner.sessionId !== "string" || typeof value.owner.runtimeId !== "string" || !Number.isInteger(value.owner.generation) || Number(value.owner.generation) < 0 || !Number.isFinite(value.owner.leaseExpiresAt)) {
    throw new Error("Malformed orchestration state: invalid owner");
  }
  if (!Array.isArray(value.work) || value.work.length < 1 || value.work.length > MAX_ORCHESTRATION_WORK_ITEMS) throw new Error("Malformed orchestration state: invalid work list");
  const ids = new Set<string>();
  let allWorkCompleted = true;
  for (const rawItem of value.work) {
    if (!isRecord(rawItem) || typeof rawItem.id !== "string" || !rawItem.id || ids.has(rawItem.id) || typeof rawItem.prompt !== "string" || !rawItem.prompt.trim() || (rawItem.agentType !== undefined && (typeof rawItem.agentType !== "string" || !rawItem.agentType)) || !WORK_STATUSES.has(String(rawItem.status)) || !Number.isInteger(rawItem.attemptCount) || !Array.isArray(rawItem.dispatches)) {
      throw new Error("Malformed orchestration state: invalid work item");
    }
    ids.add(rawItem.id);
    if (rawItem.status !== "completed") allWorkCompleted = false;
    if (Number(rawItem.attemptCount) < 0 || Number(rawItem.attemptCount) > Number(value.maxAttempts) || rawItem.dispatches.length !== Number(rawItem.attemptCount)) throw new Error("Malformed orchestration state: invalid attempt count");
    for (const [dispatchIndex, rawDispatch] of rawItem.dispatches.entries()) {
      if (!isRecord(rawDispatch) || typeof rawDispatch.dispatchId !== "string" || rawDispatch.attempt !== dispatchIndex + 1 || typeof rawDispatch.ownerRuntimeId !== "string" || !Number.isInteger(rawDispatch.ownerGeneration) || !Number.isFinite(rawDispatch.requestedAt) || !DISPATCH_STATUSES.has(String(rawDispatch.status)) || !CONSUME_STATUSES.has(String(rawDispatch.consumeStatus)) || !Number.isInteger(rawDispatch.consumeAttempts) || Number(rawDispatch.consumeAttempts) < 0 || Number(rawDispatch.consumeAttempts) > 3) {
        throw new Error("Malformed orchestration state: invalid dispatch");
      }
      if (rawDispatch.agentId !== undefined && (typeof rawDispatch.agentId !== "string" || !rawDispatch.agentId)) throw new Error("Malformed orchestration state: invalid agent id");
      for (const field of ["boundAt", "startedAt", "settledAt"] as const) {
        if (rawDispatch[field] !== undefined && !Number.isFinite(rawDispatch[field])) throw new Error(`Malformed orchestration state: invalid ${field}`);
      }
      if (rawDispatch.result !== undefined && typeof rawDispatch.result !== "string") throw new Error("Malformed orchestration state: invalid result");
      if (typeof rawDispatch.result === "string" && rawDispatch.result.length > MAX_ORCHESTRATION_RESULT_CHARS) throw new Error("Malformed orchestration state: oversized result");
      if (rawDispatch.error !== undefined && typeof rawDispatch.error !== "string") throw new Error("Malformed orchestration state: invalid error");
      if (typeof rawDispatch.error === "string" && rawDispatch.error.length > MAX_ORCHESTRATION_ERROR_CHARS) throw new Error("Malformed orchestration state: oversized error");
      if (rawDispatch.usage !== undefined) {
        if (!isRecord(rawDispatch.usage)) throw new Error("Malformed orchestration state: invalid usage");
        for (const field of ["toolUses", "durationMs"] as const) {
          if (rawDispatch.usage[field] !== undefined && (!Number.isFinite(rawDispatch.usage[field]) || Number(rawDispatch.usage[field]) < 0)) throw new Error(`Malformed orchestration state: invalid usage ${field}`);
        }
        if (rawDispatch.usage.tokens !== undefined) {
          if (!isRecord(rawDispatch.usage.tokens) || !Number.isFinite(rawDispatch.usage.tokens.input) || !Number.isFinite(rawDispatch.usage.tokens.output) || !Number.isFinite(rawDispatch.usage.tokens.total)) throw new Error("Malformed orchestration state: invalid usage tokens");
        }
      }
    }
    const lastDispatch = rawItem.dispatches.at(-1);
    const shouldBeActive = rawItem.status === "active";
    const hasActiveDispatch = isRecord(lastDispatch) && (lastDispatch.status === "spawning" || lastDispatch.status === "queued" || lastDispatch.status === "running");
    if (shouldBeActive !== hasActiveDispatch) throw new Error("Malformed orchestration state: work/dispatch status mismatch");
  }
  if (value.status === "completed" && !allWorkCompleted) throw new Error("Malformed orchestration state: incomplete completed batch");
  if (!Number.isInteger(value.nextWakeSequence) || Number(value.nextWakeSequence) < 0 || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) throw new Error("Malformed orchestration state: invalid sequence or timestamp");
  if (value.pendingWake !== undefined && (!isRecord(value.pendingWake) || !Number.isInteger(value.pendingWake.sequence) || Number(value.pendingWake.sequence) < 1 || Number(value.pendingWake.sequence) > Number(value.nextWakeSequence) || !WAKE_REASONS.has(String(value.pendingWake.reason)) || !Number.isFinite(value.pendingWake.createdAt))) {
    throw new Error("Malformed orchestration state: invalid pending wake");
  }
  // SAFETY: every persisted field and nested collection required by OrchestrationState is validated above.
  return value as unknown as OrchestrationState;
}

interface ExpectedOrchestration {
  revision: number;
  ownerRuntimeId: string;
  generation: number;
}

export type OrchestrationEvent =
  | { type: "owner_adopted"; at: number; expectedRevision: number; owner: OrchestrationActor }
  | { type: "owner_renewed"; at: number; expected: ExpectedOrchestration }
  | { type: "dispatch_requested"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string }
  | { type: "dispatch_bound"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string; agentId: string }
  | { type: "dispatch_started"; at: number; expected: ExpectedOrchestration; agentId: string }
  | { type: "dispatch_settled"; at: number; expected: ExpectedOrchestration; agentId: string; outcome: "completed" | "failed"; result?: string; error?: string; usage?: OrchestrationUsage }
  | { type: "dispatch_spawn_failed"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string; error: string }
  | { type: "dispatch_interrupted"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string; error: string }
  | { type: "dispatch_uncertain"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string; error: string }
  | { type: "consume_recorded"; at: number; expected: ExpectedOrchestration; agentId: string; consumed: boolean }
  | { type: "wake_acknowledged"; at: number; expected: ExpectedOrchestration; sequence: number }
  | { type: "cancelled"; at: number; expected: ExpectedOrchestration };

export interface OrchestrationReduceResult {
  applied: boolean;
  state: OrchestrationState;
  reason?: string;
}

function truncate(value: string | undefined, maxChars: number): string | undefined {
  return value === undefined ? undefined : value.slice(0, maxChars);
}

function cloneUsage(usage: OrchestrationUsage | undefined): OrchestrationUsage | undefined {
  if (!usage) return undefined;
  return { ...usage, tokens: usage.tokens ? { ...usage.tokens } : undefined };
}

function cloneState(state: OrchestrationState): OrchestrationState {
  return {
    ...state,
    owner: { ...state.owner },
    work: state.work.map((item) => ({
      ...item,
      dispatches: item.dispatches.map((dispatch) => ({
        ...dispatch,
        usage: cloneUsage(dispatch.usage),
      })),
    })),
    pendingWake: state.pendingWake ? { ...state.pendingWake } : undefined,
  };
}

function rejected(state: OrchestrationState, reason: string): OrchestrationReduceResult {
  return { applied: false, state, reason };
}

function applied(state: OrchestrationState, at: number): OrchestrationReduceResult {
  state.revision += 1;
  state.updatedAt = at;
  return { applied: true, state };
}

function matchesExpected(state: OrchestrationState, expected: ExpectedOrchestration): string | undefined {
  if (state.revision !== expected.revision) return "stale_revision";
  if (state.owner.runtimeId !== expected.ownerRuntimeId || state.owner.generation !== expected.generation) return "foreign_owner";
  return undefined;
}

function activeDispatch(item: OrchestrationWorkItem): OrchestrationDispatch | undefined {
  const dispatch = item.dispatches.at(-1);
  return dispatch && (dispatch.status === "spawning" || dispatch.status === "queued" || dispatch.status === "running")
    ? dispatch
    : undefined;
}

function findByAgent(state: OrchestrationState, agentId: string): { item: OrchestrationWorkItem; dispatch: OrchestrationDispatch } | undefined {
  for (const item of state.work) {
    const dispatch = activeDispatch(item);
    if (dispatch?.agentId === agentId) return { item, dispatch };
  }
  return undefined;
}

function setPendingWake(state: OrchestrationState, reason: OrchestrationWakeReason, at: number): void {
  if (state.pendingWake?.reason === reason) return;
  state.nextWakeSequence += 1;
  state.pendingWake = { reason, sequence: state.nextWakeSequence, createdAt: at };
}

function refreshControllerStatus(state: OrchestrationState, at: number): void {
  if (state.status === "cancelled") return;
  const hasActiveWork = state.work.some((item) => item.status === "active");
  if (state.work.some((item) => item.status === "uncertain")) {
    state.status = "needs_attention";
    if (!hasActiveWork) setPendingWake(state, "uncertain", at);
    return;
  }
  if (state.work.some((item) => item.status === "failed")) {
    state.status = "needs_attention";
    if (!hasActiveWork) setPendingWake(state, "failed", at);
    return;
  }
  if (state.work.every((item) => item.status === "completed")) {
    state.status = "completed";
    setPendingWake(state, "completed", at);
    return;
  }
  state.status = "active";
}

function settleFailure(item: OrchestrationWorkItem, state: OrchestrationState): void {
  item.status = item.attemptCount < state.maxAttempts ? "pending" : "failed";
}

export function createOrchestrationState(
  input: OrchestrationDefinitionInput,
  owner: OrchestrationActor,
  at: number,
): OrchestrationState {
  return {
    version: 1,
    revision: 1,
    status: "active",
    goal: input.goal,
    concurrency: input.concurrency ?? 3,
    maxAttempts: input.maxAttempts ?? 1,
    model: input.model,
    maxTurns: input.maxTurns,
    owner: { ...owner, leaseExpiresAt: at + ORCHESTRATION_OWNER_LEASE_MS },
    work: input.work.map((item, index) => ({
      id: String(index + 1),
      prompt: item.prompt,
      agentType: item.agentType,
      status: "pending",
      attemptCount: 0,
      dispatches: [],
    })),
    nextWakeSequence: 0,
    createdAt: at,
    updatedAt: at,
  };
}

export function getOrchestrationCounts(state: OrchestrationState): {
  pending: number;
  active: number;
  completed: number;
  failed: number;
  uncertain: number;
  cancelled: number;
} {
  const count = (status: OrchestrationWorkStatus) => state.work.filter((item) => item.status === status).length;
  return {
    pending: count("pending"),
    active: count("active"),
    completed: count("completed"),
    failed: count("failed"),
    uncertain: count("uncertain"),
    cancelled: count("cancelled"),
  };
}

export function applyOrchestrationEvent(
  state: OrchestrationState,
  event: OrchestrationEvent,
): OrchestrationReduceResult {
  if (event.type === "owner_adopted") {
    if (state.revision !== event.expectedRevision) return rejected(state, "stale_revision");
    const sameOwner = state.owner.sessionId === event.owner.sessionId && state.owner.runtimeId === event.owner.runtimeId;
    if (!sameOwner && state.owner.leaseExpiresAt > event.at) return rejected(state, "foreign_owner_active");
    const next = cloneState(state);
    if (!sameOwner) {
      for (const item of next.work) {
        const dispatch = activeDispatch(item);
        if (!dispatch) continue;
        dispatch.status = "uncertain";
        dispatch.error = "Controller ownership expired before worker status could be reconciled.";
        dispatch.settledAt = event.at;
        dispatch.consumeStatus = "unavailable";
        item.status = "uncertain";
      }
    }
    next.owner = { ...event.owner, leaseExpiresAt: event.at + ORCHESTRATION_OWNER_LEASE_MS };
    refreshControllerStatus(next, event.at);
    return applied(next, event.at);
  }

  const mismatch = matchesExpected(state, event.expected);
  if (mismatch) return rejected(state, mismatch);
  if (state.status === "cancelled" && event.type !== "consume_recorded") return rejected(state, "controller_cancelled");

  const next = cloneState(state);
  next.owner.leaseExpiresAt = event.at + ORCHESTRATION_OWNER_LEASE_MS;

  if (event.type === "owner_renewed") return applied(next, event.at);

  if (event.type === "dispatch_requested") {
    const item = next.work.find((candidate) => candidate.id === event.workId);
    if (!item) return rejected(state, "work_not_found");
    if (item.status !== "pending") return rejected(state, "work_not_pending");
    if (getOrchestrationCounts(next).active >= next.concurrency) return rejected(state, "capacity_exhausted");
    if (item.attemptCount >= next.maxAttempts) return rejected(state, "attempts_exhausted");
    item.attemptCount += 1;
    item.status = "active";
    item.dispatches.push({
      dispatchId: event.dispatchId,
      attempt: item.attemptCount,
      ownerRuntimeId: next.owner.runtimeId,
      ownerGeneration: next.owner.generation,
      status: "spawning",
      requestedAt: event.at,
      consumeStatus: "not_applicable",
      consumeAttempts: 0,
    });
    return applied(next, event.at);
  }

  if (event.type === "dispatch_bound") {
    const item = next.work.find((candidate) => candidate.id === event.workId);
    const dispatch = item && activeDispatch(item);
    if (!item || !dispatch || dispatch.dispatchId !== event.dispatchId) return rejected(state, "stale_dispatch");
    if (dispatch.status !== "spawning") return rejected(state, "dispatch_already_bound");
    const duplicateAgent = next.work.some((candidate) => candidate.dispatches.some((candidateDispatch) => candidateDispatch.agentId === event.agentId));
    if (duplicateAgent) return rejected(state, "duplicate_agent");
    dispatch.agentId = event.agentId;
    dispatch.status = "queued";
    dispatch.boundAt = event.at;
    return applied(next, event.at);
  }

  if (event.type === "dispatch_started") {
    const found = findByAgent(next, event.agentId);
    if (!found) return rejected(state, "agent_not_active");
    if (found.dispatch.status === "running") return rejected(state, "duplicate_event");
    found.dispatch.status = "running";
    found.dispatch.startedAt = event.at;
    return applied(next, event.at);
  }

  if (event.type === "dispatch_settled") {
    const found = findByAgent(next, event.agentId);
    if (!found) return rejected(state, "agent_not_active");
    found.dispatch.status = event.outcome;
    found.dispatch.result = truncate(event.result, MAX_ORCHESTRATION_RESULT_CHARS);
    found.dispatch.error = truncate(event.error, MAX_ORCHESTRATION_ERROR_CHARS);
    found.dispatch.usage = event.usage;
    found.dispatch.settledAt = event.at;
    found.dispatch.consumeStatus = "provider_owned";
    found.item.status = event.outcome === "completed" ? "completed" : "failed";
    if (event.outcome === "failed") settleFailure(found.item, next);
    refreshControllerStatus(next, event.at);
    return applied(next, event.at);
  }

  if (event.type === "dispatch_spawn_failed" || event.type === "dispatch_interrupted" || event.type === "dispatch_uncertain") {
    const item = next.work.find((candidate) => candidate.id === event.workId);
    const dispatch = item && activeDispatch(item);
    if (!item || !dispatch || dispatch.dispatchId !== event.dispatchId) return rejected(state, "stale_dispatch");
    const uncertain = event.type === "dispatch_uncertain";
    if (uncertain) dispatch.status = "uncertain";
    else if (event.type === "dispatch_interrupted") dispatch.status = "interrupted";
    else dispatch.status = "failed";
    dispatch.error = truncate(event.error, MAX_ORCHESTRATION_ERROR_CHARS);
    dispatch.settledAt = event.at;
    dispatch.consumeStatus = dispatch.agentId ? "pending" : "not_applicable";
    item.status = uncertain ? "uncertain" : "failed";
    if (!uncertain) settleFailure(item, next);
    refreshControllerStatus(next, event.at);
    return applied(next, event.at);
  }

  if (event.type === "consume_recorded") {
    const dispatch = next.work.flatMap((item) => item.dispatches).find((candidate) => candidate.agentId === event.agentId);
    if (dispatch?.consumeStatus !== "pending") return rejected(state, "consume_not_pending");
    dispatch.consumeAttempts += 1;
    if (event.consumed) dispatch.consumeStatus = "consumed";
    else if (dispatch.consumeAttempts >= 3) dispatch.consumeStatus = "unavailable";
    else dispatch.consumeStatus = "pending";
    return applied(next, event.at);
  }

  if (event.type === "wake_acknowledged") {
    if (!next.pendingWake || next.pendingWake.sequence !== event.sequence) return rejected(state, "stale_wake");
    next.pendingWake = undefined;
    return applied(next, event.at);
  }

  if (event.type === "cancelled") {
    next.status = "cancelled";
    next.pendingWake = undefined;
    for (const item of next.work) {
      if (item.status === "completed") continue;
      const dispatch = activeDispatch(item);
      if (dispatch) {
        dispatch.status = "stopped";
        dispatch.settledAt = event.at;
        dispatch.consumeStatus = dispatch.agentId ? "pending" : "not_applicable";
      }
      item.status = "cancelled";
    }
    return applied(next, event.at);
  }

  return rejected(state, "unsupported_event");
}
