import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { LoopWidget } from "../src/ui/widget.js";

vi.mock("@earendil-works/pi-tui", () => ({
  truncateToWidth: (line: string, width: number) =>
    line.length > width ? line.slice(0, width) : line,
}));

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
    list: () => monitors.filter(m => m.status === "running"),
    _add: (m: typeof monitors[0]) => monitors.push(m),
    _clear: () => { monitors.length = 0; },
  };
}

function createMockScheduler() {
  return { nextFire: () => undefined };
}

describe("LoopWidget rendering", () => {
  let store: LoopStore;
  let monitorManager: ReturnType<typeof createMockMonitorManager>;
  let mockTui: any;
  let widget: LoopWidget;

  beforeEach(() => {
    store = new LoopStore();
    monitorManager = createMockMonitorManager();
    widget = new LoopWidget(store, createMockScheduler() as any, monitorManager as any);
    mockTui = { terminal: { columns: 80 }, requestRender: vi.fn() };
  });

  afterEach(() => {
    widget.dispose();
  });

  function extractRenderLines(): string[] {
    let rendered: string[] = [];
    widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: (_key: string, factory: any) => {
        if (factory) {
          const widget = factory(mockTui, {});
          rendered = widget.render();
        }
      },
    });
    widget.update();
    return rendered;
  }

  it("shows monitor with description instead of raw command", () => {
    monitorManager._add({
      id: "1",
      command: "bash -lc 'set -euo pipefail\nwhile sleep 30; do hut builds show 1769753; done'",
      description: "Watch SourceHut build",
      status: "running",
      startedAt: Date.now(),
      outputLines: 42,
    });

    const lines = extractRenderLines();

    const hasDescription = lines.some(l => l.includes("Watch SourceHut build"));
    const hasRawCommand = lines.some(l => l.includes("pipefail") || l.includes("hut builds"));
    expect(hasDescription).toBe(true);
    expect(hasRawCommand).toBe(false);
  });

  it("collapses multi-line commands when no description is set", () => {
    monitorManager._add({
      id: "2",
      command: "bash -lc '\nset -euo pipefail\nhut builds show 1770173\n'",
      status: "running",
      startedAt: Date.now(),
      outputLines: 5,
    });

    const lines = extractRenderLines();

    const monitorLine = lines.find(l => l.includes("#2"));
    expect(monitorLine).toBeDefined();
    // Multi-line command is collapsed to single line: no literal newlines
    expect(monitorLine!).not.toContain("\n");
    // The collapsed command text should appear, just on one line
    expect(monitorLine!).toMatch(/bash -lc/);
  });

  it("shows simple commands directly when no description is set", () => {
    monitorManager._add({
      id: "3",
      command: "curl -s https://api.github.com/repos/u/r/actions/runs",
      status: "running",
      startedAt: Date.now(),
      outputLines: 0,
    });

    const lines = extractRenderLines();

    const monitorLine = lines.find(l => l.includes("#3"));
    expect(monitorLine).toBeDefined();
    expect(monitorLine!).toContain("curl -s");
  });

  it("renders loop with event trigger type", () => {
    const entry = store.create(
      { type: "event", source: "monitor:done", filter: '{"monitorId":"5"}' },
      "Summarize the GitHub Actions run result",
      { recurring: false },
    );

    const lines = extractRenderLines();

    const loopLine = lines.find(l => l.includes(`#${entry.id}`));
    expect(loopLine).toBeDefined();
    expect(loopLine!).toContain("Summarize the GitHub Actions");
    expect(loopLine!).toContain("event: monitor:done");
  });

  it("hides widget when no loops or monitors are active", () => {
    // Register widget first with active content
    monitorManager._add({
      id: "x", command: "true", status: "running", startedAt: Date.now(), outputLines: 0,
    });

    let currentFactory: any = null;
    widget.setUICtx({
      setStatus: vi.fn(),
      setWidget: vi.fn((_key: string, factory: any) => {
        currentFactory = factory;
      }),
    });
    widget.update(); // registers widget
    expect(currentFactory).not.toBeNull();

    // Now remove the monitor — widget should hide
    monitorManager._clear();

    let hideCalled = false;
    (widget as any).uiCtx!.setWidget = vi.fn((_key: string, factory: any) => {
      if (factory === undefined) hideCalled = true;
    });
    widget.update();

    expect(hideCalled).toBe(true);
  });
});
