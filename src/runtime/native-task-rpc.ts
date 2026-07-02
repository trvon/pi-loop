import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CleanReply,
  type CreateTaskReply,
  type PendingReply,
  type PingReply,
  TASKS_RPC,
  type UpdateTaskReply,
} from "../rpc/channels.js";
import { handleRpc, PROTOCOL_VERSION } from "../rpc/cross-extension-rpc.js";
import type { TaskStore } from "../task-store.js";
import type { TaskStatus } from "../task-types.js";
import {
  cleanTasks,
  createTask,
  type TaskBacklogResult,
  type TaskMutationContext,
  updateTask,
} from "./task-mutations.js";

/** Discriminates pi-loop's own ping replies from an external pi-tasks provider. */
export const NATIVE_TASKS_PROVIDER = "pi-loop-native";

interface CreateTaskRequest {
  requestId: string;
  subject?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateTaskRequest {
  requestId: string;
  id?: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
}

export interface NativeTaskRpcOptions {
  pi: ExtensionAPI;
  getNativeTaskStore: () => TaskStore | undefined;
  /** Stands the server down (silent no-op) when an external pi-tasks owns the channels. */
  isEnabled?: () => boolean;
  /**
   * Gates the mutating/reading verbs (create/update/pending/clean) until the
   * pi-tasks detection probe has settled. Ping stays answerable throughout so
   * providers remain discoverable, but no state diverges while an external
   * provider might still claim the channels. Defaults to settled.
   */
  isDetectionSettled?: () => boolean;
  evaluateTaskBacklog: (
    taskStore: TaskStore,
    pendingCount: number,
  ) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
  debug?: (...args: unknown[]) => void;
}

export function registerNativeTaskRpc(options: NativeTaskRpcOptions): void {
  const {
    pi,
    getNativeTaskStore,
    isEnabled,
    isDetectionSettled,
    evaluateTaskBacklog,
    updateWidget,
    debug,
  } = options;
  const rpcOpts = { enabled: isEnabled, debug };
  const settledRpcOpts = {
    enabled: () => (isEnabled ? isEnabled() : true) && (isDetectionSettled ? isDetectionSettled() : true),
    debug,
  };

  function requireMutationContext(): TaskMutationContext {
    const taskStore = getNativeTaskStore();
    if (!taskStore) throw new Error("native task store unavailable");
    return { pi, taskStore, evaluateTaskBacklog, updateWidget };
  }

  handleRpc<{ requestId: string }, PingReply>(
    pi.events,
    TASKS_RPC.ping,
    () => ({ version: PROTOCOL_VERSION, provider: NATIVE_TASKS_PROVIDER }),
    rpcOpts,
  );

  handleRpc<{ requestId: string }, PendingReply>(
    pi.events,
    TASKS_RPC.pending,
    () => ({ pending: requireMutationContext().taskStore.pendingCount() }),
    settledRpcOpts,
  );

  handleRpc<CreateTaskRequest, CreateTaskReply>(
    pi.events,
    TASKS_RPC.create,
    async (request) => {
      if (!request.subject || !request.description) {
        throw new Error("subject and description are required");
      }
      const { entry } = await createTask(requireMutationContext(), {
        subject: request.subject,
        description: request.description,
        metadata: request.metadata,
      });
      return { id: entry.id, task: entry };
    },
    settledRpcOpts,
  );

  handleRpc<{ requestId: string }, CleanReply>(
    pi.events,
    TASKS_RPC.clean,
    async () => {
      const pruned = await cleanTasks(requireMutationContext());
      debug?.(`${TASKS_RPC.clean} — pruned ${pruned} completed task(s)`);
      return { pruned };
    },
    settledRpcOpts,
  );

  handleRpc<UpdateTaskRequest, UpdateTaskReply>(
    pi.events,
    TASKS_RPC.update,
    async (request) => {
      if (!request.id) throw new Error("id is required");
      const result = await updateTask(requireMutationContext(), {
        id: request.id,
        status: request.status,
        subject: request.subject,
        description: request.description,
      });
      if (!result) throw new Error(`Task #${request.id} not found`);
      return { task: result.entry };
    },
    settledRpcOpts,
  );
}
