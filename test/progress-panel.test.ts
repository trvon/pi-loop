import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import { layoutProgressPanel, panelLineText } from "../src/ui/progress-panel.js";
import {
  PANEL_MIN_TERMINAL_WIDTH,
  PANEL_WIDTH,
  ProgressPanelOverlay,
  renderProgressPanel,
  resolveProgressPanelMode,
} from "../src/ui/progress-panel-overlay.js";
import { LoopWidget } from "../src/ui/widget.js";
import { PANEL_NOW, panelOrchestration, panelTask, panelWorkflow } from "./helpers/progress-panel-fixtures.js";

const now = PANEL_NOW;
const text = (input: Parameters<typeof layoutProgressPanel>[0], width = 34, rows = 18) =>
  layoutProgressPanel(input, width, rows).map(panelLineText);
const theme = { fg: (_tone: string, value: string) => value } as any;

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Minimal stand-in for pi's ui.custom overlay contract. */
function createOverlayUi() {
  const mounts: Array<{ options: any; component: { render(width: number): string[] }; closed: boolean; requestRender: ReturnType<typeof vi.fn> }> = [];
  const ui = {
    setStatus: vi.fn(),
    custom: vi.fn((factory: any, options: any) => new Promise<void>((resolve) => {
      const requestRender = vi.fn();
      const mount = { options, component: undefined as any, closed: false, requestRender };
      mount.component = factory({ requestRender }, theme, {}, () => {
        mount.closed = true;
        resolve();
      });
      mounts.push(mount);
    })),
  };
  return { ui: ui as any, mounts };
}

// Feature expectations: no production defect/red-reproduction claim.
describe("progress panel layout", () => {
  it("shows a workflow as a vertical state trail with activity and available outcomes", () => {
    expect(text({ loops: [panelWorkflow()], tasks: [], now })).toEqual([
      "◆ #3 Ship migration",
      "  ✓ plan",
      "  ▶ implement · try 1/3",
      "    claimed 4m",
      "  ○ review",
      "  ○ done",
      "  → pass, retry",
    ]);
  });

  it("derives idle, waiting, and paused activity from authoritative fields only", () => {
    expect(text({ loops: [panelWorkflow({ lease: "expired" })], tasks: [], now })).toContain("    idle 1m");
    expect(text({ loops: [panelWorkflow({ lease: "none" })], tasks: [], now })).toContain("    idle 5m");
    expect(text({ loops: [panelWorkflow({ waitingMonitor: "7" })], tasks: [], now })).toContain("    waiting monitor #7 2m");
    expect(text({ loops: [panelWorkflow({ status: "paused" })], tasks: [], now })).toContain("    paused 2m");
  });

  it("lists workflows needing attention first and bounds detailed workflows", () => {
    const lines = text({
      loops: [
        panelWorkflow({ id: "1", prompt: "healthy" }),
        panelWorkflow({ id: "2", prompt: "unclaimed", lease: "none" }),
        panelWorkflow({ id: "3", prompt: "paused", status: "paused" }),
      ],
      tasks: [],
      now,
    }, 34, 40);
    const headings = lines.filter((line) => line.startsWith("◆"));
    expect(headings).toEqual(["◆ #3 paused", "◆ #2 unclaimed", "◆ … 1 more workflows"]);
  });

  it("windows a long state list around the current state", () => {
    const states = Array.from({ length: 12 }, (_, index) => `s${index}`);
    const lines = text({ loops: [panelWorkflow({ states, current: "s7" })], tasks: [], now });
    expect(lines).toContain("  ⋮ 5 earlier");
    expect(lines).toContain("  ▶ s7 · try 1/3");
    expect(lines).toContain("  ⋮ 1 later");
    expect(lines.filter((line) => /^ {2}[✓○▶] /.test(line))).toHaveLength(6);
  });

  it("shows task progress with in-progress work first, stale claims flagged, and overflow", () => {
    const tasks = [
      panelTask("1", "completed"),
      panelTask("2", "closed"),
      panelTask("3", "pending", "Add tests"),
      panelTask("4", "in_progress", "Write parser", { claimedAt: now - 720_000, leaseExpiresAt: now + 60_000 }),
      panelTask("5", "in_progress", "Dead owner", { claimedAt: now - 3_600_000, leaseExpiresAt: now - 1 }),
      ...["6", "7", "8", "9"].map((id) => panelTask(id, "pending")),
    ];
    expect(text({ loops: [], tasks, now }, 40)).toEqual([
      "□ Tasks 1/8 done",
      "  ◼ #4 12m Write parser",
      "  ◼ #5 stale claim 1h Dead owner",
      "  ◻ #3 Add tests",
      "  ◻ #6 task 6",
      "  ◻ #7 task 7",
      "  … 2 more",
    ]);
  });

  it("hides when nothing is in progress", () => {
    expect(text({ loops: [], tasks: [], now })).toEqual([]);
    expect(text({ loops: [], tasks: [panelTask("1", "completed"), panelTask("2", "closed")], now })).toEqual([]);
    expect(text({ loops: [panelWorkflow({ status: "expired" as any })], tasks: [], now })).toEqual([]);
    const cron = { ...panelWorkflow(), workflow: undefined, trigger: { type: "cron", schedule: "* * * * *" } } as any;
    expect(text({ loops: [cron], tasks: [], now })).toEqual([]);
    expect(text({ loops: [panelWorkflow()], tasks: [], now }, 15)).toEqual([]);
    expect(text({ loops: [panelWorkflow()], tasks: [], now }, 34, 0)).toEqual([]);
  });

  it("summarizes orchestration progress without claiming observed execution", () => {
    const lines = text({ loops: [panelOrchestration("7", ["completed", "active", "pending"])], tasks: [], now });
    expect(lines).toEqual(["◇ #7 1/3 1 reserved"]);
    expect(text({ loops: [panelOrchestration("8", ["failed"], "needs_attention")], tasks: [], now })).toEqual(["◇ #8 0/1 needs attention"]);
  });

  it("bounds rows and width, and strips control and escape bytes", () => {
    const hostile = panelWorkflow({ prompt: "evil\u001b[31m\nred\u0007 title that is far too long for the panel width", states: ["a\tb", "c\u009bd", "done"], current: "c\u009bd" });
    const lines = text({ loops: [hostile], tasks: [panelTask("1", "pending", "x\r\ny".repeat(30))], now }, 24, 5);
    expect(lines).toHaveLength(5);
    expect(lines.at(-1)).toMatch(/^… \d+ more rows$/);
    for (const line of lines) {
      expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    }
  });
});

describe("progress panel invariants", () => {
  it("keeps authority separated: task rows come only from tasks, workflow rows only from loops", () => {
    const workflowOnly = text({ loops: [panelWorkflow()], tasks: [], now });
    const tasksOnly = text({ loops: [], tasks: [panelTask("1", "pending")], now });
    expect(workflowOnly.some((line) => line.startsWith("□"))).toBe(false);
    expect(tasksOnly.some((line) => line.startsWith("◆") || line.startsWith("◇"))).toBe(false);
    // A workflow's embedded execution never appears as a standalone task row.
    expect(workflowOnly.join("\n")).not.toContain("Tasks");
  });

  it("never mutates its input", () => {
    const input = deepFreeze({
      loops: [panelWorkflow(), panelOrchestration("7", ["active"])],
      tasks: [panelTask("1", "in_progress", "x", { claimedAt: now - 1, leaseExpiresAt: now - 1 })],
      now,
    });
    const before = JSON.stringify(input);
    expect(() => layoutProgressPanel(input, 34, 18)).not.toThrow();
    expect(() => renderProgressPanel(theme, input, PANEL_WIDTH)).not.toThrow();
    expect(JSON.stringify(input)).toBe(before);
  });

  it("does not write, claim, or change file-backed stores when synced and rendered", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loop-panel-"));
    try {
      const store = new LoopStore(join(dir, "loops.json"));
      const tasks = new TaskStore(join(dir, "tasks.json"));
      store.create({ type: "dynamic" }, "Ship", {
        recurring: true,
        workflow: {
          version: 1,
          initialState: "work",
          states: {
            work: { prompt: "Work.", task: { subject: "Work", description: "Do it." }, on: { done: "done" } },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
      });
      tasks.create("standalone", "desc");
      const snapshot = () => [readFileSync(join(dir, "loops.json"), "utf8"), readFileSync(join(dir, "tasks.json"), "utf8")];
      const before = snapshot();
      const { ui, mounts } = createOverlayUi();
      const widget = new LoopWidget(store, { list: () => [] } as any);
      widget.setTaskListProvider(() => tasks.list());
      widget.setUICtx(ui);

      widget.update();
      widget.update();
      const rendered = mounts[0]?.component.render(PANEL_WIDTH) ?? [];
      widget.dispose();

      expect(rendered.join("\n")).toContain("#1 Ship");
      expect(rendered.join("\n")).toContain("#1 standalone");
      expect(snapshot()).toEqual(before);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // Review finding: only workflow leases scheduled a repaint, so a task claim
  // kept its live row until the next heartbeat after its lease expired.
  it("repaints at a task claim's lease expiry, not only at workflow lease expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    try {
      const tasks = new TaskStore();
      tasks.create("Write parser", "desc");
      tasks.claim("1", { claimId: "c", ownerSessionId: "s", ownerRuntimeId: "r", leaseMs: 60_000 });
      const { ui, mounts } = createOverlayUi();
      const widget = new LoopWidget(new LoopStore(), { list: () => [] } as any);
      widget.setTaskListProvider(() => tasks.list());
      widget.setUICtx(ui);
      const rendered = () => (mounts.at(-1)?.component.render(PANEL_WIDTH) ?? []).join("\n");

      widget.update();
      expect(rendered()).not.toContain("stale claim");
      vi.advanceTimersByTime(59_999);
      expect(rendered()).not.toContain("stale claim");
      vi.advanceTimersByTime(1);
      expect(rendered()).toContain("stale claim");

      // An already-expired claim must not schedule a zero-delay repaint loop.
      expect(vi.getTimerCount()).toBe(0);
      widget.dispose();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renders a frame whose every line is exactly the overlay width", () => {
    const lines = renderProgressPanel(theme, { loops: [panelWorkflow()], tasks: [panelTask("1", "pending")], now }, PANEL_WIDTH);
    expect(lines[0]).toMatch(/^╭─ pi-loop ─+$/);
    expect(lines.at(-1)).toMatch(/^╰─+$/);
    for (const line of lines) expect(visibleWidth(line)).toBe(PANEL_WIDTH);
    expect(renderProgressPanel(theme, undefined, PANEL_WIDTH)).toEqual([]);
    expect(renderProgressPanel(theme, { loops: [], tasks: [], now }, PANEL_WIDTH)).toEqual([]);
  });
});

describe("progress panel overlay lifecycle", () => {
  const busy = { loops: [panelWorkflow()], tasks: [], now };
  const idle = { loops: [], tasks: [], now };

  it("mounts a non-capturing top-right column only while something is in progress", () => {
    const { ui, mounts } = createOverlayUi();
    const panel = new ProgressPanelOverlay();
    panel.setUI(ui);

    panel.sync(idle);
    expect(ui.custom).not.toHaveBeenCalled();

    panel.sync(busy);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.options).toMatchObject({
      overlay: true,
      overlayOptions: { anchor: "top-right", width: PANEL_WIDTH, nonCapturing: true },
    });

    panel.sync(busy);
    expect(mounts).toHaveLength(1);
    expect(mounts[0]?.requestRender).toHaveBeenCalledTimes(1);

    panel.sync(idle);
    expect(mounts[0]?.closed).toBe(true);
    expect(mounts[0]?.component.render(PANEL_WIDTH)).toEqual([]);
  });

  it("stays hidden on narrow terminals", () => {
    const { ui, mounts } = createOverlayUi();
    const panel = new ProgressPanelOverlay();
    panel.setUI(ui);
    panel.sync(busy);
    const visible = mounts[0]?.options.overlayOptions.visible;
    expect(visible(PANEL_MIN_TERMINAL_WIDTH - 1, 40)).toBe(false);
    expect(visible(PANEL_MIN_TERMINAL_WIDTH, 40)).toBe(true);
  });

  it("never mounts when off, and closes when turned off", () => {
    const { ui, mounts } = createOverlayUi();
    const off = new ProgressPanelOverlay("off");
    off.setUI(ui);
    off.sync(busy);
    expect(ui.custom).not.toHaveBeenCalled();

    off.setMode("auto");
    expect(mounts).toHaveLength(1);
    off.setMode("off");
    expect(mounts[0]?.closed).toBe(true);
    expect(resolveProgressPanelMode("OFF ")).toBe("off");
    expect(resolveProgressPanelMode(undefined)).toBe("auto");
    expect(resolveProgressPanelMode("nonsense")).toBe("auto");
  });

  it("closes the old overlay on a UI rebind and remounts on the new UI", () => {
    const first = createOverlayUi();
    const second = createOverlayUi();
    const panel = new ProgressPanelOverlay();
    panel.setUI(first.ui);
    panel.sync(busy);
    panel.setUI(first.ui);
    expect(first.mounts[0]?.closed).toBe(false);

    panel.setUI(second.ui);
    expect(first.mounts[0]?.closed).toBe(true);
    // A stale overlay must not keep painting the new session's data.
    expect(first.mounts[0]?.component.render(PANEL_WIDTH)).toEqual([]);
    panel.sync(busy);
    expect(second.mounts).toHaveLength(1);

    panel.dispose();
    expect(second.mounts[0]?.closed).toBe(true);
  });

  it("recovers when the host closes the overlay or the UI is stale", async () => {
    const { ui, mounts } = createOverlayUi();
    const panel = new ProgressPanelOverlay();
    panel.setUI(ui);
    panel.sync(busy);
    mounts[0]?.requestRender.mockImplementation(() => {
      throw new Error("stale extension context");
    });
    expect(() => panel.sync(busy)).not.toThrow();
    await Promise.resolve();
    panel.sync(busy);
    expect(mounts).toHaveLength(2);

    const throwing = new ProgressPanelOverlay();
    throwing.setUI({ custom: () => { throw new Error("stale"); } } as any);
    expect(() => throwing.sync(busy)).not.toThrow();
    const headless = new ProgressPanelOverlay();
    headless.setUI({ setStatus: vi.fn() } as any);
    expect(() => headless.sync(busy)).not.toThrow();
  });
});
