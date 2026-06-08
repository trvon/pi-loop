import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { TaskStore } from "../task-store.js";
import type { LoopEntry } from "../types.js";

export interface TaskRuntimeBridgeOptions {
  pi: ExtensionAPI;
  isTasksAvailable: () => boolean;
  setTasksAvailable: (available: boolean) => void;
  getNativeTaskStore: () => TaskStore | undefined;
  onNativeTaskCreated?: (taskStore: TaskStore) => void;
  onNativeTasksPruned?: (taskStore: TaskStore) => Promise<void> | void;
  debug?: (...args: unknown[]) => void;
}

export interface TaskRuntimeBridge {
  checkTasksVersion(): void;
  autoCreateTask(entry: LoopEntry): Promise<string | undefined>;
  hasPendingTasks(): Promise<number>;
  cleanDoneTasks(): Promise<void>;
}

export function createTaskRuntimeBridge(options: TaskRuntimeBridgeOptions): TaskRuntimeBridge {
  const {
    pi,
    isTasksAvailable,
    setTasksAvailable,
    getNativeTaskStore,
    onNativeTaskCreated,
    onNativeTasksPruned,
    debug,
  } = options;

  function checkTasksVersion() {
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      unsub();
    }, 5000);
    const unsub = pi.events.on(`tasks:rpc:ping:reply:${requestId}`, (raw: unknown) => {
      unsub();
      clearTimeout(timer);
      const remoteVersion = (raw as { data?: { version?: number } })?.data?.version;
      if (remoteVersion !== undefined) setTasksAvailable(true);
    });
    pi.events.emit("tasks:rpc:ping", { requestId });
  }

  async function autoCreateTask(entry: LoopEntry): Promise<string | undefined> {
    if (!entry.autoTask) return undefined;
    if (isTasksAvailable()) {
      try {
        const requestId = randomUUID();
        const taskId = await new Promise<string | undefined>((resolve) => {
          const timer = setTimeout(() => {
            unsub();
            resolve(undefined);
          }, 5000);
          const unsub = pi.events.on(`tasks:rpc:create:reply:${requestId}`, (raw: unknown) => {
            unsub();
            clearTimeout(timer);
            const reply = raw as { success: boolean; data?: { id: string } };
            if (reply.success && reply.data) resolve(reply.data.id);
            else resolve(undefined);
          });
          pi.events.emit("tasks:rpc:create", {
            requestId,
            subject: entry.prompt.slice(0, 80),
            description: `Auto-created from loop #${entry.id}`,
            metadata: { loopId: entry.id, trigger: entry.trigger },
          });
        });
        return taskId;
      } catch {
        return undefined;
      }
    }

    const nativeTaskStore = getNativeTaskStore();
    if (!nativeTaskStore) return undefined;
    const task = nativeTaskStore.create(
      entry.prompt.slice(0, 80),
      `Auto-created from loop #${entry.id}`,
      { loopId: entry.id, trigger: entry.trigger },
    );
    onNativeTaskCreated?.(nativeTaskStore);
    return task.id;
  }

  async function hasPendingTasks(): Promise<number> {
    if (isTasksAvailable()) {
      try {
        const requestId = randomUUID();
        const count = await new Promise<number>((resolve) => {
          const timer = setTimeout(() => {
            unsub();
            resolve(-1);
          }, 3000);
          const unsub = pi.events.on(`tasks:rpc:pending:reply:${requestId}`, (raw: unknown) => {
            unsub();
            clearTimeout(timer);
            const reply = raw as { success: boolean; data?: { pending: number } };
            resolve(reply.success && reply.data ? reply.data.pending : -1);
          });
          pi.events.emit("tasks:rpc:pending", { requestId });
        });
        return count;
      } catch {
        return -1;
      }
    }

    return getNativeTaskStore()?.pendingCount() ?? -1;
  }

  async function cleanDoneTasks(): Promise<void> {
    if (isTasksAvailable()) {
      try {
        const requestId = randomUUID();
        await new Promise<void>((resolve) => {
          const timer = setTimeout(() => {
            unsub();
            resolve();
          }, 3000);
          const unsub = pi.events.on(`tasks:rpc:clean:reply:${requestId}`, () => {
            unsub();
            clearTimeout(timer);
            debug?.("tasks:rpc:clean — done tasks swept");
            resolve();
          });
          pi.events.emit("tasks:rpc:clean", { requestId });
        });
      } catch {
        // timeout or error, ignore
      }
      return;
    }

    const nativeTaskStore = getNativeTaskStore();
    if (!nativeTaskStore) return;
    nativeTaskStore.pruneCompleted();
    await onNativeTasksPruned?.(nativeTaskStore);
  }

  return {
    checkTasksVersion,
    autoCreateTask,
    hasPendingTasks,
    cleanDoneTasks,
  };
}
