import { homedir } from "node:os";
import { join } from "node:path";
import { DEFAULT_LOOP_EXPIRY_MS, expiresAtFromDuration, parseLoopDurationMs } from "./loop-expiry.js";
import { atMaxFires, type LoopReducerEffect, type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import { applyOrchestrationEvent, hasUnconfirmedDispatches, normalizeOrchestrationStops, type OrchestrationEvent, validateOrchestrationDefinition, validatePersistedOrchestration } from "./orchestration-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { DynamicLoopState, LoopDeletionTombstone, LoopDeletionTombstoneInput, LoopEntry, LoopExpiryDisposition, LoopExpiryReason, LoopFireOrigin, LoopPauseKind, LoopPauseRecord, LoopStoreData, OrchestrationActor, OrchestrationDefinitionInput, Trigger, WorkflowDefinition, WorkflowMonitorSettlement, WorkflowMonitorWait, WorkflowRevisionFailure, WorkflowRunState, WorkflowRuntimeActor, WorkflowTerminalStatus } from "./types.js";
import { validateWorkflowDefinition } from "./workflow-definition.js";
import { atWorkflowStateFireLimit, isTerminalWorkflowRun, transitionWorkflowRun, validateWorkflowAdmissionRecord, type WorkflowTransitionFailure, type WorkflowTransitionInput } from "./workflow-reducer.js";
import { validatePersistedWorkflowRevision, type WorkflowRevisionInput, type WorkflowRevisionSummary } from "./workflow-revision.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");

/**
 * One-time normalization for workflows persisted by v0.7.3, which linked state
 * work to an external TaskStore record (`activeTaskId`). The external link is
 * dropped; when the current state declares task work with no embedded
 * execution, an unleased execution is synthesized so the workflow fails closed
 * until a runtime claims it.
 */
function normalizeWorkflowRunState(workflow: WorkflowRunState): WorkflowRunState {
  const legacy = workflow as WorkflowRunState & { activeTaskId?: string };
  if (workflow.lastTransition?.admission && validateWorkflowAdmissionRecord(workflow.lastTransition.admission)) {
    throw new Error("Malformed workflow admission provenance");
  }
  const hasRevision = Object.hasOwn(workflow, "definitionRevision");
  const hasHistory = Object.hasOwn(workflow, "revisionHistory");
  if (hasRevision !== hasHistory) throw new Error("Malformed workflow revision metadata: revision and history must appear together");

  const definitionRevision = hasRevision ? workflow.definitionRevision : 1;
  const revisionHistory = hasHistory ? workflow.revisionHistory : [];
  if (!Number.isInteger(definitionRevision) || definitionRevision < 1 || !Array.isArray(revisionHistory)) {
    throw new Error("Malformed workflow revision metadata: invalid revision or history");
  }
  if (definitionRevision !== revisionHistory.length + 1) {
    throw new Error("Malformed workflow revision metadata: revision does not match history length");
  }
  for (const [index, revision] of revisionHistory.entries()) {
    const revisionError = validatePersistedWorkflowRevision(revision, index + 1);
    if (revisionError) throw new Error(`Malformed workflow revision metadata: ${revisionError}`);
  }

  const active = workflow.activeExecution;
  const state = workflow.definition.states[workflow.currentState];
  const { activeTaskId: _dropped, ...withoutLegacy } = legacy;
  const needsExecution = Boolean(
    state?.task
    && (!active || active.stateId !== workflow.currentState || active.transitionSeq !== workflow.transitionSeq),
  );
  return {
    ...withoutLegacy,
    definitionRevision,
    revisionHistory,
    ...(needsExecution ? {
      activeExecution: {
        id: `${workflow.currentState}:${workflow.transitionSeq}`,
        stateId: workflow.currentState,
        transitionSeq: workflow.transitionSeq,
        subject: state!.task!.subject,
        description: state!.task!.description,
        status: "active" as const,
        createdAt: workflow.stateEnteredAt,
        updatedAt: workflow.stateEnteredAt,
      },
    } : {}),
  };
}
const LOOP_PAUSE_KINDS = new Set<LoopPauseKind>([
  "administrative",
  "controller_limit",
  "semantic_terminal",
  "orchestration_settlement",
]);

function normalizePauseRecord(entry: LoopEntry): LoopPauseRecord | undefined {
  const pause = entry.pause;
  if (!pause) return undefined;
  if (entry.status !== "paused"
    || !LOOP_PAUSE_KINDS.has(pause.kind)
    || !Number.isFinite(pause.at)
    || (pause.reason !== undefined && (typeof pause.reason !== "string" || pause.reason.length > 512))) {
    throw new Error("Malformed loop pause provenance");
  }
  return pause;
}

function validateControllerDomain(entry: {
  workflow?: unknown;
  orchestration?: unknown;
  autoTask?: boolean;
  taskBacklog?: boolean;
  trigger: Trigger;
}): void {
  if (entry.autoTask && entry.taskBacklog) {
    throw new Error("Malformed loop controller: auto-task and task-backlog behavior are mutually exclusive");
  }
  if (entry.workflow && (entry.autoTask || entry.taskBacklog || entry.orchestration)) {
    throw new Error("Malformed loop controller: workflow cannot own standalone tasks or orchestration behavior");
  }
  if (entry.orchestration && (entry.autoTask || entry.taskBacklog)) {
    throw new Error("Malformed loop controller: orchestration cannot own standalone task behavior");
  }
  if ((entry.workflow || entry.orchestration) && entry.trigger.type !== "dynamic") {
    throw new Error("Malformed loop controller: workflow and orchestration controllers require a dynamic trigger");
  }
}

function normalizeLoopEntry(entry: LoopEntry): LoopEntry {
  const pause = normalizePauseRecord(entry);
  validateControllerDomain(entry);
  return {
    ...entry,
    ...(pause ? { pause } : {}),
    ...(entry.workflow ? { workflow: normalizeWorkflowRunState(entry.workflow) } : {}),
    ...(entry.orchestration ? { orchestration: normalizeOrchestrationStops(validatePersistedOrchestration(entry.orchestration)) } : {}),
  };
}

export interface ExpiredLoopRecord {
  entry: LoopEntry;
  disposition: LoopExpiryDisposition;
  reason: LoopExpiryReason;
}

export interface LoopFireExpectedIdentity {
  createdAt: number;
  updatedAt: number;
  status: LoopEntry["status"];
  fireCount: number;
  workflowState?: string;
  workflowTransitionSeq?: number;
  workflowDefinitionRevision?: number;
  workflowExecutionId?: string;
  workflowMonitorId?: string;
}

export type LoopFireResult =
  | { kind: "fired"; entry: LoopEntry; settlement?: "deleted_by_fire_limit" }
  | { kind: "expired"; record: ExpiredLoopRecord }
  | { kind: "ignored" };

function workflowTransitionPausePolicy(
  entry: LoopEntry,
  input: WorkflowTransitionInput,
): { error?: string; resumeAfterStateLimitExit: boolean } {
  if (entry.status !== "paused") return { resumeAfterStateLimitExit: false };
  if (!entry.workflow) return { error: `Loop #${entry.id} is not a workflow loop`, resumeAfterStateLimitExit: false };
  if (Date.now() >= entry.expiresAt || entry.pause?.reason === "loop expiry reached") {
    return { error: `Workflow #${entry.id} has expired and cannot be resumed or transitioned`, resumeAfterStateLimitExit: false };
  }
  if (entry.pause?.kind !== "controller_limit") {
    const reason = entry.pause?.kind === "administrative"
      ? "is administratively paused; resume it before transitioning"
      : "is paused; inspect its pause cause before transitioning";
    return { error: `Workflow #${entry.id} ${reason}`, resumeAfterStateLimitExit: false };
  }

  const workflow = entry.workflow;
  const target = workflow.definition.states[workflow.currentState]?.on?.[input.outcome];
  if (target === undefined) return { resumeAfterStateLimitExit: false };
  if (target === workflow.currentState) {
    return {
      error: `Workflow #${entry.id} self-transition "${input.outcome}" cannot bypass the controller limit`,
      resumeAfterStateLimitExit: false,
    };
  }
  if (workflow.definition.states[target]?.terminal) return { resumeAfterStateLimitExit: false };
  if (atMaxFires(entry) || !atWorkflowStateFireLimit(workflow)) {
    return {
      error: `Workflow #${entry.id} controller limit is exhausted; only a terminal transition may proceed`,
      resumeAfterStateLimitExit: false,
    };
  }
  if (!input.evidence?.trim()) {
    return {
      error: `Workflow #${entry.id} requires evidence to leave a state whose cadence limit is exhausted`,
      resumeAfterStateLimitExit: false,
    };
  }
  return { resumeAfterStateLimitExit: true };
}

const MAX_LOOPS = 25;
const TOMBSTONE_TTL_MS = 10 * 60 * 1000;

export class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData, LoopReducerEffect> {
  private tombstones = new Map<string, LoopDeletionTombstone>();

  constructor(listIdOrPath?: string, private readonly defaultExpiryMs = DEFAULT_LOOP_EXPIRY_MS) {
    super(
      {
        baseDir: LOOPS_DIR,
        reduce: (state, event) => reduceLoopState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, loopsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.loopsById)) }),
        serialize: (nextId, entries) => ({ nextId, loops: Array.from(entries.values()) }),
        deserialize: (data) => ({
          nextId: data.nextId,
          entries: new Map(data.loops.map((entry) => [entry.id, normalizeLoopEntry(entry)])),
        }),
      },
      listIdOrPath,
    );
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; taskBacklog?: boolean; readOnly?: boolean; maxFires?: number; expiresIn?: string; dynamic?: Partial<DynamicLoopState>; workflow?: WorkflowDefinition; actor?: WorkflowRuntimeActor; orchestration?: { definition: OrchestrationDefinitionInput; owner: OrchestrationActor } }): LoopEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      validateControllerDomain({ trigger, ...opts });
      if (opts.workflow) {
        const validationError = validateWorkflowDefinition(opts.workflow);
        if (validationError) throw new Error(`Invalid workflow: ${validationError}`);
      }
      if (opts.orchestration) {
        const validationError = validateOrchestrationDefinition(opts.orchestration.definition);
        if (validationError) throw new Error(`Invalid orchestration: ${validationError}`);
      }
      const now = Date.now();
      const expiryMs = opts.expiresIn === undefined ? this.defaultExpiryMs : parseLoopDurationMs(opts.expiresIn);
      const expiresAt = expiresAtFromDuration(now, expiryMs);
      this.applyReducerEvent({
        type: "LOOP_CREATED",
        at: now,
        source: "tool",
        entityType: "loop",
        payload: {
          prompt,
          trigger,
          recurring: opts.recurring,
          autoTask: opts.autoTask,
          taskBacklog: opts.taskBacklog,
          readOnly: opts.readOnly,
          maxFires: opts.maxFires,
          dynamic: opts.dynamic,
          workflow: opts.workflow,
          actor: opts.actor,
          orchestration: opts.orchestration,
          expiresAt,
        },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  mutateOrchestration(id: string, event: OrchestrationEvent): { entry?: LoopEntry; applied: boolean; reason?: string } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { applied: false, reason: "loop_not_found" };
      if (!entry.orchestration) return { applied: false, reason: "not_orchestration" };
      const result = applyOrchestrationEvent(entry.orchestration, event);
      if (!result.applied) return { entry, applied: false, reason: result.reason };
      this.applyReducerEvent({
        type: "LOOP_ORCHESTRATION_MUTATED",
        at: event.at,
        source: "system",
        entityType: "loop",
        entityId: id,
        payload: { id, event },
      });
      return { entry: this.entries.get(id), applied: true };
    });
  }

  pause(id: string, kind: LoopPauseKind = "administrative", reason?: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      if (entry.status === "paused") return entry;
      const boundedReason = reason?.trim().slice(0, 512);
      this.applyReducerEvent({
        type: "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, kind, ...(boundedReason ? { reason: boundedReason } : {}) },
      });
      return this.entries.get(id);
    });
  }

  resume(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || Date.now() >= entry.expiresAt || isTerminalWorkflowRun(entry.workflow)) return undefined;
      if (entry.pause?.kind === "controller_limit"
        && (atMaxFires(entry) || (entry.workflow && atWorkflowStateFireLimit(entry.workflow)))) {
        return undefined;
      }
      this.applyReducerEvent({
        type: "LOOP_RESUMED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      if (entry.trigger.type === "dynamic" && entry.dynamic?.awaitingUpdate) {
        this.applyReducerEvent({
          type: "LOOP_DYNAMIC_UPDATED",
          at: Date.now(),
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: {
            id,
            dynamic: {
              awaitingUpdate: false,
              lastUpdatedAt: Date.now(),
            },
          },
        });
      }
      return this.entries.get(id);
    });
  }

  private fireUnlocked(
    id: string,
    origin: LoopFireOrigin,
    now: number,
    settleExpiry: boolean,
    expected?: LoopFireExpectedIdentity,
  ): LoopFireResult {
    const entry = this.entries.get(id);
    if (entry?.status !== "active" || isTerminalWorkflowRun(entry?.workflow)) return { kind: "ignored" };
    if (expected && (entry.createdAt !== expected.createdAt
      || entry.updatedAt !== expected.updatedAt
      || entry.status !== expected.status
      || (entry.fireCount ?? 0) !== expected.fireCount
      || entry.workflow?.currentState !== expected.workflowState
      || entry.workflow?.transitionSeq !== expected.workflowTransitionSeq
      || entry.workflow?.definitionRevision !== expected.workflowDefinitionRevision
      || entry.workflow?.activeExecution?.id !== expected.workflowExecutionId
      || entry.workflow?.waitingMonitor?.monitorId !== expected.workflowMonitorId)) return { kind: "ignored" };
    if (now >= entry.expiresAt) {
      const record = settleExpiry ? this.expireEntryUnlocked(id, now) : undefined;
      return record ? { kind: "expired", record } : { kind: "ignored" };
    }
    if (atMaxFires(entry) || (entry.workflow && atWorkflowStateFireLimit(entry.workflow))) {
      this.settleFireLimitUnlocked(entry, now);
      return { kind: "ignored" };
    }
    this.applyReducerEvent({
      type: "LOOP_FIRED",
      at: now,
      source: "system",
      entityType: "loop",
      entityId: id,
      payload: { id, origin },
    });
    const fired = this.entries.get(id)!;
    const limitReached = atMaxFires(fired) || Boolean(fired.workflow && atWorkflowStateFireLimit(fired.workflow));
    const deletedDelivery = limitReached && !fired.workflow && !fired.taskBacklog
      ? structuredClone(fired)
      : undefined;
    if (limitReached) this.settleFireLimitUnlocked(fired, now);
    const settled = this.entries.get(id);
    return {
      kind: "fired",
      entry: settled ?? deletedDelivery ?? fired,
      ...(!settled ? { settlement: "deleted_by_fire_limit" as const } : {}),
    };
  }

  private settleFireLimitUnlocked(entry: LoopEntry, at: number): void {
    const workflowLimitReached = atMaxFires(entry);
    if (!entry.workflow && !entry.taskBacklog) {
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at,
        source: "system",
        entityType: "loop",
        entityId: entry.id,
        payload: { id: entry.id },
      });
      return;
    }
    this.applyReducerEvent({
      type: "LOOP_PAUSED",
      at,
      source: "system",
      entityType: "loop",
      entityId: entry.id,
      payload: {
        id: entry.id,
        kind: "controller_limit",
        reason: workflowLimitReached ? "loop fire cap reached" : "workflow state fire cap reached",
      },
    });
  }

  fire(id: string, origin: LoopFireOrigin = "scheduler"): LoopEntry | undefined {
    const result = this.withLock(() => this.fireUnlocked(id, origin, Date.now(), false));
    return result.kind === "fired" ? result.entry : undefined;
  }

  fireOrExpire(
    id: string,
    origin: LoopFireOrigin = "scheduler",
    now?: number,
    expected?: LoopFireExpectedIdentity,
  ): LoopFireResult {
    return this.withLock(() => this.fireUnlocked(id, origin, now ?? Date.now(), true, expected));
  }

  updateMetadata(id: string, fields: { trigger?: Trigger; prompt?: string; taskBacklog?: boolean }): { entry: LoopEntry | undefined; changedFields: string[] } {
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current) return { entry: undefined, changedFields: [] };

      const candidate = {
        ...current,
        ...(fields.trigger !== undefined ? { trigger: fields.trigger } : {}),
        ...(fields.taskBacklog !== undefined ? { taskBacklog: fields.taskBacklog } : {}),
      };
      validateControllerDomain(candidate);

      const changedFields: string[] = [];
      const now = Date.now();

      if (fields.trigger !== undefined) {
        current.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined && fields.prompt !== current.prompt) {
        current.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (fields.taskBacklog !== undefined && fields.taskBacklog !== current.taskBacklog) {
        current.taskBacklog = fields.taskBacklog;
        changedFields.push("taskBacklog");
      }
      if (changedFields.length > 0) {
        current.updatedAt = now;
      }

      return { entry: this.entries.get(id), changedFields };
    });
  }


  updateDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<DynamicLoopState> },
    expectedWorkflow?: {
      createdAt: number;
      status: LoopEntry["status"];
      currentState: string;
      transitionSeq: number;
      definitionRevision: number;
      activeExecutionId?: string;
    },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      if (expectedWorkflow && (entry.createdAt !== expectedWorkflow.createdAt
        || entry.status !== expectedWorkflow.status
        || !entry.workflow
        || entry.workflow.currentState !== expectedWorkflow.currentState
        || entry.workflow.transitionSeq !== expectedWorkflow.transitionSeq
        || entry.workflow.definitionRevision !== expectedWorkflow.definitionRevision
        || entry.workflow.activeExecution?.id !== expectedWorkflow.activeExecutionId)) return undefined;
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  continueDynamic(
    id: string,
    fields: { prompt?: string; dynamic: Partial<DynamicLoopState> },
    expected?: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || Date.now() >= entry.expiresAt || entry.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow) return undefined;
      if (expected && (
        entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt
      )) return undefined;
      const now = Date.now();
      if (now >= entry.expiresAt) return undefined;
      if (entry.status === "paused") {
        this.applyReducerEvent({
          type: "LOOP_RESUMED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      this.applyReducerEvent({
        type: "LOOP_DYNAMIC_UPDATED",
        at: now,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, prompt: fields.prompt, dynamic: fields.dynamic },
      });
      return this.entries.get(id);
    });
  }

  stopDynamic(
    id: string,
    status: "completed" | "paused",
    expected: { status: LoopEntry["status"]; iteration: number; updatedAt: number },
  ): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || Date.now() >= entry.expiresAt || entry.trigger.type !== "dynamic" || !entry.dynamic || entry.workflow
        || entry.status !== expected.status
        || entry.dynamic.iteration !== expected.iteration
        || entry.updatedAt !== expected.updatedAt) return false;
      const at = Date.now();
      this.applyReducerEvent(status === "completed"
        ? {
            type: "LOOP_DELETED",
            at,
            source: "tool",
            entityType: "loop",
            entityId: id,
            payload: { id },
          }
        : {
            type: "LOOP_PAUSED",
            at,
            source: "tool",
            entityType: "loop",
            entityId: id,
            payload: { id, kind: "administrative" },
          });
      return true;
    });
  }

  reviseWorkflow(
    id: string,
    input: WorkflowRevisionInput,
    actor?: WorkflowRuntimeActor,
  ): { entry?: LoopEntry; applied: boolean; error?: string; failure?: WorkflowRevisionFailure; summary?: WorkflowRevisionSummary } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) {
        const error = `Loop #${id} not found.`;
        return { applied: false, error, failure: { code: "loop_not_found", message: error } };
      }
      if (!entry.workflow) {
        const error = `Loop #${id} is not a workflow loop.`;
        return { applied: false, error, failure: { code: "not_workflow", message: error } };
      }
      const now = Date.now();
      if (now >= entry.expiresAt) {
        const error = `Workflow #${id} has expired and cannot be revised.`;
        return { applied: false, error };
      }
      if (!actor) {
        const error = "Workflow revision requires an active session runtime.";
        return { applied: false, error, failure: { code: "actor_required", message: error } };
      }
      const reduced = this.applyReducerEvent({
        type: "LOOP_WORKFLOW_REVISED",
        at: now,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, ...input, actor },
      });
      const rejection = reduced.effects.find((effect) => effect.type === "WORKFLOW_REVISION_REJECTED");
      if (rejection?.type === "WORKFLOW_REVISION_REJECTED") {
        return { applied: false, error: rejection.payload.error, failure: rejection.payload.failure };
      }
      const persisted = reduced.effects.find((effect) => effect.type === "PERSIST_LOOP");
      if (persisted?.type !== "PERSIST_LOOP" || !persisted.payload.workflowRevision) {
        const error = "Workflow revision produced no authoritative reducer outcome.";
        return { applied: false, error, failure: { code: "graph_invalid", message: error } };
      }
      return { entry: this.entries.get(id), applied: true, summary: persisted.payload.workflowRevision };
    }, (result) => result.applied);
  }

  transitionWorkflow(
    id: string,
    input: WorkflowTransitionInput,
    expected: { currentState: string; transitionSeq: number; definitionRevision: number; activeExecutionId?: string },
  ): { entry?: LoopEntry; applied: boolean; error?: string; failure?: WorkflowTransitionFailure; terminal?: WorkflowTerminalStatus } {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { applied: false, error: `Loop #${id} not found` };
      if (!entry.workflow) return { applied: false, error: `Loop #${id} is not a workflow loop` };
      const now = Date.now();
      if (now >= entry.expiresAt) return { applied: false, error: `Workflow #${id} has expired and cannot be transitioned` };
      if (!expected) return { applied: false, error: `Workflow #${id} transition requires current execution identity; inspect LoopList and retry.` };
      const pausePolicy = workflowTransitionPausePolicy(entry, input);
      if (pausePolicy.error) return { applied: false, error: pausePolicy.error };
      if (
        entry.workflow.currentState !== expected.currentState
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.definitionRevision !== expected.definitionRevision
        || entry.workflow.activeExecution?.id !== expected.activeExecutionId
      ) {
        return { applied: false, error: `Workflow #${id} changed; inspect LoopList and retry the transition.` };
      }
      const result = transitionWorkflowRun(entry.workflow, input, now);
      if (!result.applied) {
        return { applied: false, error: result.error, failure: result.failure };
      }

      const eventType = result.terminal ? "LOOP_WORKFLOW_TERMINAL_TRANSITION" : "LOOP_WORKFLOW_TRANSITION";
      this.applyReducerEvent({
        type: eventType,
        at: result.run.stateEnteredAt,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: {
          id,
          outcome: input.outcome,
          evidence: input.evidence,
          admission: input.admission,
          actor: input.actor,
          ...(result.terminal ? { terminal: result.terminal } : {}),
        },
      } as LoopReducerEvent);
      if (result.terminal) {
        const terminalEntry: LoopEntry = {
          ...entry,
          status: result.terminal === "paused" ? "paused" : "active",
          pause: result.terminal === "paused"
            ? { kind: "semantic_terminal" as const, at: result.run.stateEnteredAt }
            : undefined,
          updatedAt: result.run.stateEnteredAt,
          dynamic: {
            goal: entry.dynamic?.goal ?? entry.prompt,
            state: result.run.currentState,
            metrics: entry.dynamic?.metrics,
            doneCriteria: entry.dynamic?.doneCriteria,
            iteration: (entry.dynamic?.iteration ?? 0) + 1,
            nextWakeAt: undefined,
            awaitingUpdate: false,
            lastUpdatedAt: result.run.stateEnteredAt,
          },
          workflow: result.run,
        };
        return { entry: terminalEntry, applied: true, terminal: result.terminal };
      }
      if (pausePolicy.resumeAfterStateLimitExit) {
        this.applyReducerEvent({
          type: "LOOP_RESUMED",
          at: now,
          source: "tool",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      return { entry: this.entries.get(id), applied: true };
    });
  }

  claimWorkflowExecution(
    id: string,
    actor: WorkflowRuntimeActor,
    leaseSeconds = 1800,
  ): { entry?: LoopEntry; claimed: boolean; error?: string } {
    const leaseMs = Math.min(Math.max(leaseSeconds, 60), 3600) * 1000;
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return { claimed: false, error: `Loop #${id} not found` };
      const now = Date.now();
      if (now >= entry.expiresAt || entry.pause?.reason === "loop expiry reached") {
        return { claimed: false, error: `Workflow #${id} has expired and cannot be claimed` };
      }
      const execution = entry.workflow?.activeExecution;
      if (execution?.status !== "active") {
        return { claimed: false, error: `Workflow #${id} has no active execution` };
      }
      const lease = execution.lease;
      const sameOwner = lease
        && lease.ownerSessionId === actor.sessionId
        && lease.ownerRuntimeId === actor.runtimeId;
      if (lease && lease.expiresAt > now && !sameOwner) {
        return { claimed: false, error: "Workflow execution is leased to another active runtime" };
      }
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_EXECUTION_CLAIMED",
        at: now,
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id, actor, leaseMs },
      });
      return { entry: this.entries.get(id), claimed: true };
    });
  }

  attachWorkflowMonitor(
    id: string,
    monitorId: string,
    expected: Pick<WorkflowMonitorWait, "stateId" | "transitionSeq"> & {
      definitionRevision: number;
      activeExecutionId?: string;
    },
    actor?: WorkflowRuntimeActor,
  ): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      const now = Date.now();
      if (!entry?.workflow || entry.status !== "active" || now >= entry.expiresAt || entry.workflow.waitingMonitor) return undefined;
      const execution = entry.workflow.activeExecution;
      const lease = execution?.lease;
      if (entry.workflow.currentState !== expected.stateId
        || entry.workflow.transitionSeq !== expected.transitionSeq
        || entry.workflow.definitionRevision !== expected.definitionRevision
        || execution?.id !== expected.activeExecutionId
        || (execution && (!lease || lease.expiresAt <= now
          || lease.ownerSessionId !== actor?.sessionId
          || lease.ownerRuntimeId !== actor?.runtimeId))) {
        return undefined;
      }
      const wait: WorkflowMonitorWait = {
        monitorId,
        stateId: expected.stateId,
        transitionSeq: expected.transitionSeq,
        attachedAt: now,
      };
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_MONITOR_ATTACHED",
        at: wait.attachedAt,
        source: "monitor",
        entityType: "loop",
        entityId: id,
        payload: { id, wait },
      });
      return this.entries.get(id);
    });
  }

  settleWorkflowMonitorWait(
    id: string,
    expected: WorkflowMonitorWait,
    now = Date.now(),
  ): WorkflowMonitorSettlement {
    return this.withLock(() => {
      const expired = this.expireEntryUnlocked(id, now);
      if (expired) return { kind: "expired", ...expired };
      const entry = this.entries.get(id);
      const wait = entry?.workflow?.waitingMonitor;
      if (!wait
        || wait.monitorId !== expected.monitorId
        || wait.stateId !== expected.stateId
        || wait.transitionSeq !== expected.transitionSeq
        || wait.attachedAt !== expected.attachedAt) return { kind: "stale" };
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_MONITOR_CLEARED",
        at: now,
        source: "monitor",
        entityType: "loop",
        entityId: id,
        payload: { id, expected },
      });
      return { kind: "resumed", entry: this.entries.get(id)! };
    });
  }

  completeWorkflowMonitorWait(id: string, expected: WorkflowMonitorWait): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      const wait = entry?.workflow?.waitingMonitor;
      if (!wait
        || wait.monitorId !== expected.monitorId
        || wait.stateId !== expected.stateId
        || wait.transitionSeq !== expected.transitionSeq
        || wait.attachedAt !== expected.attachedAt) return undefined;
      this.applyReducerEvent({
        type: "LOOP_WORKFLOW_MONITOR_CLEARED",
        at: Date.now(),
        source: "monitor",
        entityType: "loop",
        entityId: id,
        payload: { id, expected },
      });
      return this.entries.get(id);
    });
  }

  clearWorkflowMonitorWaits(): number {
    return this.withLock(() => {
      const waiting = Array.from(this.entries.values())
        .filter((entry) => entry.workflow?.waitingMonitor)
        .map((entry) => ({ id: entry.id, wait: entry.workflow!.waitingMonitor! }));
      for (const { id, wait } of waiting) {
        this.applyReducerEvent({
          type: "LOOP_WORKFLOW_MONITOR_CLEARED",
          at: Date.now(),
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, expected: wait },
        });
      }
      return waiting.length;
    });
  }

  getDeletionTombstone(id: string): LoopDeletionTombstone | undefined {
    const tombstone = this.tombstones.get(id);
    if (!tombstone) return undefined;
    if (Date.now() - tombstone.deletedAt <= TOMBSTONE_TTL_MS) return tombstone;
    this.tombstones.delete(id);
    return undefined;
  }

  recordDeletionTombstone(id: string, input: LoopDeletionTombstoneInput): LoopDeletionTombstone | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    const tombstone: LoopDeletionTombstone = {
      id,
      reason: input.reason,
      pendingCount: input.pendingCount,
      deletedAt: Date.now(),
      prompt: entry.prompt,
    };
    this.tombstones.set(id, tombstone);
    return tombstone;
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry || (entry.orchestration && hasUnconfirmedDispatches(entry.orchestration))) return false;
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  private expireEntryUnlocked(id: string, now: number): ExpiredLoopRecord | undefined {
    const entry = this.entries.get(id);
    if (!entry || now < entry.expiresAt) return undefined;
    if (
      entry.status === "paused"
      && entry.pause?.kind === "controller_limit"
      && entry.pause.reason === "loop expiry reached"
    ) return undefined;
    const disposition = entry.workflow || entry.orchestration || entry.taskBacklog ? "paused" : "deleted";
    this.applyReducerEvent(disposition === "paused"
      ? {
          type: "LOOP_PAUSED",
          at: now,
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id, kind: "controller_limit", reason: "loop expiry reached" },
        }
      : {
          type: "LOOP_EXPIRED",
          at: now,
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "expires_at" },
        });
    return { entry, disposition, reason: "expires_at" };
  }

  expireEntry(id: string, now = Date.now()): ExpiredLoopRecord | undefined {
    return this.withLock(() => this.expireEntryUnlocked(id, now));
  }

  expireEntries(now = Date.now()): ExpiredLoopRecord[] {
    return this.withLock(() => {
      const expired: ExpiredLoopRecord[] = [];
      for (const id of [...this.entries.keys()]) {
        const record = this.expireEntryUnlocked(id, now);
        if (record) expired.push(record);
      }
      return expired;
    });
  }

  clearExpired(): number {
    return this.expireEntries().length;
  }

  expireEventLoopEntries(sessionStartedAt: number): ExpiredLoopRecord[] {
    return this.withLock(() => {
      const expired: ExpiredLoopRecord[] = [];
      for (const [id, entry] of [...this.entries.entries()]) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") continue;
        const eventSource = entry.trigger.type === "event" ? entry.trigger.source : entry.trigger.event.source;
        if (entry.taskBacklog && eventSource === "tasks:created") continue;
        if (entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: sessionStartedAt,
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "resume_event_stale" },
        });
        expired.push({ entry, disposition: "deleted", reason: "resume_event_stale" });
      }
      return expired;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.expireEventLoopEntries(sessionStartedAt).length;
  }

  clearAll(options?: { preserveWorkflows?: boolean }): number {
    return this.withLock(() => {
      const entries = [...this.entries.values()];
      for (const entry of entries) {
        this.applyReducerEvent(options?.preserveWorkflows && entry.workflow
          ? {
              type: "LOOP_PAUSED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id, kind: "administrative", reason: "store cleared with workflow preservation" },
            }
          : {
              type: "LOOP_DELETED",
              at: Date.now(),
              source: "system",
              entityType: "loop",
              entityId: entry.id,
              payload: { id: entry.id },
            });
      }
      return entries.length;
    });
  }
}
