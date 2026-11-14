import { type AckSignal, applyAckSignal, classifySettlement, createAckWindow, INITIAL_WINDOW, observeDelay, validateAckWindow, windowCapacity } from "./ack-window.js";
import type {
  OrchestrationActor,
  OrchestrationDefinitionInput,
  OrchestrationDispatch,
  OrchestrationState,
  OrchestrationUsage,
  OrchestrationVerification,
  OrchestrationWakeReason,
  OrchestrationWorkItem,
  OrchestrationWorkStatus,
  WindowSeed,
} from "./types.js";

export const MAX_ORCHESTRATION_RESULT_CHARS = 8_192;
export const MAX_ORCHESTRATION_ERROR_CHARS = 2_048;
export const ORCHESTRATION_OWNER_LEASE_MS = 120_000;
export const MAX_ORCHESTRATION_WORK_ITEMS = 32;
export const MAX_ORCHESTRATION_CONCURRENCY = 8;
export const MAX_ORCHESTRATION_ATTEMPTS = 3;
/** An earlier batch's window informs a new one only while the path is likely unchanged. */
export const LEARNED_WINDOW_TTL_MS = 30 * 60_000;
/** Congestion losses one item may re-send without spending an attempt. */
export const MAX_CONGESTION_RETRIES_PER_ITEM = 3;
export const MAX_ORCHESTRATION_INPUT_BYTES = 65_536;
export const MAX_ORCHESTRATION_VERIFY_CHARS = 2_048;
export const MAX_ORCHESTRATION_VERIFY_OUTPUT_CHARS = 2_048;

const ORCHESTRATION_STATUSES = new Set(["active", "needs_attention", "completed", "cancelled"]);
const WORK_STATUSES = new Set(["pending", "active", "completed", "failed", "uncertain", "cancelled"]);
const DISPATCH_STATUSES = new Set(["spawning", "queued", "running", "verifying", "completed", "failed", "interrupted", "stopped", "uncertain"]);
const CONSUME_STATUSES = new Set(["not_applicable", "provider_owned", "pending", "consumed", "unavailable"]);
const WAKE_REASONS = new Set(["completed", "failed", "uncertain", "recovery"]);

export function validateOrchestrationDefinition(input: OrchestrationDefinitionInput): string | undefined {
  if (!input.goal.trim()) return "goal must not be empty";
  if (!Array.isArray(input.work) || input.work.length < 1 || input.work.length > MAX_ORCHESTRATION_WORK_ITEMS) {
    return `work must contain 1-${MAX_ORCHESTRATION_WORK_ITEMS} items`;
  }
  if (input.pacing !== undefined && input.pacing !== "fixed" && input.pacing !== "aimd") return "invalid pacing";
  // aimd ignores concurrency entirely; the fixed-pacing bound only applies when it is used.
  const concurrency = input.concurrency ?? 3;
  if (input.pacing !== "aimd" && (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_ORCHESTRATION_CONCURRENCY)) return "invalid concurrency";
  const attempts = input.maxAttempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1 || attempts > MAX_ORCHESTRATION_ATTEMPTS) return "invalid maxAttempts";
  if (input.maxTurns !== undefined && (!Number.isInteger(input.maxTurns) || input.maxTurns < 1 || input.maxTurns > 100)) return "invalid maxTurns";
  if (input.work.some((item) => !item.prompt.trim())) return "work prompts must not be empty";
  if (input.work.some((item) => item.verify !== undefined && (!item.verify.trim() || item.verify.length > MAX_ORCHESTRATION_VERIFY_CHARS))) return "invalid verify command";
  if (input.initialWindow !== undefined && !isWindowSeed(input.initialWindow)) return "invalid initialWindow";
  // The limit bounds what the caller sent; a seed injected by OrchestrationCreate does not count.
  const { initialWindow: _seed, ...callerInput } = input;
  if (Buffer.byteLength(JSON.stringify(callerInput), "utf8") > MAX_ORCHESTRATION_INPUT_BYTES) return "serialized input exceeds limit";
  return undefined;
}

function isWindowSeed(value: unknown): value is WindowSeed {
  const units = (field: unknown) => Number.isInteger(field) && Number(field) >= 1 && Number(field) <= MAX_ORCHESTRATION_WORK_ITEMS;
  return isRecord(value) && units(value.cwnd) && (value.ssthresh === undefined || units(value.ssthresh));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isVerification(value: unknown): value is OrchestrationVerification {
  if (!isRecord(value) || typeof value.passed !== "boolean") return false;
  if (value.exitCode !== null && !Number.isInteger(value.exitCode)) return false;
  if (!Number.isFinite(value.durationMs) || Number(value.durationMs) < 0) return false;
  return value.output === undefined || (typeof value.output === "string" && value.output.length <= MAX_ORCHESTRATION_VERIFY_OUTPUT_CHARS);
}

export function validatePersistedOrchestration(value: unknown): OrchestrationState {
  if (!isRecord(value) || value.version !== 1) throw new Error("Malformed orchestration state: unsupported version");
  if (!Number.isInteger(value.revision) || Number(value.revision) < 1) throw new Error("Malformed orchestration state: invalid revision");
  if (!ORCHESTRATION_STATUSES.has(String(value.status))) throw new Error("Malformed orchestration state: invalid status");
  if (typeof value.goal !== "string" || !value.goal.trim()) throw new Error("Malformed orchestration state: invalid goal");
  const concurrencyLimit = value.window === undefined ? MAX_ORCHESTRATION_CONCURRENCY : MAX_ORCHESTRATION_WORK_ITEMS;
  if (!Number.isInteger(value.concurrency) || Number(value.concurrency) < 1 || Number(value.concurrency) > concurrencyLimit) throw new Error("Malformed orchestration state: invalid concurrency");
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
    if (rawItem.verify !== undefined && (typeof rawItem.verify !== "string" || !rawItem.verify.trim() || rawItem.verify.length > MAX_ORCHESTRATION_VERIFY_CHARS)) throw new Error("Malformed orchestration state: invalid verify command");
    ids.add(rawItem.id);
    if (rawItem.status !== "completed") allWorkCompleted = false;
    const congestionRetries = rawItem.congestionRetries ?? 0;
    if (rawItem.congestionRetries !== undefined && (!Number.isInteger(rawItem.congestionRetries) || Number(rawItem.congestionRetries) < 1 || Number(rawItem.congestionRetries) > MAX_CONGESTION_RETRIES_PER_ITEM || Number(rawItem.congestionRetries) > Number(rawItem.attemptCount))) {
      throw new Error("Malformed orchestration state: invalid congestion retries");
    }
    const chargedAttempts = Number(rawItem.attemptCount) - Number(congestionRetries);
    if (Number(rawItem.attemptCount) < 0 || chargedAttempts > Number(value.maxAttempts) || rawItem.dispatches.length !== Number(rawItem.attemptCount)) throw new Error("Malformed orchestration state: invalid attempt count");
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
      if (rawDispatch.verify !== undefined && !isVerification(rawDispatch.verify)) throw new Error("Malformed orchestration state: invalid verification");
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
    const hasActiveDispatch = isRecord(lastDispatch) && (lastDispatch.status === "spawning" || lastDispatch.status === "queued" || lastDispatch.status === "running" || lastDispatch.status === "verifying");
    if (isRecord(lastDispatch) && lastDispatch.status === "verifying" && (rawItem.verify === undefined || typeof lastDispatch.agentId !== "string")) throw new Error("Malformed orchestration state: verifying dispatch without verifier");
    if (shouldBeActive !== hasActiveDispatch) throw new Error("Malformed orchestration state: work/dispatch status mismatch");
  }
  if (value.status === "completed" && !allWorkCompleted) throw new Error("Malformed orchestration state: incomplete completed batch");
  if (!Number.isInteger(value.nextWakeSequence) || Number(value.nextWakeSequence) < 0 || !Number.isFinite(value.createdAt) || !Number.isFinite(value.updatedAt)) throw new Error("Malformed orchestration state: invalid sequence or timestamp");
  if (value.window !== undefined && !validateAckWindow(value.window, Number(value.concurrency))) throw new Error("Malformed orchestration state: invalid window");
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
  | { type: "cleanup_bound"; at: number; expected: ExpectedOrchestration; workId: string; dispatchId: string; attempt: number; agentId: string }
  | { type: "dispatch_started"; at: number; expected: ExpectedOrchestration; agentId: string }
  | { type: "dispatch_settled"; at: number; expected: ExpectedOrchestration; agentId: string; outcome: "completed" | "failed"; result?: string; error?: string; usage?: OrchestrationUsage; verify?: OrchestrationVerification }
  | { type: "dispatch_awaiting_verify"; at: number; expected: ExpectedOrchestration; agentId: string; result?: string; usage?: OrchestrationUsage }
  | { type: "dispatch_verified"; at: number; expected: ExpectedOrchestration; agentId: string; verify: OrchestrationVerification }
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
        verify: dispatch.verify ? { ...dispatch.verify } : undefined,
      })),
    })),
    pendingWake: state.pendingWake ? { ...state.pendingWake } : undefined,
    window: state.window ? { ...state.window } : undefined,
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

function findVerifying(state: OrchestrationState, agentId: string): { item: OrchestrationWorkItem; dispatch: OrchestrationDispatch } | undefined {
  for (const item of state.work) {
    const dispatch = item.dispatches.at(-1);
    if (dispatch?.status === "verifying" && dispatch.agentId === agentId) return { item, dispatch };
  }
  return undefined;
}

interface SettlementInput {
  outcome: "completed" | "failed";
  result?: string;
  error?: string;
  usage?: OrchestrationUsage;
  verify?: OrchestrationVerification;
}

function settleDispatch(
  next: OrchestrationState,
  found: { item: OrchestrationWorkItem; dispatch: OrchestrationDispatch },
  input: SettlementInput,
  at: number,
): void {
  const { item, dispatch } = found;
  dispatch.status = input.outcome;
  dispatch.result = truncate(input.result, MAX_ORCHESTRATION_RESULT_CHARS);
  dispatch.error = truncate(input.error, MAX_ORCHESTRATION_ERROR_CHARS);
  dispatch.usage = input.usage;
  dispatch.settledAt ??= at;
  dispatch.consumeStatus = "provider_owned";
  if (input.verify) dispatch.verify = { ...input.verify, output: truncate(input.verify.output, MAX_ORCHESTRATION_VERIFY_OUTPUT_CHARS) };
  // A declared verifier with no passing evidence is not an ACK; the item retries within its budget.
  const verifiedFailure = input.outcome === "completed" && item.verify !== undefined && input.verify?.passed !== true;
  item.status = input.outcome === "completed" && !verifiedFailure ? "completed" : "failed";
  if (verifiedFailure && !dispatch.error) dispatch.error = input.verify ? `verify failed (exit ${input.verify.exitCode ?? "killed"})` : "verify did not run";
  const evidence = {
    outcome: input.outcome,
    result: input.result,
    error: input.error,
    attempt: dispatch.attempt,
    verifyPassed: item.verify === undefined ? undefined : input.verify?.passed ?? false,
    durationMs: input.usage?.durationMs,
    outputTokens: input.usage?.tokens?.output,
  };
  // Fixed pacing has no window but still tells congestion from task failure.
  const signal = classifySettlement(evidence, next.window ?? {});
  if (next.window) {
    // A failure before any tool ran or any output streamed is an admission rejection.
    const refused = input.outcome === "failed" && input.usage?.toolUses === 0 && !((input.usage.tokens?.output ?? 0) > 0);
    recordAckSignal(next, signal, dispatch, at, refused);
    next.window = observeDelay(next.window, evidence);
  }
  if (item.status === "failed") {
    forgiveCongestion(item, next, signal, input.usage?.toolUses);
    settleFailure(item, next);
  }
  refreshControllerStatus(next, at);
}

function setPendingWake(state: OrchestrationState, reason: OrchestrationWakeReason, at: number): void {
  if (state.pendingWake?.reason === reason) return;
  state.nextWakeSequence += 1;
  state.pendingWake = { reason, sequence: state.nextWakeSequence, createdAt: at };
}

export function isUnconfirmedDispatch(dispatch: OrchestrationDispatch): boolean {
  return dispatch.status === "spawning" || dispatch.status === "queued" || dispatch.status === "running"
    || dispatch.status === "uncertain" || dispatch.status === "interrupted" || dispatch.status === "stopped";
}

export function hasUnconfirmedDispatches(state: OrchestrationState): boolean {
  return state.work.some((item) => item.dispatches.some(isUnconfirmedDispatch));
}

export function normalizeOrchestrationStops(state: OrchestrationState): OrchestrationState {
  const next = cloneState(state);
  let changed = false;
  for (const item of next.work) {
    for (const dispatch of item.dispatches) {
      if (dispatch.status !== "interrupted" && dispatch.status !== "stopped" && dispatch.status !== "uncertain") continue;
      if (dispatch.status !== "uncertain" || dispatch.consumeStatus !== "unavailable") {
        dispatch.status = "uncertain";
        dispatch.consumeStatus = "unavailable";
        changed = true;
      }
      if (item.status !== "active" && item.status !== "cancelled" && item.status !== "uncertain") {
        item.status = "uncertain";
        changed = true;
      }
    }
  }
  if (!changed) return state;
  refreshControllerStatus(next, next.updatedAt);
  next.revision += 1;
  return next;
}

function refreshControllerStatus(state: OrchestrationState, at: number): void {
  if (state.status === "cancelled") return;
  const hasActiveWork = state.work.some((item) => item.status === "active");
  if (state.work.some((item) => item.status === "uncertain" || item.dispatches.some((dispatch) => dispatch.status === "uncertain"))) {
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

/** Local dispatch capacity: `concurrency`, narrowed by the ACK window when paced. */
export function getOrchestrationCapacity(state: OrchestrationState): number {
  return state.window ? windowCapacity(state.window, state.concurrency) : state.concurrency;
}

function recordAckSignal(state: OrchestrationState, signal: AckSignal, dispatch: OrchestrationDispatch, at: number, rejected = false): void {
  if (state.window) state.window = applyAckSignal(state.window, signal, state.concurrency, { at, requestedAt: dispatch.requestedAt, rejected });
}

/** Attempts charged against maxAttempts: congestion losses re-sent for free are excluded. */
function chargedAttempts(item: OrchestrationWorkItem): number {
  return item.attemptCount - (item.congestionRetries ?? 0);
}

/**
 * A dispatch lost to congestion is the path's failure, not the task's: like a
 * dropped segment it is re-sent without spending one of the item's attempts.
 * Only a worker that ran no tools is re-sent for free; one that did may have
 * changed the workspace, so a re-run is an ordinary, charged retry.
 * The batch budget (one per item) and per-item cap keep these re-sends from
 * sustaining the overload that caused them (retry amplification; metastable
 * failures). Timeouts are excluded: a worker past its own deadline may be the
 * task's fault.
 */
function forgiveCongestion(item: OrchestrationWorkItem, state: OrchestrationState, signal: AckSignal, toolUses: number | undefined): void {
  if (signal !== "congestion" || toolUses !== 0) return;
  const itemRetries = item.congestionRetries ?? 0;
  const batchRetries = state.work.reduce((sum, candidate) => sum + (candidate.congestionRetries ?? 0), 0);
  if (itemRetries >= MAX_CONGESTION_RETRIES_PER_ITEM || batchRetries >= state.work.length) return;
  item.congestionRetries = itemRetries + 1;
}

function settleFailure(item: OrchestrationWorkItem, state: OrchestrationState): void {
  item.status = chargedAttempts(item) < state.maxAttempts ? "pending" : "failed";
}

/**
 * Under aimd only feedback limits the window. A fully verified batch is bounded
 * by its size; otherwise any non-empty answer is an ACK, so growth stops at the
 * fixed-pacing maximum.
 */
function aimdCeiling(work: OrchestrationDefinitionInput["work"]): number {
  return work.every((item) => item.verify !== undefined) ? work.length : Math.min(work.length, MAX_ORCHESTRATION_CONCURRENCY);
}

/**
 * The window a new aimd batch should start from, learned from the most recent
 * aimd batch in this session for the same model (RFC 9040's TCB sharing, kept
 * to one session). After a loss the window has found the path's limit: the
 * batch starts where it settled (never below the last cut point) and grows
 * additively. Without a loss the window was only a lower bound, so the batch
 * starts there and keeps slow start.
 */
export function learnWindowSeed(
  previous: ReadonlyArray<{ id: string; state: OrchestrationState }>,
  model: string | undefined,
  now: number,
): (WindowSeed & { source: string }) | undefined {
  // A batch still running holds its window on the same path; seeding from it would double the load.
  const candidates = previous.filter(({ state }) => state.window !== undefined
    && state.status !== "active"
    && !state.work.some((item) => item.status === "active")
    && state.model === model
    && now - state.updatedAt <= LEARNED_WINDOW_TTL_MS
    && state.window.acks + state.window.losses > 0);
  const latest = candidates.reduce<(typeof candidates)[number] | undefined>((best, candidate) => !best || candidate.state.updatedAt > best.state.updatedAt ? candidate : best, undefined);
  if (!latest?.state.window) return undefined;
  const { window } = latest.state;
  if (window.losses > 0) {
    const settled = Math.max(window.ssthresh, Math.floor(window.cwnd));
    return { cwnd: settled, ssthresh: settled, source: latest.id };
  }
  return { cwnd: Math.max(INITIAL_WINDOW, Math.floor(window.cwnd)), source: latest.id };
}

export function createOrchestrationState(
  input: OrchestrationDefinitionInput,
  owner: OrchestrationActor,
  at: number,
): OrchestrationState {
  const concurrency = input.pacing === "aimd" ? aimdCeiling(input.work) : input.concurrency ?? 3;
  const seed = input.pacing === "aimd" ? input.initialWindow : undefined;
  return {
    version: 1,
    revision: 1,
    status: "active",
    goal: input.goal,
    concurrency,
    maxAttempts: input.maxAttempts ?? 1,
    model: input.model,
    maxTurns: input.maxTurns,
    owner: { ...owner, leaseExpiresAt: at + ORCHESTRATION_OWNER_LEASE_MS },
    work: input.work.map((item, index) => ({
      id: String(index + 1),
      prompt: item.prompt,
      agentType: item.agentType,
      ...(item.verify !== undefined ? { verify: item.verify } : {}),
      status: "pending",
      attemptCount: 0,
      dispatches: [],
    })),
    nextWakeSequence: 0,
    ...(input.pacing === "aimd" ? { window: createAckWindow(concurrency, seed) } : {}),
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
  if (state.status === "cancelled" && event.type !== "consume_recorded" && event.type !== "cleanup_bound" && event.type !== "cancelled") return rejected(state, "controller_cancelled");
  if (state.status === "cancelled" && event.type === "cancelled") return { applied: true, state };

  const next = cloneState(state);
  next.owner.leaseExpiresAt = event.at + ORCHESTRATION_OWNER_LEASE_MS;

  if (event.type === "owner_renewed") return applied(next, event.at);

  if (event.type === "dispatch_requested") {
    if (state.status !== "active") return rejected(state, "controller_not_active");
    if (state.work.some((item) => item.dispatches.some((dispatch) => dispatch.status === "uncertain" || dispatch.status === "interrupted" || dispatch.status === "stopped"))) return rejected(state, "termination_unconfirmed");
    const item = next.work.find((candidate) => candidate.id === event.workId);
    if (!item) return rejected(state, "work_not_found");
    if (item.status !== "pending") return rejected(state, "work_not_pending");
    if (getOrchestrationCounts(next).active >= getOrchestrationCapacity(next)) return rejected(state, "capacity_exhausted");
    if (chargedAttempts(item) >= next.maxAttempts) return rejected(state, "attempts_exhausted");
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

  if (event.type === "cleanup_bound") {
    const item = next.work.find((candidate) => candidate.id === event.workId);
    const dispatch = item?.dispatches.find((candidate) => candidate.dispatchId === event.dispatchId && candidate.attempt === event.attempt);
    if (dispatch?.status !== "uncertain" || dispatch.agentId
      || dispatch.ownerRuntimeId !== event.expected.ownerRuntimeId || dispatch.ownerGeneration !== event.expected.generation) return rejected(state, "stale_cleanup");
    if (!event.agentId || next.work.some((candidate) => candidate.dispatches.some((d) => d.agentId === event.agentId))) return rejected(state, "duplicate_agent");
    dispatch.agentId = event.agentId;
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
    settleDispatch(next, found, event, event.at);
    return applied(next, event.at);
  }

  if (event.type === "dispatch_awaiting_verify") {
    const found = findByAgent(next, event.agentId);
    if (!found) return rejected(state, "agent_not_active");
    if (found.item.verify === undefined) return rejected(state, "verify_not_declared");
    // The worker has finished; persist its evidence so a restart re-verifies instead of discarding it.
    found.dispatch.status = "verifying";
    found.dispatch.result = truncate(event.result, MAX_ORCHESTRATION_RESULT_CHARS);
    found.dispatch.usage = event.usage;
    found.dispatch.settledAt = event.at;
    found.dispatch.consumeStatus = "provider_owned";
    return applied(next, event.at);
  }

  if (event.type === "dispatch_verified") {
    const found = findVerifying(next, event.agentId);
    if (!found) return rejected(state, "dispatch_not_verifying");
    settleDispatch(next, found, { outcome: "completed", result: found.dispatch.result, usage: found.dispatch.usage, verify: event.verify }, event.at);
    return applied(next, event.at);
  }

  if (event.type === "dispatch_spawn_failed" || event.type === "dispatch_interrupted" || event.type === "dispatch_uncertain") {
    const item = next.work.find((candidate) => candidate.id === event.workId);
    const dispatch = item && activeDispatch(item);
    if (!item || !dispatch || dispatch.dispatchId !== event.dispatchId) return rejected(state, "stale_dispatch");
    const uncertain = event.type !== "dispatch_spawn_failed";
    dispatch.status = uncertain ? "uncertain" : "failed";
    dispatch.error = truncate(event.error, MAX_ORCHESTRATION_ERROR_CHARS);
    dispatch.settledAt = event.at;
    dispatch.consumeStatus = uncertain ? "unavailable" : dispatch.agentId ? "pending" : "not_applicable";
    item.status = uncertain ? "uncertain" : "failed";
    // Uncertain termination already blocks every dispatch; a proved spawn failure is path congestion.
    if (!uncertain) {
      recordAckSignal(next, "congestion", dispatch, event.at, true);
      // A proved spawn failure never started a worker.
      forgiveCongestion(item, next, "congestion", 0);
      settleFailure(item, next);
    }
    refreshControllerStatus(next, event.at);
    return applied(next, event.at);
  }

  if (event.type === "consume_recorded") {
    const dispatch = next.work.flatMap((item) => item.dispatches).find((candidate) => candidate.agentId === event.agentId);
    if (dispatch?.consumeStatus !== "pending" || isUnconfirmedDispatch(dispatch)) return rejected(state, "consume_not_pending");
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
      const last = item.dispatches.at(-1);
      if (last?.status === "verifying") {
        // The worker already finished, so termination is confirmed; only the verdict is abandoned.
        last.status = "completed";
        last.error = "cancelled before verification";
        item.status = "cancelled";
        continue;
      }
      const dispatch = activeDispatch(item);
      if (dispatch) {
        dispatch.status = "uncertain";
        dispatch.error = "Cancellation requested; worker termination is unconfirmed. No automatic retry or consume.";
        dispatch.settledAt = event.at;
        dispatch.consumeStatus = "unavailable";
      }
      item.status = "cancelled";
    }
    return applied(next, event.at);
  }

  return rejected(state, "unsupported_event");
}
