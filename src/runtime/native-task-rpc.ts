import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../task-store.js";
import type { TaskEntry, TaskStatus } from "../task-types.js";
import { emitNativeTaskEvent } from "./task-events.js";

interface RpcSuccess<T> {
  success: true;
  data: T;
}

interface RpcFailure {
  success: false;
  error: string;
}

interface RpcBaseRequest {
  requestId?: string;
}

interface CreateTaskRequest extends RpcBaseRequest {
  subject?: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface UpdateTaskRequest extends RpcBaseRequest {
  id?: string;
  status?: TaskStatus;
  subject?: string;
  description?: string;
}

export interface NativeTaskRpcOptions {
  pi: ExtensionAPI;
  getNativeTaskStore: () => TaskStore | undefined;
  evaluateTaskBacklog: (
    taskStore: TaskStore,
    pendingCount: number,
  ) => Promise<{ created: boolean; cleaned: number }>;
  updateWidget: () => void;
  debug?: (...args: unknown[]) => void;
}

function replySuccess<T>(
  pi: ExtensionAPI,
  channel: string,
  requestId: string,
  data: T,
): void {
  pi.events.emit(`${channel}:reply:${requestId}`, {
    success: true,
    data,
  } satisfies RpcSuccess<T>);
}

function replyFailure(
  pi: ExtensionAPI,
  channel: string,
  requestId: string,
  error: string,
): void {
  pi.events.emit(`${channel}:reply:${requestId}`, {
    success: false,
    error,
  } satisfies RpcFailure);
}

function updateTaskEntry(
  pi: ExtensionAPI,
  taskStore: TaskStore,
  request: UpdateTaskRequest,
): TaskEntry | undefined {
  const { id, status, subject, description } = request;
  if (!id) return undefined;

  let entry = taskStore.get(id);
  if (!entry) return undefined;

  const previousStatus = entry.status;
  if (status === "in_progress") {
    entry = taskStore.start(id);
    if (entry) emitNativeTaskEvent(pi, "tasks:started", entry, previousStatus);
  } else if (status === "completed") {
    entry = taskStore.complete(id);
    if (entry) emitNativeTaskEvent(pi, "tasks:completed", entry, previousStatus);
  } else if (status === "pending") {
    entry = taskStore.reopen(id);
    if (entry) emitNativeTaskEvent(pi, "tasks:reopened", entry, previousStatus);
  }

  if (!entry) return undefined;
  if (subject !== undefined || description !== undefined) {
    const detailPreviousStatus = entry.status;
    entry = taskStore.updateDetails(id, { subject, description });
    if (entry) {
      emitNativeTaskEvent(pi, "tasks:updated", entry, detailPreviousStatus);
    }
  }

  return entry;
}

export function registerNativeTaskRpc(options: NativeTaskRpcOptions): void {
  const { pi, getNativeTaskStore, evaluateTaskBacklog, updateWidget, debug } =
    options;

  pi.events.on("tasks:rpc:ping", (raw) => {
    const request = raw as RpcBaseRequest;
    const taskStore = getNativeTaskStore();
    if (!request.requestId || !taskStore) return;
    replySuccess(pi, "tasks:rpc:ping", request.requestId, { version: 1 });
  });

  pi.events.on("tasks:rpc:pending", (raw) => {
    const request = raw as RpcBaseRequest;
    const taskStore = getNativeTaskStore();
    if (!request.requestId || !taskStore) return;
    replySuccess(pi, "tasks:rpc:pending", request.requestId, {
      pending: taskStore.pendingCount(),
    });
  });

  pi.events.on("tasks:rpc:create", async (raw) => {
    const request = raw as CreateTaskRequest;
    const taskStore = getNativeTaskStore();
    if (!request.requestId || !taskStore) return;
    if (!request.subject || !request.description) {
      replyFailure(
        pi,
        "tasks:rpc:create",
        request.requestId,
        "subject and description are required",
      );
      return;
    }

    try {
      const task = taskStore.create(
        request.subject,
        request.description,
        request.metadata,
      );
      emitNativeTaskEvent(pi, "tasks:created", task);
      await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      updateWidget();
      replySuccess(pi, "tasks:rpc:create", request.requestId, {
        id: task.id,
        task,
      });
    } catch (error) {
      replyFailure(
        pi,
        "tasks:rpc:create",
        request.requestId,
        error instanceof Error ? error.message : String(error),
      );
    }
  });

  pi.events.on("tasks:rpc:clean", async (raw) => {
    const request = raw as RpcBaseRequest;
    const taskStore = getNativeTaskStore();
    if (!request.requestId || !taskStore) return;

    const pruned = taskStore.pruneCompleted();
    updateWidget();
    await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
    debug?.(`tasks:rpc:clean — pruned ${pruned} completed task(s)`);
    replySuccess(pi, "tasks:rpc:clean", request.requestId, { pruned });
  });

  pi.events.on("tasks:rpc:update", async (raw) => {
    const request = raw as UpdateTaskRequest;
    const taskStore = getNativeTaskStore();
    if (!request.requestId || !taskStore) return;
    if (!request.id) {
      replyFailure(pi, "tasks:rpc:update", request.requestId, "id is required");
      return;
    }

    const entry = updateTaskEntry(pi, taskStore, request);
    if (!entry) {
      replyFailure(
        pi,
        "tasks:rpc:update",
        request.requestId,
        `Task #${request.id} not found`,
      );
      return;
    }

    updateWidget();
    await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
    replySuccess(pi, "tasks:rpc:update", request.requestId, { task: entry });
  });
}
