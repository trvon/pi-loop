import { describe, expect, it, vi } from "vitest";
import {
  CoordinatorError,
  createCoordinator,
  type ReducerEffect,
  type ReducerEvent,
  type ReducerHandler,
} from "../src/coordinator.js";

function event(type: string, payload: unknown = {}, at = 1): ReducerEvent {
  return {
    type,
    at,
    source: "system",
    payload,
  };
}

describe("coordinator", () => {
  it("fans out events to reducers in registration order and executes effects in emitted order", async () => {
    const calls: string[] = [];

    const reducerA: ReducerHandler = (incoming) => {
      calls.push(`reducerA:${incoming.type}`);
      return [
        { type: "A_EFFECT", payload: { from: "A1" } },
        { type: "B_EFFECT", payload: { from: "A2" } },
      ];
    };

    const reducerB: ReducerHandler = (incoming) => {
      calls.push(`reducerB:${incoming.type}`);
      return [
        { type: "C_EFFECT", payload: { from: "B1" } },
      ];
    };

    const executed: string[] = [];
    const coordinator = createCoordinator({
      reducers: [reducerA, reducerB],
      effectExecutor: async (effect) => {
        executed.push(`${effect.type}:${(effect.payload as { from: string }).from}`);
      },
    });

    await coordinator.dispatch(event("ROOT"));

    expect(calls).toEqual(["reducerA:ROOT", "reducerB:ROOT"]);
    expect(executed).toEqual(["A_EFFECT:A1", "B_EFFECT:A2", "C_EFFECT:B1"]);
  });

  it("dispatches derived events in place when DISPATCH_EVENT is emitted", async () => {
    const executed: string[] = [];

    const reducer: ReducerHandler = (incoming) => {
      if (incoming.type === "ROOT") {
        return [
          { type: "FIRST_EFFECT", payload: { step: "before" } },
          {
            type: "DISPATCH_EVENT",
            payload: { event: event("CHILD", { step: "child" }, 2) },
          },
          { type: "LAST_EFFECT", payload: { step: "after" } },
        ];
      }

      if (incoming.type === "CHILD") {
        return [{ type: "CHILD_EFFECT", payload: { step: "child-effect" } }];
      }

      return [];
    };

    const coordinator = createCoordinator({
      reducers: [reducer],
      effectExecutor: async (effect) => {
        executed.push(effect.type);
      },
    });

    await coordinator.dispatch(event("ROOT"));

    expect(executed).toEqual([
      "FIRST_EFFECT",
      "CHILD_EFFECT",
      "LAST_EFFECT",
    ]);
  });

  it("supports async reducers and async effect handlers", async () => {
    const reducerA = vi.fn(async () => {
      await Promise.resolve();
      return [{ type: "ASYNC_EFFECT", payload: { ok: true } } satisfies ReducerEffect];
    });
    const effectExecutor = vi.fn(async () => {
      await Promise.resolve();
    });

    const coordinator = createCoordinator({
      reducers: [reducerA],
      effectExecutor,
    });

    await coordinator.dispatch(event("ASYNC_ROOT"));

    expect(reducerA).toHaveBeenCalledTimes(1);
    expect(effectExecutor).toHaveBeenCalledTimes(1);
  });

  it("uses typed effect handlers before falling back to the generic effect executor", async () => {
    const handled: string[] = [];
    const reducer: ReducerHandler = () => [
      { type: "SPECIAL_EFFECT", payload: { id: 1 } },
      { type: "GENERIC_EFFECT", payload: { id: 2 } },
    ];

    const coordinator = createCoordinator({
      reducers: [reducer],
      effectHandlers: {
        SPECIAL_EFFECT: async () => {
          handled.push("special");
        },
      },
      effectExecutor: async (effect) => {
        handled.push(effect.type.toLowerCase());
      },
    });

    await coordinator.dispatch(event("ROOT"));

    expect(handled).toEqual(["special", "generic_effect"]);
  });

  it("throws a coordinator error when derived dispatch depth exceeds the limit", async () => {
    const loopingReducer: ReducerHandler = (incoming) => [{
      type: "DISPATCH_EVENT",
      payload: { event: event(incoming.type, {}, incoming.at + 1) },
    }];

    const coordinator = createCoordinator({
      reducers: [loopingReducer],
      maxDispatchDepth: 3,
    });

    await expect(coordinator.dispatch(event("LOOP"))).rejects.toBeInstanceOf(CoordinatorError);
  });
});
