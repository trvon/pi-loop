import { describe, expect, it } from "vitest";
import {
  atMaxFires,
  type LoopReducerEvent,
  type LoopReducerState,
  MAX_LOOP_EXPIRY_MS,
  reduceLoopState,
} from "../src/loop-reducer.js";
import type { LoopEntry, Trigger } from "../src/types.js";

const cronTrigger: Trigger = { type: "cron", schedule: "*/5 * * * *" };
const eventTrigger: Trigger = { type: "event", source: "tasks:created" };

describe("atMaxFires", () => {
  it("is false when maxFires is unset (unbounded loop)", () => {
    expect(atMaxFires({ maxFires: undefined, fireCount: 999 })).toBe(false);
  });

  it("is false before the cap and true at or past it", () => {
    expect(atMaxFires({ maxFires: 3, fireCount: 2 })).toBe(false);
    expect(atMaxFires({ maxFires: 3, fireCount: 3 })).toBe(true);
    expect(atMaxFires({ maxFires: 3, fireCount: 4 })).toBe(true);
  });

  it("treats a missing fireCount as zero", () => {
    expect(atMaxFires({ maxFires: 1, fireCount: undefined })).toBe(false);
  });
});

function makeState(loops: LoopEntry[] = [], nextId = 1): LoopReducerState {
  return {
    nextId,
    loopsById: Object.fromEntries(loops.map(loop => [loop.id, loop])),
  };
}

function apply(state: LoopReducerState, event: LoopReducerEvent) {
  return reduceLoopState(state, event);
}

describe("loop reducer", () => {
  it("creates an active loop with fireCount 0 and 7-day expiry", () => {
    const { state, effects } = apply(makeState(), {
      type: "LOOP_CREATED",
      at: 100,
      source: "tool",
      entityType: "loop",
      payload: {
        prompt: "Check build",
        trigger: cronTrigger,
        recurring: true,
        autoTask: true,
        taskBacklog: true,
        readOnly: true,
        maxFires: 5,
      },
    });

    const created = state.loopsById["1"];
    expect(state.nextId).toBe(2);
    expect(created).toMatchObject({
      id: "1",
      prompt: "Check build",
      trigger: cronTrigger,
      status: "active",
      recurring: true,
      autoTask: true,
      taskBacklog: true,
      readOnly: true,
      maxFires: 5,
      fireCount: 0,
      createdAt: 100,
      updatedAt: 100,
    });
    expect(created.expiresAt).toBe(100 + MAX_LOOP_EXPIRY_MS);
    expect(effects).toEqual([
      {
        type: "PERSIST_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { loop: created },
      },
    ]);
  });

  it("pauses an active loop", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Pause me",
        trigger: cronTrigger,
        status: "active",
        recurring: true,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        fireCount: 0,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_PAUSED",
      at: 200,
      source: "tool",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"].status).toBe("paused");
    expect(state.loopsById["1"].updatedAt).toBe(200);
    expect(effects).toEqual([
      {
        type: "PERSIST_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { loop: state.loopsById["1"] },
      },
    ]);
  });

  it("resumes a paused loop", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Resume me",
        trigger: cronTrigger,
        status: "paused",
        recurring: true,
        createdAt: 10,
        updatedAt: 50,
        expiresAt: 20,
        fireCount: 0,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_RESUMED",
      at: 300,
      source: "tool",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"].status).toBe("active");
    expect(state.loopsById["1"].updatedAt).toBe(300);
    expect(effects).toEqual([
      {
        type: "PERSIST_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { loop: state.loopsById["1"] },
      },
    ]);
  });

  it("increments fireCount on LOOP_FIRED", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Fire me",
        trigger: eventTrigger,
        status: "active",
        recurring: true,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        fireCount: 1,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_FIRED",
      at: 400,
      source: "scheduler",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"].fireCount).toBe(2);
    expect(state.loopsById["1"].updatedAt).toBe(400);
    expect(effects).toEqual([
      {
        type: "PERSIST_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { loop: state.loopsById["1"] },
      },
    ]);
  });

  it("deletes a loop on LOOP_DELETED", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Delete me",
        trigger: cronTrigger,
        status: "active",
        recurring: true,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        fireCount: 0,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_DELETED",
      at: 500,
      source: "tool",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"]).toBeUndefined();
    expect(state.nextId).toBe(2);
    expect(effects).toEqual([
      {
        type: "DELETE_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("deletes a loop on LOOP_MAX_FIRES_REACHED", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Limited",
        trigger: eventTrigger,
        status: "active",
        recurring: true,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        maxFires: 1,
        fireCount: 1,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_MAX_FIRES_REACHED",
      at: 600,
      source: "system",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"]).toBeUndefined();
    expect(effects).toEqual([
      {
        type: "DELETE_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("deletes expired loops on LOOP_EXPIRED", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Expired",
        trigger: cronTrigger,
        status: "active",
        recurring: false,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        fireCount: 0,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_EXPIRED",
      at: 700,
      source: "system",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1", reason: "expires_at" },
    });

    expect(state.loopsById["1"]).toBeUndefined();
    expect(effects).toEqual([
      {
        type: "DELETE_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("deletes backlog loops on LOOP_BACKLOG_EMPTY", () => {
    const initial = makeState([
      {
        id: "1",
        prompt: "Backlog worker",
        trigger: eventTrigger,
        status: "active",
        recurring: true,
        createdAt: 10,
        updatedAt: 10,
        expiresAt: 20,
        fireCount: 0,
        taskBacklog: true,
      },
    ], 2);

    const { state, effects } = apply(initial, {
      type: "LOOP_BACKLOG_EMPTY",
      at: 800,
      source: "coordinator",
      entityType: "loop",
      entityId: "1",
      payload: { id: "1" },
    });

    expect(state.loopsById["1"]).toBeUndefined();
    expect(effects).toEqual([
      {
        type: "DELETE_LOOP",
        entityType: "loop",
        entityId: "1",
        payload: { id: "1" },
      },
    ]);
  });

  it("leaves state unchanged when the loop does not exist", () => {
    const initial = makeState([], 3);

    const { state, effects } = apply(initial, {
      type: "LOOP_PAUSED",
      at: 900,
      source: "tool",
      entityType: "loop",
      entityId: "99",
      payload: { id: "99" },
    });

    expect(state).toEqual(initial);
    expect(effects).toEqual([]);
  });
});
