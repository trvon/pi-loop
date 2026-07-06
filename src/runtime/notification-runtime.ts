import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  createCoordinator,
  type ReducerEffect,
  type ReducerEvent,
  type ReducerHandler,
} from "../coordinator.js";
import { formatTrigger } from "../loop-format.js";
import {
  type NotificationReducerEvent,
  type NotificationReducerState,
  type ReducerNotification,
  reduceNotificationState,
} from "../notification-reducer.js";
import type { DynamicLoopState, Trigger } from "../types.js";

export interface LoopFireEvent {
  loopId: string;
  prompt: string;
  trigger: Trigger | string;
  timestamp: number;
  readOnly?: boolean;
  recurring?: boolean;
  autoTask?: boolean;
  dynamic?: DynamicLoopState;
}

export interface PendingNotification extends LoopFireEvent {
  key: string;
  message: string;
}

export interface NotificationRuntimeOptions {
  pi: ExtensionAPI;
  hasPendingTasks: () => Promise<number>;
  cleanDoneTasks: () => Promise<void>;
  getHasPendingMessages: () => boolean;
  debug?: (...args: unknown[]) => void;
}

export interface NotificationRuntime {
  syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }): void;
  queueOrDeliverNotification(data: LoopFireEvent): Promise<void>;
  flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void>;
  clear(reason: "session_shutdown" | "session_switch"): void;
}

export function createNotificationRuntime(options: NotificationRuntimeOptions): NotificationRuntime {
  const { pi, hasPendingTasks, cleanDoneTasks, getHasPendingMessages, debug } = options;

  let notificationState: NotificationReducerState = {
    notificationsByKey: {},
    agentRunning: false,
    hasPendingMessages: false,
  };
  let flushPromise: Promise<void> | undefined;
  let notificationCoordinatorDelivered = false;
  let notificationCoordinatorDeliveredSuccessfully = false;

  const notificationReducerHandler: ReducerHandler = (incoming: ReducerEvent) => {
    const result = reduceNotificationState(notificationState, incoming as NotificationReducerEvent);
    notificationState = result.state;
    return result.effects;
  };

  const notificationCoordinator = createCoordinator({
    reducers: [notificationReducerHandler],
    effectHandlers: {
      REQUEST_NOTIFICATION_FLUSH: () => {},
      DELIVER_NOTIFICATION: async (effect: ReducerEffect) => {
        notificationCoordinatorDelivered = true;
        notificationCoordinatorDeliveredSuccessfully = await deliverNotification(
          (effect.payload as { notification: ReducerNotification }).notification,
        );
      },
    },
  });

  function applyNotificationEvent(event: NotificationReducerEvent) {
    const result = reduceNotificationState(notificationState, event);
    notificationState = result.state;
    return result;
  }

  function syncRuntimeState(options?: { agentRunning?: boolean; hasPendingMessages?: boolean }) {
    applyNotificationEvent({
      type: "NOTIFICATION_RUNTIME_UPDATED",
      at: Date.now(),
      source: "system",
      entityType: "notification",
      payload: {
        agentRunning: options?.agentRunning ?? notificationState.agentRunning,
        hasPendingMessages: options?.hasPendingMessages ?? getHasPendingMessages(),
      },
    });
  }

  function buildLoopFireMessage(data: LoopFireEvent): string {
    const triggerInfo = formatTrigger(data.trigger, "notification");

    const loopId = data.loopId || "?";
    const prompt = data.prompt || "loop fired";
    const constraint = data.readOnly
      ? "\n\nREAD-ONLY MODE — use only read tools (Read, TaskList, LoopList, MonitorList, etc.). No file writes, shell execution, or destructive changes."
      : "";

    if (data.dynamic || (typeof data.trigger !== "string" && data.trigger?.type === "dynamic")) {
      const dynamic = data.dynamic;
      const lines = [
        `[pi-loop] Loop #${loopId} fired (dynamic).${constraint}`,
        `Goal: ${dynamic?.goal ?? prompt}`,
        `Iteration: ${dynamic?.iteration ?? 0}`,
      ];
      if (dynamic?.state) lines.push(`State: ${dynamic.state}`);
      if (dynamic?.metrics) lines.push(`Metrics: ${dynamic.metrics}`);
      if (dynamic?.doneCriteria) lines.push(`Done criteria: ${dynamic.doneCriteria}`);
      lines.push(
        "Continue toward the goal. When done call LoopUpdate with status=\"completed\". If more work remains, call LoopUpdate with status=\"continue\" plus state/metrics. Omit nextInterval for idle-driven rewake; include nextInterval for a timed wake. If blocked, use status=\"paused\".",
      );
      return lines.join("\n");
    }

    return [
      `[pi-loop] Loop #${loopId} fired (${triggerInfo}).${constraint}`,
      prompt,
    ].join("\n");
  }

  function buildPendingNotification(data: LoopFireEvent): PendingNotification {
    const key = data.recurring ? `loop:${data.loopId}` : `loop:${data.loopId}:${data.timestamp}`;
    return {
      ...data,
      key,
      message: buildLoopFireMessage(data),
    };
  }

  async function deliverNotification(notification: ReducerNotification): Promise<boolean> {
    if (notification.autoTask) {
      const pending = await hasPendingTasks();
      if (pending === 0) {
        debug?.(`loop:fire #${notification.loopId} — no pending tasks at delivery time, dropping wake`);
        await cleanDoneTasks();
        return false;
      }
    }

    syncRuntimeState({ agentRunning: true });
    pi.sendMessage({
      customType: "pi-loop",
      content: notification.message,
      display: false,
      details: {
        loopId: notification.loopId,
        trigger: notification.trigger,
        recurring: notification.recurring,
        readOnly: notification.readOnly,
        autoTask: notification.autoTask,
        dynamic: notification.dynamic,
        timestamp: notification.timestamp,
      },
    }, {
      deliverAs: "steer",
      triggerTurn: true,
    });
    return true;
  }

  async function flushPendingNotifications(options?: { ignorePendingMessages?: boolean }): Promise<void> {
    if (flushPromise) return flushPromise;

    flushPromise = (async () => {
      syncRuntimeState({ hasPendingMessages: getHasPendingMessages() });

      while (true) {
        notificationCoordinatorDelivered = false;
        notificationCoordinatorDeliveredSuccessfully = false;
        await notificationCoordinator.dispatch({
          type: "NOTIFICATION_FLUSH_REQUESTED",
          at: Date.now(),
          source: "system",
          entityType: "notification",
          payload: { ignorePendingMessages: options?.ignorePendingMessages },
        });
        if (!notificationCoordinatorDelivered) return;
        if (notificationCoordinatorDeliveredSuccessfully) return;
      }
    })().finally(() => {
      flushPromise = undefined;
    });

    return flushPromise;
  }

  async function queueOrDeliverNotification(data: LoopFireEvent): Promise<void> {
    const notification = buildPendingNotification(data);
    applyNotificationEvent({
      type: "NOTIFICATION_QUEUED",
      at: notification.timestamp,
      source: "system",
      entityType: "notification",
      entityId: notification.key,
      payload: { notification },
    });
    await flushPendingNotifications();
  }

  function clear(reason: "session_shutdown" | "session_switch") {
    syncRuntimeState({ agentRunning: false, hasPendingMessages: false });
    applyNotificationEvent({
      type: "NOTIFICATION_CLEARED",
      at: Date.now(),
      source: "session",
      entityType: "notification",
      payload: { reason },
    });
  }

  return {
    syncRuntimeState,
    queueOrDeliverNotification,
    flushPendingNotifications,
    clear,
  };
}
