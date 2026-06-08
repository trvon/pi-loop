import { describe, expect, it } from "vitest";
import { createCoordinator, type ReducerEffect, type ReducerEvent, type ReducerHandler } from "../src/coordinator.js";
import {
  type NotificationReducerEvent,
  type NotificationReducerState,
  type ReducerNotification,
  reduceNotificationState,
} from "../src/notification-reducer.js";

function notification(overrides: Partial<ReducerNotification> = {}): ReducerNotification {
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

describe("notification coordinator slice", () => {
  it("queues then flushes through the coordinator and delivers the earliest notification", async () => {
    let state: NotificationReducerState = {
      notificationsByKey: {},
      agentRunning: false,
      hasPendingMessages: false,
    };

    const reducer: ReducerHandler = (incoming: ReducerEvent) => {
      const result = reduceNotificationState(state, incoming as NotificationReducerEvent);
      state = result.state;
      return result.effects;
    };

    const delivered: string[] = [];
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        REQUEST_NOTIFICATION_FLUSH: async () => {},
        DELIVER_NOTIFICATION: async (effect: ReducerEffect) => {
          delivered.push((effect.payload as { notification: ReducerNotification }).notification.key);
        },
      },
    });

    await coordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: 200,
      source: "system",
      entityType: "notification",
      entityId: "loop:2",
      payload: { notification: notification({ key: "loop:2", loopId: "2", timestamp: 200 }) },
    });
    await coordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: 100,
      source: "system",
      entityType: "notification",
      entityId: "loop:1",
      payload: { notification: notification({ key: "loop:1", loopId: "1", timestamp: 100 }) },
    });

    await coordinator.dispatch({
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 300,
      source: "system",
      entityType: "notification",
      payload: {},
    });

    expect(delivered).toEqual(["loop:1"]);
    expect(Object.keys(state.notificationsByKey)).toEqual(["loop:2"]);
  });

  it("respects runtime gating in the reducer-managed state", async () => {
    let state: NotificationReducerState = {
      notificationsByKey: {},
      agentRunning: false,
      hasPendingMessages: false,
    };

    const reducer: ReducerHandler = (incoming: ReducerEvent) => {
      const result = reduceNotificationState(state, incoming as NotificationReducerEvent);
      state = result.state;
      return result.effects;
    };

    const delivered: string[] = [];
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        REQUEST_NOTIFICATION_FLUSH: async () => {},
        DELIVER_NOTIFICATION: async (effect: ReducerEffect) => {
          delivered.push((effect.payload as { notification: ReducerNotification }).notification.key);
        },
      },
    });

    await coordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: 100,
      source: "system",
      entityType: "notification",
      entityId: "loop:1",
      payload: { notification: notification() },
    });
    await coordinator.dispatch({
      type: "NOTIFICATION_RUNTIME_UPDATED",
      at: 110,
      source: "system",
      entityType: "notification",
      payload: { agentRunning: true, hasPendingMessages: false },
    });
    await coordinator.dispatch({
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 120,
      source: "system",
      entityType: "notification",
      payload: {},
    });

    expect(delivered).toEqual([]);
    expect(Object.keys(state.notificationsByKey)).toEqual(["loop:1"]);
  });

  it("supports force-flush when pending messages would otherwise block delivery", async () => {
    let state: NotificationReducerState = {
      notificationsByKey: {},
      agentRunning: false,
      hasPendingMessages: false,
    };

    const reducer: ReducerHandler = (incoming: ReducerEvent) => {
      const result = reduceNotificationState(state, incoming as NotificationReducerEvent);
      state = result.state;
      return result.effects;
    };

    const delivered: string[] = [];
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        REQUEST_NOTIFICATION_FLUSH: async () => {},
        DELIVER_NOTIFICATION: async (effect: ReducerEffect) => {
          delivered.push((effect.payload as { notification: ReducerNotification }).notification.key);
        },
      },
    });

    await coordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: 100,
      source: "system",
      entityType: "notification",
      entityId: "loop:1",
      payload: { notification: notification() },
    });
    await coordinator.dispatch({
      type: "NOTIFICATION_RUNTIME_UPDATED",
      at: 110,
      source: "system",
      entityType: "notification",
      payload: { agentRunning: false, hasPendingMessages: true },
    });
    await coordinator.dispatch({
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 120,
      source: "system",
      entityType: "notification",
      payload: { ignorePendingMessages: true },
    });

    expect(delivered).toEqual(["loop:1"]);
    expect(state.notificationsByKey).toEqual({});
  });

  it("mirrors the index slice pattern of queue then explicit flush with stateful delivery flags", async () => {
    let state: NotificationReducerState = {
      notificationsByKey: {},
      agentRunning: false,
      hasPendingMessages: false,
    };

    const reducer: ReducerHandler = (incoming: ReducerEvent) => {
      const result = reduceNotificationState(state, incoming as NotificationReducerEvent);
      state = result.state;
      return result.effects;
    };

    let delivered = false;
    let deliveredSuccessfully = false;
    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        REQUEST_NOTIFICATION_FLUSH: async () => {},
        DELIVER_NOTIFICATION: async () => {
          delivered = true;
          deliveredSuccessfully = true;
        },
      },
    });

    await coordinator.dispatch({
      type: "NOTIFICATION_QUEUED",
      at: 100,
      source: "system",
      entityType: "notification",
      entityId: "loop:1",
      payload: { notification: notification() },
    });

    delivered = false;
    deliveredSuccessfully = false;
    await coordinator.dispatch({
      type: "NOTIFICATION_FLUSH_REQUESTED",
      at: 120,
      source: "system",
      entityType: "notification",
      payload: {},
    });

    expect(delivered).toBe(true);
    expect(deliveredSuccessfully).toBe(true);
    expect(state.notificationsByKey).toEqual({});
  });
});
