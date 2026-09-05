import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { LoopWidget } from "../src/ui/widget.js";

function createMockMonitorManager() {
  const monitors: Array<{
    id: string;
    command: string;
    description?: string;
    status: string;
    startedAt: number;
    outputLines: number;
    lastActivityAt?: number;
    lastOutputAt?: number;
    outputRatePerMinute?: number;
    progress?: { current?: number; total?: number; message?: string; source?: string; updatedAt?: number };
  }> = [];
  return {
    list: () => [...monitors],
    _add: (m: typeof monitors[0]) => monitors.push(m),
    _clear: () => { monitors.length = 0; },
  };
}

describe("LoopWidget status rendering", () => {
  let store: LoopStore;
  let monitorManager: ReturnType<typeof createMockMonitorManager>;
  let widget: LoopWidget;
  let setStatus: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    store = new LoopStore();
    monitorManager = createMockMonitorManager();
    widget = new LoopWidget(store, monitorManager as any);
    setStatus = vi.fn();
    widget.setUICtx({
      setStatus,
      setWidget: vi.fn(),
    } as any);
  });

  afterEach(() => {
    widget.dispose();
  });

  function latestStatusCall() {
    const calls = setStatus.mock.calls.filter((call) => call[0] === "loops");
    return calls[calls.length - 1];
  }

  it("clears status when no loops or monitors are active", () => {
    widget.update();
    expect(latestStatusCall()).toEqual(["loops", undefined]);
  });

  it("shows a compact monitor count in status", () => {
    monitorManager._add({
      id: "1",
      command: "bash -lc 'set -euo pipefail\nwhile sleep 30; do hut builds show 1769753; done'",
      description: "Watch SourceHut build",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor"]);
  });

  it("shows an explicit monitor percentage but does not infer one from output", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
      progress: { current: 25, total: 100, source: "jsonl", updatedAt: Date.now() },
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor | 25%"]);
  });

  it("shows a monitor status message when no percentage is available", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
      progress: { message: "waiting for validation", source: "jsonl", updatedAt: Date.now() },
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor | waiting for validation"]);
  });

  it("shows stale output alongside structured progress", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now() - 120000,
      outputLines: 42,
      progress: { current: 25, total: 100, source: "jsonl", updatedAt: Date.now() - 120000 },
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor | 25% · quiet 2m"]);
  });

  it("treats recent structured progress as monitor activity", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now() - 120000,
      lastOutputAt: Date.now() - 120000,
      outputLines: 42,
      progress: { message: "still working", source: "agent", updatedAt: Date.now() },
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor | still working"]);
  });

  it("uses authoritative activity for partial output", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now() - 120000,
      lastOutputAt: Date.now() - 120000,
      lastActivityAt: Date.now(),
      outputLines: 42,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor"]);
  });

  it("shows observed log velocity when a monitor has no structured progress", () => {
    monitorManager._add({
      id: "1",
      command: "python train.py",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
      lastOutputAt: Date.now(),
      outputRatePerMinute: 24,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor | 24 lines/min"]);
  });

  it("shows compact loop and monitor counts in status", () => {
    store.create(
      { type: "cron", schedule: "*/5 * * * *" },
      "Check CI status",
      { recurring: true },
    );
    monitorManager._add({
      id: "2",
      command: "curl -s https://api.github.com/repos/u/r/actions/runs",
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "↻ 1 loop · ▶ 1 monitor"]);
  });

  it("shows workflow count, activity, phase, and age separately from ordinary loops", () => {
    store.create(
      { type: "dynamic" },
      "Ship migration",
      {
        recurring: true,
        workflow: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: {
              prompt: "Investigate.",
              task: { subject: "Investigate", description: "Collect evidence." },
              maxAttempts: 2,
              on: { ready: "done" },
            },
            done: { prompt: "Report.", terminal: "completed" },
          },
        },
      },
    );

    widget.update();
    expect(latestStatusCall()).toEqual([
      "loops",
      "◆ 1 workflow | #1 idle 0s · investigate 0s · age 0s",
    ]);
  });

  it("keeps paused workflows visible with pause duration", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const entry = store.create({ type: "dynamic" }, "Ship migration", {
        recurring: true,
        workflow: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Investigate.", on: { done: "done" } },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
      });
      store.pause(entry.id, "administrative", "waiting for approval");
      vi.advanceTimersByTime(60_000);

      widget.update();
      expect(latestStatusCall()).toEqual([
        "loops",
        "◆ 1 workflow | #1 paused 1m · investigate 1m · age 1m",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("repaints when a live workflow lease expires", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const entry = store.create({ type: "dynamic" }, "Ship migration", {
        recurring: true,
        workflow: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: {
              prompt: "Investigate.",
              task: { subject: "Investigate", description: "Collect evidence." },
              on: { done: "done" },
            },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
      });
      expect(store.claimWorkflowExecution(entry.id, { sessionId: "session", runtimeId: "runtime" }, 60).claimed).toBe(true);

      widget.update();
      expect(latestStatusCall()?.[1]).toContain("#1 claimed 0s");

      vi.advanceTimersByTime(59_999);
      expect(latestStatusCall()?.[1]).toContain("#1 claimed 0s");

      vi.advanceTimersByTime(1);
      expect(latestStatusCall()).toEqual([
        "loops",
        "◆ 1 workflow | #1 idle 0s · investigate 1m · age 1m",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("shows orchestration count and bounded worker progress separately", () => {
    store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: {
          goal: "Parallel review",
          work: [{ prompt: "Inspect API" }, { prompt: "Inspect runtime" }],
          concurrency: 2,
        },
      },
    });

    widget.update();
    expect(latestStatusCall()).toEqual([
      "loops",
      "◇ 1 orchestration | #1 active · 0/2 complete · 0 reserved · 2 pending",
    ]);
  });

  it("keeps a completed orchestration visible until its durable results are deleted", () => {
    const entry = store.create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: {
        owner: { sessionId: "s", runtimeId: "r", generation: 1 },
        definition: { goal: "Parallel review", work: [{ prompt: "Inspect API" }] },
      },
    });
    entry.orchestration!.status = "completed";
    entry.orchestration!.work[0]!.status = "completed";
    store.pause(entry.id, "orchestration_settlement", "batch complete");

    widget.update();

    expect(latestStatusCall()).toEqual([
      "loops",
      "◇ 1 orchestration | #1 complete · 1/1 complete · 0 reserved",
    ]);
  });

  it("does not count one-shot monitor completion loops as visible loops in status", () => {
    store.create(
      { type: "event", source: "monitor:done", filter: '{"monitorId":"5"}' },
      "Summarize the GitHub Actions run result",
      { recurring: false },
    );
    monitorManager._add({
      id: "5",
      command: "curl -s https://api.github.com/repos/u/r/actions/runs",
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor"]);
  });

  it("hides completed monitors from the live status bar", () => {
    monitorManager._add({
      id: "done", command: "npm test", status: "completed", startedAt: Date.now(), outputLines: 12,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", undefined]);
  });

  it("shows task counts and only the active task focus text", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 2,
      focusText: "active: Fix native task fallback",
    }));

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "□ 2 tasks | active: Fix native task fallback"]);
  });

  it("shows next task when no task is in progress", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 3,
      focusText: "next: Write README updates",
    }));

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "□ 3 tasks | next: Write README updates"]);
  });

  it("clears status after active content disappears", () => {
    monitorManager._add({
      id: "x", command: "true", status: "running", startedAt: Date.now(), outputLines: 0,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "▶ 1 monitor"]);

    monitorManager._clear();
    widget.update();
    expect(latestStatusCall()).toEqual(["loops", undefined]);
  });
});
