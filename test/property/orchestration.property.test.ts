import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OrchestrationEvent } from "../../src/orchestration-reducer.js";
import { applyOrchestrationEvent, createOrchestrationState, getOrchestrationCounts } from "../../src/orchestration-reducer.js";
import type { OrchestrationState } from "../../src/types.js";
import { propertyOptions } from "./config.js";

const owner = { sessionId: "session", runtimeId: "runtime", generation: 1 };

function applyChecked(state: OrchestrationState, event: OrchestrationEvent): OrchestrationState {
  const snapshot = structuredClone(state);
  const first = applyOrchestrationEvent(state, event);
  const second = applyOrchestrationEvent(state, event);
  expect(state).toEqual(snapshot);
  expect(first).toEqual(second);
  return first.applied ? first.state : state;
}

describe("orchestration reducer properties", () => {
  it("is deterministic, immutable, bounded, and never retries uncertain work", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 4 }),
        fc.integer({ min: 1, max: 3 }),
        fc.array(fc.constantFrom<"completed" | "failed" | "uncertain">("completed", "failed", "uncertain"), { minLength: 1, maxLength: 30 }),
        (workCount, concurrency, maxAttempts, outcomes) => {
          let state = createOrchestrationState({
            goal: "property batch",
            work: Array.from({ length: workCount }, (_, index) => ({ prompt: `work ${index + 1}` })),
            concurrency,
            maxAttempts,
          }, owner, 0);
          let at = 1;

          for (const outcome of outcomes) {
            const item = state.work.find((candidate) => candidate.status === "pending");
            if (!item || state.status !== "active") break;
            const dispatchId = `dispatch-${at}`;
            state = applyChecked(state, {
              type: "dispatch_requested",
              at: at++,
              expected: { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
              workId: item.id,
              dispatchId,
            });
            const agentId = `agent-${at}`;
            state = applyChecked(state, {
              type: "dispatch_bound",
              at: at++,
              expected: { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
              workId: item.id,
              dispatchId,
              agentId,
            });
            state = outcome === "uncertain"
              ? applyChecked(state, {
                  type: "dispatch_uncertain",
                  at: at++,
                  expected: { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
                  workId: item.id,
                  dispatchId,
                  error: "ambiguous",
                })
              : applyChecked(state, {
                  type: "dispatch_settled",
                  at: at++,
                  expected: { revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
                  agentId,
                  outcome,
                  result: outcome === "completed" ? "done" : undefined,
                  error: outcome === "failed" ? "failed" : undefined,
                });

            const counts = getOrchestrationCounts(state);
            expect(counts.active).toBeLessThanOrEqual(concurrency);
            expect(state.work.every((candidate) => candidate.attemptCount <= maxAttempts)).toBe(true);
            expect(state.work.filter((candidate) => candidate.status === "uncertain").every((candidate) => candidate.attemptCount === candidate.dispatches.length)).toBe(true);
          }
        },
      ),
      propertyOptions(),
    );
  });

  it("never reopens or consumes cancelled multi-dispatch work under late event permutations", () => {
    fc.assert(fc.property(fc.integer({ min: 1, max: 4 }), fc.array(fc.constantFrom("completed", "failed", "consume", "dispatch"), { maxLength: 20 }), (count, events) => {
      let state = createOrchestrationState({ goal: "cancel", work: Array.from({ length: count }, () => ({ prompt: "work" })), concurrency: count, maxAttempts: 3 }, owner, 0);
      const expected = () => ({ revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation });
      for (let i = 1; i <= count; i++) {
        state = applyChecked(state, { type: "dispatch_requested", at: i, expected: expected(), workId: String(i), dispatchId: `d${i}` });
        state = applyChecked(state, { type: "dispatch_bound", at: i, expected: expected(), workId: String(i), dispatchId: `d${i}`, agentId: `a${i}` });
      }
      expect(getOrchestrationCounts(state).active).toBe(count);
      state = applyChecked(state, { type: "cancelled", at: 10, expected: expected() });
      const cancelled = structuredClone(state);
      for (const event of events) {
        state = applyChecked(state, event === "consume"
          ? { type: "consume_recorded", at: 11, expected: expected(), agentId: "a1", consumed: true }
          : event === "dispatch"
            ? { type: "dispatch_requested", at: 11, expected: expected(), workId: "1", dispatchId: "retry" }
            : { type: "dispatch_settled", at: 11, expected: expected(), agentId: "a1", outcome: event as "completed" | "failed" });
        expect(state).toEqual(cancelled);
      }
      expect(state.work.every((item) => item.attemptCount === 1 && item.dispatches[0]?.consumeStatus === "unavailable")).toBe(true);
    }), propertyOptions());
  });

  it("rejects arbitrary stale revisions without mutation", () => {
    fc.assert(
      fc.property(fc.integer({ min: 2, max: 10_000 }), (staleRevision) => {
        const state = createOrchestrationState({ goal: "batch", work: [{ prompt: "work" }] }, owner, 0);
        const result = applyOrchestrationEvent(state, {
          type: "dispatch_requested",
          at: 1,
          expected: { revision: staleRevision, ownerRuntimeId: owner.runtimeId, generation: owner.generation },
          workId: "1",
          dispatchId: "dispatch",
        });
        expect(result).toEqual({ applied: false, state, reason: "stale_revision" });
      }),
      propertyOptions(),
    );
  });
});
