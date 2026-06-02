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
    expect(latestStatusCall()).toEqual(["loops", "1 monitor"]);
  });

  it("shows compact loop and monitor counts in status", () => {
    store.create(
      { type: "event", source: "monitor:done", filter: '{"monitorId":"5"}' },
      "Summarize the GitHub Actions run result",
      { recurring: false },
    );
    monitorManager._add({
      id: "2",
      command: "curl -s https://api.github.com/repos/u/r/actions/runs",
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "1 loop · 1 monitor"]);
  });

  it("shows task counts and only the active task focus text", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 2,
      focusText: "active: Fix native task fallback",
    }));

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "2 tasks | active: Fix native task fallback"]);
  });

  it("shows next task when no task is in progress", () => {
    widget.setTaskSummaryProvider(() => ({
      count: 3,
      focusText: "next: Write README updates",
    }));

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "3 tasks | next: Write README updates"]);
  });

  it("clears status after active content disappears", () => {
    monitorManager._add({
      id: "x", command: "true", status: "running", startedAt: Date.now(), outputLines: 0,
    });

    widget.update();
    expect(latestStatusCall()).toEqual(["loops", "1 monitor"]);

    monitorManager._clear();
    widget.update();
    expect(latestStatusCall()).toEqual(["loops", undefined]);
  });
});
