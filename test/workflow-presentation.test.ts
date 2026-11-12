import { Text } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LoopEntry, WorkflowExecutionRecord } from "../src/types.js";
import { setGlyphTier } from "../src/ui/card-style.js";
import { panelLineText } from "../src/ui/progress-panel.js";
import {
  deriveWorkflowActivity,
  formatCompactWorkflowDuration,
  workflowCardPreview,
  workflowDisplayDetails,
  workflowLeaseLabel,
  workflowListPreview,
} from "../src/ui/workflow-presentation.js";
import { PANEL_NOW, panelWorkflow } from "./helpers/progress-panel-fixtures.js";

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

  // Feature expectation: the renderer shows 12 visual lines, so actionable rows must precede long prose.
  it("keeps lease and outcomes inside the visible card when the instruction is long", () => {
    const entry = panelWorkflow();
    // Review finding: a long goal alone could consume the visible lines.
    entry.prompt = "Ship the migration ".repeat(80);
    entry.workflow!.definition.states.implement!.prompt = "Follow every step carefully. ".repeat(40);
    vi.useFakeTimers();
    vi.setSystemTime(PANEL_NOW);
    let details: ReturnType<typeof workflowDisplayDetails>;
    try {
      details = workflowDisplayDetails({ entry, action: "inspect", tone: "info", summary: "Workflow #3" });
    } finally {
      vi.useRealTimers();
    }
    const rows = details.expanded ?? [];
    const visibleRows = new Text(rows.join("\n"), 0, 0).render(80).slice(0, 12).join("\n");

    expect(visibleRows).toContain("Lease: active until");
    expect(visibleRows).toContain("Outcomes: pass, retry");
    expect(visibleRows).toContain("State: implement");
    // Nothing is dropped from the full card; only the order changes.
    expect(rows.some((row) => row.startsWith("Instruction: Follow every step"))).toBe(true);
    expect(rows.some((row) => row.startsWith("Goal: Ship the migration"))).toBe(true);
    expect(rows.findIndex((row) => row.startsWith("Lease:"))).toBeLessThan(rows.findIndex((row) => row.startsWith("Instruction:")));
  });

  // Feature expectations: one dense preview line in portable glyphs.
  describe("card preview", () => {
    const preview = (entry: LoopEntry) => workflowCardPreview(entry, PANEL_NOW).map(panelLineText);
    afterEach(() => setGlyphTier("unicode"));

    it("shows trail, activity, attempt, and outcomes on one line", () => {
      expect(preview(panelWorkflow())).toEqual([
        "  ✓plan ▸ [implement] ▸ review ▸ done │ CLAIMED 4m │ try 1/3 │ » pass|retry",
      ]);
    });

    it("keeps the same fields and the bracketed current state in every glyph tier", () => {
      setGlyphTier("ascii");
      expect(preview(panelWorkflow())).toEqual(["  +plan > [implement] > review > done | CLAIMED 4m | try 1/3 | >> pass|retry"]);
      setGlyphTier("nerd");
      const nerd = preview(panelWorkflow())[0] ?? "";
      for (const field of ["plan", "[implement]", "review", "done", " │ CLAIMED 4m │ ", "try 1/3", "pass|retry"]) expect(nerd).toContain(field);
    });

    // Minimized from the generated tier-equivalence property: upper-casing the whole tag rewrote the monitor ID.
    it("never changes the case of a monitor identifier", () => {
      expect(preview(panelWorkflow({ waitingMonitor: "ᾀb" }))[0]).toContain(" │ WAITING MONITOR #ᾀb 2m │ ");
    });

    it("uses the summary's status word and flags work that still needs a claim", () => {
      expect(preview(panelWorkflow({ lease: "none" }))[0]).toContain(" │ IDLE 5m (unclaimed) │ ");
      expect(preview(panelWorkflow({ lease: "expired" }))[0]).toContain(" │ IDLE 1m (unclaimed) │ ");
      expect(preview(panelWorkflow({ status: "paused" }))[0]).toContain(" │ PAUSED 2m │ ");
      const entry = panelWorkflow({ lease: "none" });
      const details = workflowDisplayDetails({ entry, action: "transition", tone: "success", summary: "Workflow #3 advanced" });
      expect(details.summary).toContain(" · idle ");
    });

    it("marks revisited states and windows long definitions around the current state", () => {
      const rework = panelWorkflow({ visited: ["plan", "review"] });
      expect(preview(rework)[0]).toContain("✓plan ▸ [implement] ▸ ✓review ▸ done");
      const states = Array.from({ length: 12 }, (_, index) => `s${index}`);
      expect(preview(panelWorkflow({ states, current: "s7" }))[0]).toContain("… ▸ ✓s5 ▸ ✓s6 ▸ [s7] ▸ s8 ▸ s9 ▸ …");
      const hostile = preview(panelWorkflow({ states: ["a\u001b[31m", "b\nc", "done"], current: "b\nc" })).join("\n");
      expect(hostile).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    });

    it("gives several workflows a one-line roster and a single workflow its trail", () => {
      const one = panelWorkflow({ id: "1" });
      expect(workflowListPreview([one], PANEL_NOW)).toEqual(workflowCardPreview(one, PANEL_NOW));
      const many = [1, 2, 3, 4, 5].map((id) => panelWorkflow({ id: String(id), lease: id === 2 ? "none" : "live" }));
      expect(workflowListPreview(many, PANEL_NOW).map(panelLineText)).toEqual([
        "  #1 [implement] CLAIMED 4m │ #2 [implement] IDLE 5m (unclaimed) │ #3 [implement] CLAIMED 4m │ +2",
      ]);
      expect(workflowListPreview([{ ...one, workflow: undefined }], PANEL_NOW)).toEqual([]);
    });

    it("is attached to workflow tool cards, read-only, and empty without a workflow", () => {
      const entry = panelWorkflow();
      const details = workflowDisplayDetails({ entry, action: "claim", tone: "success", summary: "Workflow #3 claimed" });
      expect(details.preview?.map(panelLineText)[0]).toContain("[implement]");
      const before = JSON.stringify(entry);
      workflowCardPreview(entry, PANEL_NOW);
      expect(JSON.stringify(entry)).toBe(before);
      expect(workflowCardPreview({ ...entry, workflow: undefined }, PANEL_NOW)).toEqual([]);
    });
  });
});
