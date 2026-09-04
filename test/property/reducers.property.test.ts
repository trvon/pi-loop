import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type LoopReducerEvent,
  type LoopReducerState,
  reduceLoopState,
} from "../../src/loop-reducer.js";
import { propertyOptions } from "./config.js";

type LoopCommand = {
  type: "fire" | "pause" | "resume" | "update";
  value: string;
};

const loopCommand = fc.record({
  type: fc.constantFrom<LoopCommand["type"]>("fire", "pause", "resume", "update"),
  value: fc.string({ maxLength: 40 }),
});

function eventFor(command: LoopCommand, at: number): LoopReducerEvent {
  switch (command.type) {
    case "fire":
      return { type: "LOOP_FIRED", at, source: "system", payload: { id: "1" } };
    case "pause":
      return { type: "LOOP_PAUSED", at, source: "system", payload: { id: "1", kind: "administrative" } };
    case "resume":
      return { type: "LOOP_RESUMED", at, source: "system", payload: { id: "1" } };
    case "update":
      return {
        type: "LOOP_DYNAMIC_UPDATED",
        at,
        source: "system",
        payload: { id: "1", prompt: command.value, dynamic: { state: command.value } },
      };
  }
}

function initialLoopState(prompt: string): LoopReducerState {
  return reduceLoopState(
    { nextId: 1, loopsById: {} },
    {
      type: "LOOP_CREATED",
      at: 0,
      source: "system",
      payload: {
        prompt,
        trigger: { type: "dynamic" },
        recurring: true,
        expiresAt: 604_800_000,
      },
    },
  ).state;
}

describe("loop reducer properties", () => {
  it("is deterministic, immutable, and preserves lifecycle invariants", () => {
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.array(loopCommand, { maxLength: 100 }),
        (prompt, commands) => {
          let state = initialLoopState(prompt);
          let expectedFireCount = 0;
          let expectedStatus: "active" | "paused" = "active";

          commands.forEach((command, index) => {
            const event = eventFor(command, index + 1);
            const snapshot = structuredClone(state);
            const first = reduceLoopState(state, event);
            const second = reduceLoopState(state, event);

            expect(state).toEqual(snapshot);
            expect(first).toEqual(second);
            state = first.state;
            if (command.type === "fire") expectedFireCount++;
            if (command.type === "pause") expectedStatus = "paused";
            if (command.type === "resume") expectedStatus = "active";
          });

          expect(Object.keys(state.loopsById)).toEqual(["1"]);
          expect(state.nextId).toBe(2);
          expect(state.loopsById["1"]?.fireCount).toBe(expectedFireCount);
          expect(state.loopsById["1"]?.status).toBe(expectedStatus);
        },
      ),
      propertyOptions(),
    );
  });

  it("treats generated missing IDs as identity no-ops", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 1_000 }), (missingId) => {
        const state = initialLoopState("goal");
        const result = reduceLoopState(state, {
          type: "LOOP_FIRED",
          at: 1,
          source: "system",
          payload: { id: String(missingId) },
        });

        expect(result.state).toBe(state);
        expect(result.effects).toEqual([]);
      }),
      propertyOptions(),
    );
  });
});
