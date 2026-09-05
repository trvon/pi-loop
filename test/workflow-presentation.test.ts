import { describe, expect, it } from "vitest";
import type { LoopEntry, WorkflowExecutionRecord } from "../src/types.js";
import {
  deriveWorkflowActivity,
  formatCompactWorkflowDuration,
  workflowLeaseLabel,
} from "../src/ui/workflow-presentation.js";

const NOW = 10_000;

function execution(overrides: Partial<WorkflowExecutionRecord> = {}): WorkflowExecutionRecord {
  return {
    id: "work:0",
    stateId: "work",
    transitionSeq: 0,
    subject: "Implement",
    description: "Implement the change.",
    status: "active",
    createdAt: 5_000,
    updatedAt: 5_000,
    ...overrides,
  };
}

function workflowEntry(overrides: Partial<LoopEntry> = {}): LoopEntry {
  return {
    id: "1",
    prompt: "Ship workflow activity UX",
    trigger: { type: "dynamic" },
    status: "active",
    recurring: true,
    createdAt: 1_000,
    updatedAt: 5_000,
    expiresAt: 100_000,
    dynamic: { goal: "Ship workflow activity UX", iteration: 0 },
    workflow: {
      definition: {
        version: 1,
        initialState: "work",
        states: {
          work: {
            prompt: "Implement.",
            task: { subject: "Implement", description: "Implement the change." },
            on: { done: "done" },
          },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
      definitionRevision: 1,
      revisionHistory: [],
      currentState: "work",
      transitionSeq: 0,
      stateEnteredAt: 5_000,
      attemptsByState: { work: 1 },
      stateFireCounts: { work: 0 },
      activeExecution: execution(),
    },
    ...overrides,
  };
}

describe("workflow activity presentation", () => {
  it("reports a live execution lease as claimed, not observed running", () => {
    const entry = workflowEntry();
    entry.workflow!.activeExecution!.lease = {
      ownerSessionId: "session",
      ownerRuntimeId: "runtime",
      acquiredAt: 6_000,
      heartbeatAt: 7_000,
      expiresAt: 20_000,
      attempt: 1,
    };

    expect(deriveWorkflowActivity(entry, NOW)).toEqual({
      status: "claimed",
      statusSince: 6_000,
      activityMs: 4_000,
      workflowAgeMs: 9_000,
      stateAgeMs: 5_000,
    });
    expect(workflowLeaseLabel(entry, NOW)).toContain("active until");
  });

  it("separates monitor waits from unowned, expired, and non-task idle work", () => {
    const unowned = workflowEntry();
    expect(deriveWorkflowActivity(unowned, NOW)).toMatchObject({ status: "idle", statusSince: 5_000 });

    const expired = workflowEntry();
    expired.workflow!.activeExecution!.lease = {
      ownerSessionId: "session",
      ownerRuntimeId: "runtime",
      acquiredAt: 4_000,
      heartbeatAt: 7_000,
      expiresAt: 8_000,
      attempt: 1,
    };
    expect(deriveWorkflowActivity(expired, NOW)).toMatchObject({ status: "idle", statusSince: 8_000 });
    expect(workflowLeaseLabel(expired, NOW)).toContain("expired at");

    const waiting = workflowEntry();
    waiting.workflow!.waitingMonitor = {
      monitorId: "3",
      stateId: "work",
      transitionSeq: 0,
      attachedAt: 7_000,
    };
    expect(deriveWorkflowActivity(waiting, NOW)).toMatchObject({ status: "waiting", statusSince: 7_000 });

    const nonTask = workflowEntry();
    nonTask.workflow!.definition.states.work = { prompt: "Review.", on: { done: "done" } };
    nonTask.workflow!.activeExecution = undefined;
    expect(deriveWorkflowActivity(nonTask, NOW)).toMatchObject({ status: "idle", statusSince: 5_000 });
  });

  it("derives paused from every durable pause provenance", () => {
    for (const kind of ["administrative", "controller_limit", "semantic_terminal", "orchestration_settlement"] as const) {
      const entry = workflowEntry({
        status: "paused",
        pause: { kind, at: 7_500, reason: "paused" },
      });

      expect(deriveWorkflowActivity(entry, NOW)).toMatchObject({
        status: "paused",
        statusSince: 7_500,
        activityMs: 2_500,
      });
    }
  });

  it("derives stopped for completed terminal snapshots and settled executions", () => {
    const terminal = workflowEntry({ updatedAt: 9_500 });
    terminal.workflow!.currentState = "done";
    terminal.workflow!.stateEnteredAt = 9_000;
    terminal.workflow!.activeExecution = undefined;
    expect(deriveWorkflowActivity(terminal, NOW)).toMatchObject({
      status: "stopped",
      statusSince: 9_500,
      workflowAgeMs: 8_500,
      stateAgeMs: 500,
    });

    const cancelled = workflowEntry();
    cancelled.workflow!.activeExecution = execution({
      status: "cancelled",
      settledAt: 9_000,
      updatedAt: 9_000,
    });
    expect(deriveWorkflowActivity(cancelled, NOW)).toMatchObject({ status: "stopped", statusSince: 9_000 });
  });

  it("clamps future timestamps and formats compact durations without noise", () => {
    const future = workflowEntry({ createdAt: 20_000, updatedAt: 20_000 });
    future.workflow!.stateEnteredAt = 20_000;
    future.workflow!.activeExecution = execution({ createdAt: 20_000, updatedAt: 20_000 });
    expect(deriveWorkflowActivity(future, NOW)).toMatchObject({
      activityMs: 0,
      workflowAgeMs: 0,
      stateAgeMs: 0,
    });

    expect(formatCompactWorkflowDuration(-1)).toBe("0s");
    expect(formatCompactWorkflowDuration(59_400)).toBe("59s");
    expect(formatCompactWorkflowDuration(90_000)).toBe("2m");
    expect(formatCompactWorkflowDuration(5_400_000)).toBe("2h");
  });
});
