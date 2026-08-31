import { applyOrchestrationEvent, createOrchestrationState, type OrchestrationEvent } from "./orchestration-reducer.js";
import type { DynamicLoopState, LoopEntry, LoopFireOrigin, LoopPauseKind, OrchestrationActor, OrchestrationDefinitionInput, Trigger, WorkflowAdmissionRecord, WorkflowDefinition, WorkflowMonitorWait, WorkflowRevisionChange, WorkflowRuntimeActor } from "./types.js";
import { createWorkflowRun, transitionWorkflowRun } from "./workflow-reducer.js";
import { reviseWorkflowRun, type WorkflowRevisionSummary } from "./workflow-revision.js";

export const MAX_LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Whether a loop has reached its fire cap. Single source of truth for the
 * `maxFires` check shared by the fire callbacks (`onLoopFire` pre-fire guard and
 * `TriggerSystem.fireLoop` post-fire cleanup). Each caller keeps its own timing;
 * only the predicate is shared.
 */
export function atMaxFires(loop: Pick<LoopEntry, "maxFires" | "fireCount">): boolean {
  return !!loop.maxFires && (loop.fireCount ?? 0) >= loop.maxFires;
}

type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export interface LoopReducerState {
  nextId: number;
  loopsById: Record<string, LoopEntry>;
}

export type LoopReducerEvent =
  | {
    type: "LOOP_CREATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      prompt: string;
      trigger: Trigger;
      recurring: boolean;
      autoTask?: boolean;
      taskBacklog?: boolean;
      readOnly?: boolean;
      maxFires?: number;
      dynamic?: Partial<DynamicLoopState>;
      workflow?: WorkflowDefinition;
      actor?: WorkflowRuntimeActor;
      orchestration?: { definition: OrchestrationDefinitionInput; owner: OrchestrationActor };
    };
  }
  | {
    type: "LOOP_PAUSED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; kind: LoopPauseKind; reason?: string };
  }
  | {
    type:
      | "LOOP_RESUMED"
      | "LOOP_FIRED"
      | "LOOP_DELETED"
      | "LOOP_MAX_FIRES_REACHED"
      | "LOOP_BACKLOG_EMPTY";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; origin?: LoopFireOrigin };
  }
  | {
    type: "LOOP_EXPIRED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      reason: "expires_at" | "resume_event_stale" | "already_completed_monitor";
    };
  }
  | {
    type: "LOOP_DYNAMIC_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      prompt?: string;
      dynamic: Partial<DynamicLoopState>;
    };
  }
  | {
    type: "LOOP_ORCHESTRATION_MUTATED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; event: OrchestrationEvent };
  }
  | {
    type: "LOOP_WORKFLOW_REVISED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      expectedRevision: number;
      expectedState: string;
      expectedTransitionSeq: number;
      reason: string;
      changes: WorkflowRevisionChange[];
      actor: WorkflowRuntimeActor;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TRANSITION";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      outcome: string;
      evidence?: string;
      admission?: WorkflowAdmissionRecord;
      actor?: WorkflowRuntimeActor;
    };
  }
  | {
    type: "LOOP_WORKFLOW_TERMINAL_TRANSITION";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: {
      id: string;
      outcome: string;
      evidence?: string;
      admission?: WorkflowAdmissionRecord;
      actor?: WorkflowRuntimeActor;
      terminal: "completed" | "paused";
    };
  }
  | {
    type: "LOOP_WORKFLOW_EXECUTION_CLAIMED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; actor: WorkflowRuntimeActor; leaseMs: number };
  }
  | {
    type: "LOOP_WORKFLOW_MONITOR_ATTACHED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; wait: WorkflowMonitorWait };
  }
  | {
    type: "LOOP_WORKFLOW_MONITOR_CLEARED";
    at: number;
    source: ReducerSource;
    entityType?: "loop";
    entityId?: string;
    payload: { id: string; expected?: WorkflowMonitorWait };
  };

interface PersistLoopPayload {
  loop: LoopEntry;
  workflowRevision?: WorkflowRevisionSummary;
}

export type LoopReducerEffect =
  | {
    type: "PERSIST_LOOP";
    entityType: "loop";
    entityId: string;
    payload: PersistLoopPayload;
  }
  | {
    type: "WORKFLOW_REVISION_REJECTED";
    entityType: "loop";
    entityId: string;
    payload: { error: string; failure: import("./types.js").WorkflowRevisionFailure };
  }
  | {
    type: "DELETE_LOOP";
    entityType: "loop";
    entityId: string;
    payload: { id: string };
  };

export interface LoopReduceResult {
  state: LoopReducerState;
  effects: LoopReducerEffect[];
}

function cloneState(state: LoopReducerState): LoopReducerState {
  return {
    nextId: state.nextId,
    loopsById: { ...state.loopsById },
  };
}

export function reduceLoopState(state: LoopReducerState, event: LoopReducerEvent): LoopReduceResult {
  if (event.type === "LOOP_CREATED") {
    const next = cloneState(state);
    const id = String(next.nextId++);
    const loop: LoopEntry = {
      id,
      prompt: event.payload.prompt,
      trigger: event.payload.trigger,
      status: "active",
      recurring: event.payload.recurring,
      createdAt: event.at,
      updatedAt: event.at,
      expiresAt: event.at + MAX_LOOP_EXPIRY_MS,
      autoTask: event.payload.autoTask,
      taskBacklog: event.payload.taskBacklog,
      readOnly: event.payload.readOnly,
      maxFires: event.payload.maxFires,
      fireCount: 0,
      dynamic: event.payload.trigger.type === "dynamic" || event.payload.dynamic
        ? {
            goal: event.payload.dynamic?.goal ?? event.payload.prompt,
            state: event.payload.dynamic?.state,
            metrics: event.payload.dynamic?.metrics,
            doneCriteria: event.payload.dynamic?.doneCriteria,
            iteration: event.payload.dynamic?.iteration ?? 0,
            nextWakeAt: event.payload.dynamic?.nextWakeAt,
            awaitingUpdate: event.payload.dynamic?.awaitingUpdate ?? false,
            lastUpdatedAt: event.payload.dynamic?.lastUpdatedAt ?? event.at,
          }
        : undefined,
      workflow: event.payload.workflow ? createWorkflowRun(event.payload.workflow, event.at, event.payload.actor) : undefined,
      orchestration: event.payload.orchestration
        ? createOrchestrationState(event.payload.orchestration.definition, event.payload.orchestration.owner, event.at)
        : undefined,
    };
    next.loopsById[id] = loop;
    return {
      state: next,
      effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload: { loop } }],
    };
  }

  const id = event.payload.id;
  const current = state.loopsById[id];
  if (!current) return { state, effects: [] };

  if (
    event.type === "LOOP_DELETED"
    || event.type === "LOOP_MAX_FIRES_REACHED"
    || event.type === "LOOP_EXPIRED"
    || event.type === "LOOP_BACKLOG_EMPTY"
  ) {
    const next = cloneState(state);
    delete next.loopsById[id];
    return {
      state: next,
      effects: [{ type: "DELETE_LOOP", entityType: "loop", entityId: id, payload: { id } }],
    };
  }

  const next = cloneState(state);
  const loop: LoopEntry = { ...current };
  let workflowRevision: WorkflowRevisionSummary | undefined;

  if (event.type === "LOOP_PAUSED") {
    loop.status = "paused";
    loop.pause = { kind: event.payload.kind, at: event.at, ...(event.payload.reason ? { reason: event.payload.reason } : {}) };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_RESUMED") {
    loop.status = "active";
    loop.pause = undefined;
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_FIRED") {
    loop.fireCount = (loop.fireCount ?? 0) + 1;
    if (loop.workflow && event.payload.origin === "scheduler") {
      const stateId = loop.workflow.currentState;
      loop.workflow = {
        ...loop.workflow,
        stateFireCounts: {
          ...(loop.workflow.stateFireCounts ?? {}),
          [stateId]: (loop.workflow.stateFireCounts?.[stateId] ?? 0) + 1,
        },
      };
    }
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_DYNAMIC_UPDATED") {
    loop.prompt = event.payload.prompt ?? loop.prompt;
    loop.dynamic = {
      goal: event.payload.dynamic.goal ?? loop.dynamic?.goal ?? loop.prompt,
      state: event.payload.dynamic.state ?? loop.dynamic?.state,
      metrics: event.payload.dynamic.metrics ?? loop.dynamic?.metrics,
      doneCriteria: event.payload.dynamic.doneCriteria ?? loop.dynamic?.doneCriteria,
      iteration: event.payload.dynamic.iteration ?? loop.dynamic?.iteration ?? 0,
      nextWakeAt: "nextWakeAt" in event.payload.dynamic ? event.payload.dynamic.nextWakeAt : loop.dynamic?.nextWakeAt,
      awaitingUpdate: event.payload.dynamic.awaitingUpdate ?? loop.dynamic?.awaitingUpdate ?? false,
      lastUpdatedAt: event.payload.dynamic.lastUpdatedAt ?? event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_ORCHESTRATION_MUTATED") {
    if (!loop.orchestration) return { state, effects: [] };
    const result = applyOrchestrationEvent(loop.orchestration, event.payload.event);
    if (!result.applied) return { state, effects: [] };
    loop.orchestration = result.state;
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_REVISED") {
    if (!loop.workflow) return { state, effects: [] };
    const currentWorkflowState = loop.workflow.definition.states[loop.workflow.currentState];
    const reissuesCurrentState = event.payload.changes.some((change) => change.op === "reissue_state");
    if (
      loop.status === "paused"
      && loop.pause?.kind !== "administrative"
      && !currentWorkflowState?.terminal
      && reissuesCurrentState
    ) {
      const message = "This paused workflow cannot replace current work; inspect its pause provenance before choosing a new controller.";
      return {
        state,
        effects: [{
          type: "WORKFLOW_REVISION_REJECTED",
          entityType: "loop",
          entityId: id,
          payload: { error: message, failure: { code: "workflow_paused", message } },
        }],
      };
    }
    const result = reviseWorkflowRun(loop.workflow, {
      expectedRevision: event.payload.expectedRevision,
      expectedState: event.payload.expectedState,
      expectedTransitionSeq: event.payload.expectedTransitionSeq,
      reason: event.payload.reason,
      changes: event.payload.changes,
      actor: event.payload.actor,
    }, event.at);
    if (!result.applied) {
      return {
        state,
        effects: [{
          type: "WORKFLOW_REVISION_REJECTED",
          entityType: "loop",
          entityId: id,
          payload: { error: result.error, failure: result.failure },
        }],
      };
    }
    loop.workflow = result.run;
    loop.updatedAt = event.at;
    workflowRevision = result.summary;
  }

  if (event.type === "LOOP_WORKFLOW_TRANSITION") {
    if (!loop.workflow) return { state, effects: [] };
    const result = transitionWorkflowRun(loop.workflow, {
      outcome: event.payload.outcome,
      evidence: event.payload.evidence,
      admission: event.payload.admission,
      actor: event.payload.actor,
    }, event.at);
    if (!result.applied) return { state, effects: [] };
    loop.workflow = result.run;
    loop.dynamic = {
      goal: loop.dynamic?.goal ?? loop.prompt,
      state: result.run.currentState,
      metrics: loop.dynamic?.metrics,
      doneCriteria: loop.dynamic?.doneCriteria,
      iteration: (loop.dynamic?.iteration ?? 0) + 1,
      nextWakeAt: undefined,
      awaitingUpdate: false,
      lastUpdatedAt: event.at,
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_TERMINAL_TRANSITION") {
    if (!loop.workflow) return { state, effects: [] };
    const result = transitionWorkflowRun(loop.workflow, {
      outcome: event.payload.outcome,
      evidence: event.payload.evidence,
      admission: event.payload.admission,
      actor: event.payload.actor,
    }, event.at);
    if (!result.applied || result.terminal !== event.payload.terminal) return { state, effects: [] };
    if (event.payload.terminal === "completed") {
      const next = cloneState(state);
      delete next.loopsById[id];
      return {
        state: next,
        effects: [{ type: "DELETE_LOOP", entityType: "loop", entityId: id, payload: { id } }],
      };
    }
    loop.workflow = result.run;
    loop.dynamic = {
      goal: loop.dynamic?.goal ?? loop.prompt,
      state: result.run.currentState,
      metrics: loop.dynamic?.metrics,
      doneCriteria: loop.dynamic?.doneCriteria,
      iteration: (loop.dynamic?.iteration ?? 0) + 1,
      nextWakeAt: undefined,
      awaitingUpdate: false,
      lastUpdatedAt: event.at,
    };
    loop.status = "paused";
    loop.pause = { kind: "semantic_terminal", at: event.at };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_EXECUTION_CLAIMED") {
    const execution = loop.workflow?.activeExecution;
    if (execution?.status !== "active") return { state, effects: [] };
    const lease = execution.lease;
    const sameOwner = lease
      && lease.ownerSessionId === event.payload.actor.sessionId
      && lease.ownerRuntimeId === event.payload.actor.runtimeId;
    if (lease && lease.expiresAt > event.at && !sameOwner) return { state, effects: [] };
    loop.workflow = {
      ...loop.workflow!,
      activeExecution: {
        ...execution,
        updatedAt: event.at,
        lease: {
          ownerSessionId: event.payload.actor.sessionId,
          ownerRuntimeId: event.payload.actor.runtimeId,
          acquiredAt: sameOwner ? lease.acquiredAt : event.at,
          heartbeatAt: event.at,
          expiresAt: event.at + event.payload.leaseMs,
          attempt: sameOwner ? lease.attempt : (lease?.attempt ?? 0) + 1,
        },
      },
    };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_MONITOR_ATTACHED") {
    if (!loop.workflow || loop.workflow.waitingMonitor) return { state, effects: [] };
    loop.workflow = { ...loop.workflow, waitingMonitor: event.payload.wait };
    loop.updatedAt = event.at;
  }

  if (event.type === "LOOP_WORKFLOW_MONITOR_CLEARED") {
    if (!loop.workflow?.waitingMonitor) return { state, effects: [] };
    const expected = event.payload.expected;
    if (expected && (
      loop.workflow.waitingMonitor.monitorId !== expected.monitorId
      || loop.workflow.waitingMonitor.stateId !== expected.stateId
      || loop.workflow.waitingMonitor.transitionSeq !== expected.transitionSeq
      || loop.workflow.waitingMonitor.attachedAt !== expected.attachedAt
    )) return { state, effects: [] };
    loop.workflow = { ...loop.workflow, waitingMonitor: undefined };
    loop.updatedAt = event.at;
  }

  next.loopsById[id] = loop;
  const payload: PersistLoopPayload = { loop };
  if (workflowRevision) payload.workflowRevision = workflowRevision;
  return {
    state: next,
    effects: [{ type: "PERSIST_LOOP", entityType: "loop", entityId: id, payload }],
  };
}
