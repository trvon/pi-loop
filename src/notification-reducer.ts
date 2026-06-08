type ReducerSource = "tool" | "command" | "scheduler" | "eventbus" | "monitor" | "session" | "coordinator" | "system";

export interface ReducerNotification {
  key: string;
  loopId: string;
  message: string;
  timestamp: number;
  trigger: unknown;
  recurring?: boolean;
  autoTask?: boolean;
  readOnly?: boolean;
}

export interface NotificationReducerState {
  notificationsByKey: Record<string, ReducerNotification>;
  agentRunning: boolean;
  hasPendingMessages: boolean;
}

export type NotificationReducerEvent =
  | {
    type: "NOTIFICATION_QUEUED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { notification: ReducerNotification };
  }
  | {
    type: "NOTIFICATION_DROPPED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: {
      key: string;
      reason: "zero_pending_tasks" | "session_switch" | "session_shutdown" | "superseded";
    };
  }
  | {
    type: "NOTIFICATION_CLEARED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { reason: "session_switch" | "session_shutdown" };
  }
  | {
    type: "NOTIFICATION_FLUSH_REQUESTED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { ignorePendingMessages?: boolean };
  }
  | {
    type: "NOTIFICATION_RUNTIME_UPDATED";
    at: number;
    source: ReducerSource;
    entityType?: "notification";
    entityId?: string;
    payload: { agentRunning: boolean; hasPendingMessages: boolean };
  };

export type NotificationReducerEffect =
  | {
    type: "REQUEST_NOTIFICATION_FLUSH";
    payload: Record<string, never>;
  }
  | {
    type: "DELIVER_NOTIFICATION";
    entityType: "notification";
    entityId: string;
    payload: { notification: ReducerNotification };
  };

export interface NotificationReduceResult {
  state: NotificationReducerState;
  effects: NotificationReducerEffect[];
}

function cloneState(state: NotificationReducerState): NotificationReducerState {
  return {
    notificationsByKey: { ...state.notificationsByKey },
    agentRunning: state.agentRunning,
    hasPendingMessages: state.hasPendingMessages,
  };
}

export function reduceNotificationState(
  state: NotificationReducerState,
  event: NotificationReducerEvent,
): NotificationReduceResult {
  if (event.type === "NOTIFICATION_QUEUED") {
    const next = cloneState(state);
    next.notificationsByKey[event.payload.notification.key] = event.payload.notification;
    return {
      state: next,
      effects: [{ type: "REQUEST_NOTIFICATION_FLUSH", payload: {} }],
    };
  }

  if (event.type === "NOTIFICATION_DROPPED") {
    const next = cloneState(state);
    delete next.notificationsByKey[event.payload.key];
    return { state: next, effects: [] };
  }

  if (event.type === "NOTIFICATION_CLEARED") {
    return {
      state: {
        ...state,
        notificationsByKey: {},
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_RUNTIME_UPDATED") {
    return {
      state: {
        ...state,
        agentRunning: event.payload.agentRunning,
        hasPendingMessages: event.payload.hasPendingMessages,
      },
      effects: [],
    };
  }

  if (event.type === "NOTIFICATION_FLUSH_REQUESTED") {
    if (state.agentRunning) return { state, effects: [] };
    if (!event.payload.ignorePendingMessages && state.hasPendingMessages) {
      return { state, effects: [] };
    }

    const queued = Object.values(state.notificationsByKey)
      .sort((left, right) => left.timestamp - right.timestamp);
    const nextNotification = queued[0];
    if (!nextNotification) return { state, effects: [] };

    const next = cloneState(state);
    delete next.notificationsByKey[nextNotification.key];
    return {
      state: next,
      effects: [{
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: nextNotification.key,
        payload: { notification: nextNotification },
      }],
    };
  }

  return { state, effects: [] };
}
