import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { WorkflowDefinition } from "../../src/types.js";
import { createWorkflowRun, transitionWorkflowRun } from "../../src/workflow-reducer.js";
import { reviseWorkflowRun } from "../../src/workflow-revision.js";
import { propertyOptions } from "./config.js";

const definition: WorkflowDefinition = {
  version: 1,
  initialState: "left",
  states: {
    left: { prompt: "left", on: { next: "right", finish: "done" } },
    right: { prompt: "right", on: { next: "left", finish: "done" } },
    done: { prompt: "done", terminal: "completed" },
  },
};

describe("workflow properties", () => {
  it("applies declared edges exactly once and keeps failed transitions immutable", () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom("next", "finish", "invalid"), { maxLength: 100 }),
        (outcomes) => {
          let run = createWorkflowRun(definition, 0);
          let appliedCount = 0;

          outcomes.forEach((outcome, index) => {
            const before = structuredClone(run);
            const source = run.currentState;
            const target = run.definition.states[source]?.on?.[outcome];
            const result = transitionWorkflowRun(run, { outcome }, index + 1);

            if (target && !run.definition.states[source]?.terminal) {
              expect(result.applied).toBe(true);
              if (!result.applied) return;
              appliedCount++;
              expect(result.run.currentState).toBe(target);
              expect(result.run.transitionSeq).toBe(appliedCount);
              expect(result.run.lastTransition).toMatchObject({
                from: source,
                to: target,
                outcome,
                sequence: appliedCount,
              });
              run = result.run;
            } else {
              expect(result.applied).toBe(false);
              expect(run).toEqual(before);
            }
          });

          expect(run.transitionSeq).toBe(appliedCount);
          expect(Object.values(run.attemptsByState).reduce((sum, count) => sum + count, 0)).toBe(
            appliedCount + 1,
          );
        },
      ),
      propertyOptions(),
    );
  });

  it("never advances a self-loop beyond its declared attempt bound", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 20 }),
        fc.integer({ min: 0, max: 50 }),
        (maxAttempts, requestedTransitions) => {
          const bounded: WorkflowDefinition = {
            version: 1,
            initialState: "retry",
            states: {
              retry: { prompt: "Retry.", maxAttempts, on: { again: "retry", done: "done" } },
              done: { prompt: "Done.", terminal: "completed" },
            },
          };
          let run = createWorkflowRun(bounded, 0);
          let applied = 0;

          for (let index = 0; index < requestedTransitions; index++) {
            const before = structuredClone(run);
            const result = transitionWorkflowRun(run, { outcome: "again" }, index + 1);
            if (applied < maxAttempts - 1) {
              expect(result.applied).toBe(true);
              if (!result.applied) return;
              run = result.run;
              applied++;
            } else {
              expect(result).toMatchObject({ applied: false, failure: { code: "target_exhausted" } });
              expect(run).toEqual(before);
            }
          }

          expect(run.transitionSeq).toBe(applied);
          expect(run.attemptsByState.retry).toBe(applied + 1);
          expect(run.attemptsByState.retry).toBeLessThanOrEqual(maxAttempts);
        },
      ),
      propertyOptions(),
    );
  });

  it("revision success changes only definition audit fields and rejection is immutable", () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,40}$/).filter((prompt) => prompt.trim() !== "" && prompt !== "right"),
        fc.string({ minLength: 1, maxLength: 80 }).filter((reason) => reason.trim() !== ""),
        (prompt, reason) => {
          const actor = { sessionId: "property-session", runtimeId: "property-runtime" };
          const run = createWorkflowRun(definition, 0);
          const before = structuredClone(run);
          const result = reviseWorkflowRun(run, {
            expectedRevision: 1,
            expectedState: "left",
            expectedTransitionSeq: 0,
            reason,
            changes: [{ op: "revise_state", stateId: "right", prompt }],
            actor,
          }, 1);

          expect(result.applied).toBe(true);
          if (!result.applied) return;
          expect(result.run).toMatchObject({
            currentState: before.currentState,
            transitionSeq: before.transitionSeq,
            stateEnteredAt: before.stateEnteredAt,
            attemptsByState: before.attemptsByState,
            stateFireCounts: before.stateFireCounts,
            activeExecution: before.activeExecution,
            definitionRevision: 2,
            revisionHistory: [{ revision: 1, definition: before.definition }],
          });
          expect(result.run.definition.states.right?.prompt).toBe(prompt);
          expect(run).toEqual(before);

          const stale = reviseWorkflowRun(run, {
            expectedRevision: 2,
            expectedState: "left",
            expectedTransitionSeq: 0,
            reason,
            changes: [{ op: "revise_state", stateId: "right", prompt }],
            actor,
          }, 2);
          expect(stale).toMatchObject({ applied: false, failure: { code: "revision_conflict" } });
          expect(run).toEqual(before);
        },
      ),
      propertyOptions(),
    );
  });

  it("reissues active work without changing transition or lease authority", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.stringMatching(/^[A-Za-z][A-Za-z0-9 ._-]{0,40}$/).filter((prompt) => prompt.trim() !== ""),
          { minLength: 1, maxLength: 10 },
        ),
        (prompts) => {
          const actor = { sessionId: "property-session", runtimeId: "property-runtime" };
          const taskDefinition: WorkflowDefinition = {
            version: 1,
            initialState: "work",
            states: {
              work: {
                prompt: "Original.",
                task: { subject: "Original", description: "Original work." },
                on: { done: "complete" },
              },
              complete: { prompt: "Complete.", terminal: "completed" },
            },
          };
          let run = createWorkflowRun(taskDefinition, 0, actor);

          prompts.forEach((prompt, index) => {
            const before = structuredClone(run);
            const result = reviseWorkflowRun(run, {
              expectedRevision: index + 1,
              expectedState: "work",
              expectedTransitionSeq: 0,
              reason: `Reissue ${index + 1}`,
              changes: [{
                op: "reissue_state",
                stateId: "work",
                prompt,
                task: { subject: `Work ${index + 1}`, description: prompt },
              }],
              actor,
            }, index + 1);

            expect(result.applied).toBe(true);
            if (!result.applied) return;
            expect(result.run).toMatchObject({
              currentState: "work",
              transitionSeq: 0,
              definitionRevision: index + 2,
              activeExecution: {
                id: `work:0:r${index + 2}`,
                lease: before.activeExecution?.lease,
              },
            });
            expect(result.run.executionHistory).toHaveLength(index + 1);
            expect(result.run.executionHistory?.at(-1)).toMatchObject({
              id: before.activeExecution?.id,
              status: "cancelled",
              lease: undefined,
            });
            expect(run).toEqual(before);
            run = result.run;
          });
        },
      ),
      propertyOptions(),
    );
  });

  it("never exceeds generated max-attempt limits", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer({ min: 0, max: 100 }), (limit, attempts) => {
        const limited: WorkflowDefinition = {
          version: 1,
          initialState: "retry",
          states: {
            retry: { prompt: "retry", on: { again: "retry" }, maxAttempts: limit },
          },
        };
        let run = createWorkflowRun(limited, 0);
        let applied = 0;

        for (let index = 0; index < attempts; index++) {
          const result = transitionWorkflowRun(run, { outcome: "again" }, index + 1);
          if (!result.applied) {
            expect(result.failure).toMatchObject({
              code: "target_exhausted",
              maxAttempts: limit,
              targetState: "retry",
            });
            continue;
          }
          applied++;
          run = result.run;
        }

        expect(applied).toBe(Math.min(attempts, Math.max(0, limit - 1)));
        expect(run.attemptsByState.retry).toBe(Math.min(limit, attempts + 1));
      }),
      propertyOptions(),
    );
  });
});
