import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { OrchestrationEvent } from "../../src/orchestration-reducer.js";
import { applyOrchestrationEvent, createOrchestrationState, getOrchestrationCapacity, getOrchestrationCounts, validatePersistedOrchestration } from "../../src/orchestration-reducer.js";
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

  it("keeps aimd dispatch inside the ACK window, counts every signal once, and never cuts for task failures", () => {
    type Step = "fill" | "complete" | "empty" | "task_error" | "overload" | "timeout" | "spawn_failed";
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 32 }),
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.constantFrom<Step>("fill", "complete", "empty", "task_error", "overload", "timeout", "spawn_failed"), { minLength: 1, maxLength: 60 }),
      (workCount, maxAttempts, steps) => {
        let state = createOrchestrationState({
          goal: "aimd property",
          work: Array.from({ length: workCount }, (_, index) => ({ prompt: `work ${index + 1}` })),
          concurrency: 2,
          maxAttempts,
          pacing: "aimd",
        }, owner, 0);
        expect(state.concurrency).toBe(workCount);
        const expected = () => ({ revision: state.revision, ownerRuntimeId: owner.runtimeId, generation: owner.generation });
        let at = 1;
        let signals = 0;
        for (const step of steps) {
          if (state.status !== "active") break;
          if (step === "fill") {
            for (const item of state.work.filter((candidate) => candidate.status === "pending")) {
              const before = getOrchestrationCounts(state).active;
              const capacity = getOrchestrationCapacity(state);
              const dispatchId = `d${at}`;
              const requested = applyOrchestrationEvent(state, { type: "dispatch_requested", at: at++, expected: expected(), workId: item.id, dispatchId });
              expect(requested.applied).toBe(before < capacity);
              if (!requested.applied) break;
              state = requested.state;
              state = applyChecked(state, { type: "dispatch_bound", at: at++, expected: expected(), workId: item.id, dispatchId, agentId: `a${dispatchId}` });
            }
            continue;
          }
          const active = state.work.find((candidate) => candidate.status === "active");
          const dispatch = active?.dispatches.at(-1);
          if (!active || !dispatch?.agentId) continue;
          const windowBefore = state.window!;
          state = step === "spawn_failed"
            ? applyChecked(state, { type: "dispatch_spawn_failed", at: at++, expected: expected(), workId: active.id, dispatchId: dispatch.dispatchId, error: "spawn" })
            : applyChecked(state, {
                type: "dispatch_settled",
                at: at++,
                expected: expected(),
                agentId: dispatch.agentId,
                outcome: step === "complete" || step === "empty" ? "completed" : "failed",
                result: step === "complete" ? "done" : step === "empty" ? " " : undefined,
                error: step === "overload" ? "503 overloaded" : step === "timeout" ? "timed out" : step === "task_error" ? "assertion failed" : undefined,
              });
          signals += 1;
          const window = state.window!;
          if (step === "empty" || step === "task_error") {
            expect(window.cwnd).toBe(windowBefore.cwnd);
            expect(window.ssthresh).toBe(windowBefore.ssthresh);
          }
          if (step === "timeout") expect(window.cwnd).toBe(1);
          expect(window.cwnd).toBeGreaterThanOrEqual(1);
          expect(window.cwnd).toBeLessThanOrEqual(workCount);
          expect(window.acks + window.losses + window.taskLosses).toBe(signals);
          expect(validatePersistedOrchestration(structuredClone(state))).toEqual(state);
        }
      },
    ), propertyOptions());
  });

  it("holds capacity while verifying, settles each verification once, and never makes verifying work uncertain", () => {
    type Step = "fill" | "complete" | "pass" | "fail" | "adopt" | "cancel";
    fc.assert(fc.property(
      fc.integer({ min: 1, max: 10 }),
      fc.integer({ min: 1, max: 3 }),
      fc.array(fc.constantFrom<Step>("fill", "complete", "pass", "fail", "adopt", "cancel"), { minLength: 1, maxLength: 50 }),
      (workCount, maxAttempts, steps) => {
        let state = createOrchestrationState({
          goal: "verify property",
          work: Array.from({ length: workCount }, (_, index) => ({ prompt: `work ${index + 1}`, verify: `check ${index + 1}` })),
          maxAttempts,
          pacing: "aimd",
        }, owner, 0);
        let actor = { ...owner };
        const expected = () => ({ revision: state.revision, ownerRuntimeId: actor.runtimeId, generation: actor.generation });
        let at = 1;
        for (const step of steps) {
          if (step === "fill") {
            for (const item of state.work.filter((candidate) => candidate.status === "pending")) {
              const dispatchId = `d${at}`;
              const requested = applyOrchestrationEvent(state, { type: "dispatch_requested", at: at++, expected: expected(), workId: item.id, dispatchId });
              if (!requested.applied) break;
              state = requested.state;
              state = applyChecked(state, { type: "dispatch_bound", at: at++, expected: expected(), workId: item.id, dispatchId, agentId: `a${dispatchId}` });
            }
          } else if (step === "complete") {
            const live = state.work.map((item) => item.dispatches.at(-1)).find((d) => d && (d.status === "queued" || d.status === "running"));
            if (live?.agentId) state = applyChecked(state, { type: "dispatch_awaiting_verify", at: at++, expected: expected(), agentId: live.agentId, result: "done" });
          } else if (step === "pass" || step === "fail") {
            const verifying = state.work.map((item) => item.dispatches.at(-1)).find((d) => d?.status === "verifying");
            if (!verifying?.agentId) continue;
            const before = structuredClone(state);
            state = applyChecked(state, { type: "dispatch_verified", at: at++, expected: expected(), agentId: verifying.agentId, verify: { passed: step === "pass", exitCode: step === "pass" ? 0 : 1, durationMs: 1 } });
            const again = applyOrchestrationEvent(state, { type: "dispatch_verified", at: at++, expected: expected(), agentId: verifying.agentId, verify: { passed: true, exitCode: 0, durationMs: 1 } });
            expect(again.applied).toBe(false);
            expect(before.work.flatMap((item) => item.dispatches).filter((d) => d.status === "verifying").length - 1)
              .toBe(state.work.flatMap((item) => item.dispatches).filter((d) => d.status === "verifying").length);
          } else if (step === "adopt") {
            const next = { sessionId: owner.sessionId, runtimeId: `runtime-${at}`, generation: actor.generation + 1 };
            const adopted = applyOrchestrationEvent(state, { type: "owner_adopted", at: state.owner.leaseExpiresAt + 1, expectedRevision: state.revision, owner: next });
            if (adopted.applied) {
              const verifyingBefore = state.work.filter((item) => item.dispatches.at(-1)?.status === "verifying").map((item) => item.id);
              state = adopted.state;
              actor = next;
              for (const id of verifyingBefore) expect(state.work.find((item) => item.id === id)?.dispatches.at(-1)?.status).toBe("verifying");
            }
          } else if (state.status !== "cancelled") {
            state = applyChecked(state, { type: "cancelled", at: at++, expected: expected() });
            expect(state.work.flatMap((item) => item.dispatches).some((d) => d.status === "verifying")).toBe(false);
          }
          const verifyingItems = state.work.filter((item) => item.dispatches.at(-1)?.status === "verifying");
          expect(verifyingItems.every((item) => item.status === "active")).toBe(true);
          expect(validatePersistedOrchestration(structuredClone(state))).toEqual(state);
        }
      },
    ), propertyOptions());
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
