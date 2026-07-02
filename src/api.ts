/**
 * Public API surface for sibling extensions (imported as
 * `@trevonistrevon/pi-loop/api`). Everything else under src/ is internal —
 * the package `exports` map deliberately blocks deep imports.
 */
export {
  type CleanReply,
  type CreateTaskParams,
  type CreateTaskReply,
  type PendingReply,
  type PingReply,
  replyChannel,
  type SpawnParams,
  type SpawnReply,
  SUBAGENTS_RPC,
  TASK_EVENTS,
  TASKS_RPC,
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
export { NATIVE_TASKS_PROVIDER } from "./runtime/native-task-rpc.js";
export { resolveLoopStorePath, resolveTaskStorePath } from "./runtime/scope.js";
export { TaskStore } from "./task-store.js";
export type { TaskEntry, TaskStatus, TaskStoreData } from "./task-types.js";
