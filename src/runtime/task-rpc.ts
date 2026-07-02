import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type CleanReply,
  type CreateTaskReply,
  type PendingReply,
  type PingReply,
  replyChannel,
  TASKS_RPC,
} from "../rpc/channels.js";
import { type RpcReply, rpcCall } from "../rpc/cross-extension-rpc.js";
import type { TaskStore } from "../task-store.js";
import type { LoopEntry } from "../types.js";
import { NATIVE_TASKS_PROVIDER } from "./native-task-rpc.js";
import { emitNativeTaskEvent } from "./task-events.js";

export interface TaskRuntimeBridgeOptions {
  pi: ExtensionAPI;
  isTasksAvailable: () => boolean;
  setTasksAvailable: (available: boolean) => void;
  getNativeTaskStore: () => TaskStore | undefined;
  onNativeTaskCreated?: (taskStore: TaskStore) => void;
  onNativeTasksPruned?: (taskStore: TaskStore) => Promise<void> | void;
  /** Called when a detection window opens. */
  onDetectionStarted?: () => void;
  /** Called when a detection window closes (provider found or probe timed out). */
  onDetectionSettled?: () => void;
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
    onDetectionStarted,
    onDetectionSettled,
    debug,
  } = options;
  let detectionEpoch = 0;

  function checkTasksVersion() {
    // Not rpcProbe: pi-loop's own native server also answers this ping, and a
    // first-reply-wins probe would always settle on that self-reply. Keep the
    // listener open for the whole window and skip self-replies so a slower
    // external provider (pi-tasks) is still detected.
    const epoch = ++detectionEpoch;
    onDetectionStarted?.();
    const settleCurrentDetection = () => {
      if (epoch !== detectionEpoch) return;
      onDetectionSettled?.();
    };
    const requestId = randomUUID();
    const timer = setTimeout(() => {
      unsub();
      settleCurrentDetection();
    }, 5000);
    const unsub = pi.events.on(replyChannel(TASKS_RPC.ping, requestId), (raw: unknown) => {
      const reply = raw as RpcReply<PingReply> | undefined;
      if (!reply?.success || !reply.data) return;
      if (reply.data.provider === NATIVE_TASKS_PROVIDER) return;
      if (reply.data.version === undefined) return;
      unsub();
      clearTimeout(timer);
      setTasksAvailable(true);
      settleCurrentDetection();
    });
    pi.events.emit(TASKS_RPC.ping, { requestId });
  }

  async function autoCreateTask(entry: LoopEntry): Promise<string | undefined> {
    if (!entry.autoTask) return undefined;
    if (isTasksAvailable()) {
      try {
        const reply = await rpcCall<CreateTaskReply>(pi.events, TASKS_RPC.create, {
          subject: entry.prompt.slice(0, 80),
          description: `Auto-created from loop #${entry.id}`,
          metadata: { loopId: entry.id, trigger: entry.trigger },
        }, 5000);
        return reply.id;
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
    emitNativeTaskEvent(pi, "tasks:created", task);
    onNativeTaskCreated?.(nativeTaskStore);
    return task.id;
  }

  async function hasPendingTasks(): Promise<number> {
    if (isTasksAvailable()) {
      // -1 is this bridge's "unknown" sentinel, consumed by notification-runtime;
      // the RPC layer itself rejects on failure.
      try {
        const reply = await rpcCall<PendingReply>(pi.events, TASKS_RPC.pending, {}, 3000);
        return reply.pending;
      } catch {
        return -1;
      }
    }

    return getNativeTaskStore()?.pendingCount() ?? -1;
  }

  async function cleanDoneTasks(): Promise<void> {
    if (isTasksAvailable()) {
      try {
        await rpcCall<CleanReply>(pi.events, TASKS_RPC.clean, {}, 3000);
        debug?.(`${TASKS_RPC.clean} — done tasks swept`);
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
