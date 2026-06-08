import { describe, expect, it } from "vitest";
import {
  type NotificationReducerEvent,
  type NotificationReducerState,
  type ReducerNotification,
  reduceNotificationState,
} from "../src/notification-reducer.js";

function makeNotification(overrides: Partial<ReducerNotification> = {}): ReducerNotification {
  return {
    key: "loop:1",
    loopId: "1",
    message: "hello",
    timestamp: 100,
    trigger: { type: "cron", schedule: "*/5 * * * *" },
    recurring: true,
    ...overrides,
  };
}

function makeState(
  notifications: ReducerNotification[] = [],
  overrides: Partial<NotificationReducerState> = {},
): NotificationReducerState {
  return {
    notificationsByKey: Object.fromEntries(notifications.map(notification => [notification.key, notification])),
    agentRunning: false,
    hasPendingMessages: false,
    ...overrides,
  };
}

function apply(state: NotificationReducerState, event: NotificationReducerEvent) {
  return reduceNotificationState(state, event);
}

describe("notification reducer", () => {
  it("queues a notification", () => {
    const notification = makeNotification();
    const { state, effects } = apply(makeState(), {
      type: "NOTIFICATION_QUEUED",
      at: 100,
      source: "system",
      entityType: "notification",
      entityId: notification.key,
      payload: { notification },
    });

    expect(state.notificationsByKey[notification.key]).toEqual(notification);
    expect(effects).toEqual([{ type: "REQUEST_NOTIFICATION_FLUSH", payload: {} }]);
  });

  it("replaces an existing recurring notification with the latest version", () => {
    const oldNotification = makeNotification({ message: "old", timestamp: 100 });
    const newNotification = makeNotification({ message: "new", timestamp: 200 });

    const { state, effects } = apply(makeState([oldNotification]), {
      type: "NOTIFICATION_QUEUED",
      at: 200,
      source: "system",
      entityType: "notification",
      entityId: newNotification.key,
      payload: { notification: newNotification },
    });

    expect(state.notificationsByKey[newNotification.key]).toEqual(newNotification);
    expect(Object.keys(state.notificationsByKey)).toHaveLength(1);
    expect(effects).toEqual([{ type: "REQUEST_NOTIFICATION_FLUSH", payload: {} }]);
  });

  it("emits a deliver effect for the earliest queued notification when flush is allowed", () => {
    const later = makeNotification({ key: "loop:2", loopId: "2", timestamp: 200, message: "later" });
    const earlier = makeNotification({ key: "loop:1", loopId: "1", timestamp: 100, message: "earlier" });

    const { state, effects } = apply(makeState([later, earlier]), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 300,
      source: "system",
      entityType: "notification",
      payload: {},
    });

    expect(state.notificationsByKey[earlier.key]).toBeUndefined();
    expect(state.notificationsByKey[later.key]).toEqual(later);
    expect(effects).toEqual([
      {
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: earlier.key,
        payload: { notification: earlier },
      },
    ]);
  });

  it("does not flush while agent is running", () => {
    const notification = makeNotification();
    const { state, effects } = apply(makeState([notification], { agentRunning: true }), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 300,
      source: "system",
      entityType: "notification",
      payload: {},
    });

    expect(state.notificationsByKey[notification.key]).toEqual(notification);
    expect(effects).toEqual([]);
  });

  it("does not flush while pending messages exist unless ignorePendingMessages is set", () => {
    const notification = makeNotification();

    const blocked = apply(makeState([notification], { hasPendingMessages: true }), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 300,
      source: "system",
      entityType: "notification",
      payload: {},
    });
    expect(blocked.state.notificationsByKey[notification.key]).toEqual(notification);
    expect(blocked.effects).toEqual([]);

    const forced = apply(makeState([notification], { hasPendingMessages: true }), {
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 301,
      source: "system",
      entityType: "notification",
      payload: { ignorePendingMessages: true },
    });
    expect(forced.state.notificationsByKey[notification.key]).toBeUndefined();
    expect(forced.effects).toEqual([
      {
        type: "DELIVER_NOTIFICATION",
        entityType: "notification",
        entityId: notification.key,
        payload: { notification },
      },
    ]);
  });

  it("drops a notification by key", () => {
    const notification = makeNotification();
    const { state, effects } = apply(makeState([notification]), {
      type: "NOTIFICATION_DROPPED",
      at: 400,
      source: "system",
      entityType: "notification",
      entityId: notification.key,
      payload: { key: notification.key, reason: "zero_pending_tasks" },
    });

    expect(state.notificationsByKey[notification.key]).toBeUndefined();
    expect(effects).toEqual([]);
  });

  it("clears all notifications", () => {
    const one = makeNotification({ key: "loop:1" });
    const two = makeNotification({ key: "loop:2", loopId: "2" });
    const { state, effects } = apply(makeState([one, two]), {
      type: "NOTIFICATION_CLEARED",
      at: 500,
      source: "session",
      entityType: "notification",
      payload: { reason: "session_switch" },
    });

    expect(state.notificationsByKey).toEqual({});
    expect(effects).toEqual([]);
  });

  it("updates runtime delivery flags", () => {
    const notification = makeNotification();
    const { state, effects } = apply(makeState([notification]), {
      type: "NOTIFICATION_RUNTIME_UPDATED",
      at: 600,
      source: "system",
      entityType: "notification",
      payload: { agentRunning: true, hasPendingMessages: true },
    });

    expect(state.agentRunning).toBe(true);
    expect(state.hasPendingMessages).toBe(true);
    expect(state.notificationsByKey[notification.key]).toEqual(notification);
    expect(effects).toEqual([]);
  });
});
