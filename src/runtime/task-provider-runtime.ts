import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerTasksCommand } from "../commands/tasks-command.js";
import { TaskStore } from "../task-store.js";
import { registerNativeTaskTools } from "../tools/native-task-tools.js";
import { registerNativeTaskRpc } from "./native-task-rpc.js";
import type { TaskBacklogResult } from "./task-mutations.js";
import { createTaskRuntimeBridge } from "./task-rpc.js";

export interface TaskProviderSummary {
  count: number;
  focusText?: string;
}

export interface TaskProviderRuntimeOptions {
  pi: ExtensionAPI;
  runtimeId: string;
  resolveStorePath: () => string | undefined;
  getSessionId: () => string | undefined;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  onReady?: (detectionGeneration?: number) => Promise<void> | void;
  getSessionGeneration?: () => number;
  updateWidget: () => void;
  isStaleExtensionContextError: (error: unknown) => boolean;
  debug?: (...args: unknown[]) => void;
  fallbackDelayMs?: number;
}

export interface TaskProviderRuntime {
  autoCreateTask: ReturnType<typeof createTaskRuntimeBridge>["autoCreateTask"];
  hasPendingTasks: ReturnType<typeof createTaskRuntimeBridge>["hasPendingTasks"];
  cleanDoneTasks: ReturnType<typeof createTaskRuntimeBridge>["cleanDoneTasks"];
  isReady(): boolean;
  summary(): TaskProviderSummary;
  getNativeTaskStore(): TaskStore | undefined;
}

export function createTaskProviderRuntime(options: TaskProviderRuntimeOptions): TaskProviderRuntime {
  const {
    pi,
    runtimeId,
    resolveStorePath,
    getSessionId,
    evaluateTaskBacklog,
    onReady,
    getSessionGeneration,
    updateWidget,
    isStaleExtensionContextError,
    debug,
    fallbackDelayMs = 6_000,
  } = options;

  let tasksAvailable = false;
  let detectionSettled = false;
  let nativeTaskStore: TaskStore | undefined;
  const nativeTaskStores = new Map<string, TaskStore>();
  let nativeToolsRegistered = false;
  let readyNotified = false;
  let detectionGeneration = getSessionGeneration?.();

  function notifyReady(): void {
    if (readyNotified) return;
    readyNotified = true;
    Promise.resolve()
      .then(() => onReady?.(detectionGeneration))
      .catch((error) => debug?.("task provider ready callback failed", error));
  }

  function getOrCreateNativeTaskStore(): TaskStore | undefined {
    if (tasksAvailable) return undefined;
    const storePath = resolveStorePath();
    const storeKey = storePath ?? `memory:${getSessionId() ?? "unbound"}`;
    let taskStore = nativeTaskStores.get(storeKey);
    if (!taskStore) {
      taskStore = new TaskStore(storePath);
      nativeTaskStores.set(storeKey, taskStore);
    }
    nativeTaskStore = taskStore;
    return taskStore;
  }

  const bridge = createTaskRuntimeBridge({
    pi,
    isTasksAvailable: () => tasksAvailable,
    setTasksAvailable: (available) => {
      if (available && !nativeToolsRegistered) {
        tasksAvailable = true;
        notifyReady();
      }
    },
    getNativeTaskStore: () => nativeTaskStore ? getOrCreateNativeTaskStore() : undefined,
    onNativeTaskCreated: updateWidget,
    onNativeTasksPruned: async (taskStore) => {
      updateWidget();
      await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
    },
    onDetectionStarted: () => {
      detectionSettled = false;
      detectionGeneration = getSessionGeneration?.();
    },
    onDetectionSettled: () => {
      detectionSettled = true;
    },
    debug,
  });

  registerNativeTaskRpc({
    pi,
    getNativeTaskStore: getOrCreateNativeTaskStore,
    isEnabled: () => !tasksAvailable,
    isDetectionSettled: () => detectionSettled,
    evaluateTaskBacklog,
    updateWidget,
    debug,
  });

  bridge.checkTasksVersion();
  pi.events.on("tasks:ready", () => {
    if (!nativeToolsRegistered) bridge.checkTasksVersion();
  });

  const fallbackTimer = setTimeout(() => {
    if (tasksAvailable || nativeToolsRegistered) return;
    const taskStore = getOrCreateNativeTaskStore();
    if (!taskStore) return;

    try {
      registerTasksCommand({
        pi,
        getNativeTaskStore: getOrCreateNativeTaskStore,
        evaluateTaskBacklog,
        updateWidget,
      });
      registerNativeTaskTools({
        pi,
        getTaskStore: () => getOrCreateNativeTaskStore() ?? taskStore,
        evaluateTaskBacklog,
        getTaskOwner: () => ({
          sessionId: getSessionId() ?? "unbound",
          runtimeId,
        }),
        updateWidget,
      });
    } catch (error) {
      if (isStaleExtensionContextError(error)) {
        debug?.("native task fallback skipped: extension context went stale");
        return;
      }
      throw error;
    }

    nativeToolsRegistered = true;
    notifyReady();
    debug?.("native task tools registered (pi-tasks not detected)");
  }, fallbackDelayMs);

  pi.on("session_shutdown", () => {
    clearTimeout(fallbackTimer);
  });

  function summary(): TaskProviderSummary {
    if (tasksAvailable || !nativeTaskStore) return { count: 0 };
    const taskStore = getOrCreateNativeTaskStore();
    if (!taskStore) return { count: 0 };
    let count = 0;
    let activeSubject: string | undefined;
    let nextSubject: string | undefined;
    for (const task of taskStore.list()) {
      if (task.status === "in_progress") {
        count++;
        activeSubject ??= task.subject;
      } else if (task.status === "pending") {
        count++;
        nextSubject ??= task.subject;
      }
    }
    const focusText = activeSubject
      ? `active: ${activeSubject.slice(0, 50)}`
      : nextSubject
        ? `next: ${nextSubject.slice(0, 50)}`
        : undefined;
    return { count, focusText };
  }

  return {
    autoCreateTask: bridge.autoCreateTask,
    hasPendingTasks: bridge.hasPendingTasks,
    cleanDoneTasks: bridge.cleanDoneTasks,
    isReady: () => tasksAvailable || nativeToolsRegistered,
    summary,
    getNativeTaskStore: () => getOrCreateNativeTaskStore(),
  };
}
