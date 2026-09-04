/**
 * Public API surface for sibling extensions (imported as
 * `@trevonistrevon/pi-loop/api`). Everything else under src/ is internal —
 * the package `exports` map deliberately blocks deep imports.
 */

export { DEFAULT_LOOP_EXPIRY_MS, expiresAtFromDuration, parseLoopDurationMs, resolveDefaultLoopExpiryMs } from "./loop-expiry.js";
export {
  type ClaimTaskParams,
  type ClaimTaskReply,
  type CleanReply,
  type CreateTaskParams,
  type CreateTaskReply,
  type HeartbeatTaskParams,
  type HeartbeatTaskReply,
  type PendingReply,
  type PingReply,
  replyChannel,
  type SpawnParams,
  type SpawnReply,
  SUBAGENTS_RPC,
  TASK_EVENTS,
  TASKS_RPC,
  type TaskClaimWire,
  type TaskEntryWire,
  type TaskStatusWire,
  type UpdateTaskParams,
  type UpdateTaskReply,
} from "./rpc/channels.js";
export {
  type HandleRpcOptions,
  handleRpc,
  PROTOCOL_VERSION,
  RpcError,
  type RpcEventBus,
  type RpcReply,
  rpcCall,
  rpcProbe,
} from "./rpc/cross-extension-rpc.js";
export type { LoopExpiredPayload } from "./runtime/loop-events.js";
export { NATIVE_TASKS_PROVIDER } from "./runtime/native-task-rpc.js";
export { resolveLoopStorePath, resolveTaskStorePath } from "./runtime/scope.js";
export type { TaskClaimInput, TaskClaimResult } from "./task-store.js";
export { TaskStore } from "./task-store.js";
export type { TaskClaim, TaskEntry, TaskStatus, TaskStoreData } from "./task-types.js";
export type {
  LoopExpiryDisposition,
  LoopExpiryReason,
  LoopExpirySource,
  LoopPauseKind,
  LoopPauseRecord,
  MonitorOutcome,
  OrchestrationActor,
  OrchestrationConsumeStatus,
  OrchestrationDefinitionInput,
  OrchestrationDispatch,
  OrchestrationDispatchStatus,
  OrchestrationOwner,
  OrchestrationPendingWake,
  OrchestrationState,
  OrchestrationStatus,
  OrchestrationUsage,
  OrchestrationWakeReason,
  OrchestrationWorkItem,
  OrchestrationWorkStatus,
  WorkflowAdmissionRecord,
  WorkflowDefinition,
  WorkflowDefinitionRevision,
  WorkflowMonitorWait,
  WorkflowRevisionChange,
  WorkflowRevisionFailure,
  WorkflowRevisionFailureCode,
  WorkflowRunState,
  WorkflowStateDefinition,
  WorkflowStateLoopDefinition,
  WorkflowTaskDefinition,
  WorkflowTerminalStatus,
  WorkflowTransitionRecord,
} from "./types.js";
export type { WorkflowRevisionInput, WorkflowRevisionResult, WorkflowRevisionSummary } from "./workflow-revision.js";
