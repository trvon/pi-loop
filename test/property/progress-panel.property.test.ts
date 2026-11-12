import { visibleWidth } from "@earendil-works/pi-tui";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TaskEntry } from "../../src/task-types.js";
import type { LoopEntry } from "../../src/types.js";
import { setGlyphTier } from "../../src/ui/card-style.js";
import { layoutProgressPanel, panelLineText } from "../../src/ui/progress-panel.js";
import { ProgressPanelOverlay, renderProgressPanel } from "../../src/ui/progress-panel-overlay.js";
import { workflowCardPreview } from "../../src/ui/workflow-presentation.js";
import { PANEL_NOW, panelOrchestration, panelTask, panelWorkflow } from "../helpers/progress-panel-fixtures.js";
import { propertyOptions } from "./config.js";

// Hostile text: ANSI/OSC escapes, C0/C1 controls, wide and combining characters.
const hostileText = fc.oneof(
  fc.string({ maxLength: 60 }),
  fc.string({ unit: "grapheme", maxLength: 40 }),
  fc.array(fc.constantFrom("\u001b[31m", "\u001b]8;;x\u0007", "\u009b2J", "\n", "\r", "\t", "\u0000", "漢字", "🧪", "é", "x", " "), { maxLength: 30 })
    .map((parts) => parts.join("")),
);
const timestamp = fc.integer({ min: PANEL_NOW - 30 * 86_400_000, max: PANEL_NOW + 30 * 86_400_000 });

const task: fc.Arbitrary<TaskEntry> = fc.record({
  id: fc.integer({ min: 1, max: 999 }).map(String),
  status: fc.constantFrom("pending", "in_progress", "completed", "closed"),
  subject: hostileText,
  claim: fc.option(fc.record({ claimedAt: timestamp, leaseExpiresAt: timestamp }), { nil: undefined }),
}).map(({ id, status, subject, claim }) => panelTask(id, status, subject, claim));

const workflow: fc.Arbitrary<LoopEntry> = fc.record({
  id: fc.integer({ min: 1, max: 999 }).map(String),
  prompt: hostileText,
  states: fc.uniqueArray(hostileText.filter((name) => name.length > 0), { minLength: 1, maxLength: 14 }),
  currentIndex: fc.nat(),
  status: fc.constantFrom("active", "paused", "expired"),
  lease: fc.constantFrom("live", "expired", "none"),
  maxAttempts: fc.integer({ min: 1, max: 9 }),
  waitingMonitor: fc.option(hostileText, { nil: undefined }),
  danglingCurrent: fc.boolean(),
}).map((spec) => {
  const entry = panelWorkflow({
    ...spec,
    status: spec.status as LoopEntry["status"],
    lease: spec.lease as "live" | "expired" | "none",
    current: spec.states[spec.currentIndex % spec.states.length],
  });
  // Corrupt or mid-revision snapshots can name a state the definition lacks.
  if (spec.danglingCurrent && entry.workflow) entry.workflow.currentState = "\u001b[dangling";
  return entry;
});

const orchestration: fc.Arbitrary<LoopEntry> = fc.record({
  id: fc.integer({ min: 1, max: 999 }).map(String),
  work: fc.array(fc.constantFrom("pending", "active", "completed", "failed", "uncertain", "cancelled"), { maxLength: 32 }),
  status: fc.constantFrom("active", "needs_attention", "completed", "cancelled"),
}).map(({ id, work, status }) => panelOrchestration(id, work as never, status as never));

const input = fc.record({
  loops: fc.array(fc.oneof(workflow, orchestration), { maxLength: 8 }),
  tasks: fc.array(task, { maxLength: 30 }),
  now: timestamp,
});

const theme = { fg: (_tone: string, value: string) => value } as never;
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

describe("progress panel properties", () => {
  it("is total, bounded, escape-free, deterministic, and read-only for any snapshot", () => {
    fc.assert(
      fc.property(input, fc.integer({ min: -2, max: 90 }), fc.integer({ min: -2, max: 40 }), (snapshot, width, maxRows) => {
        const before = JSON.stringify(snapshot);
        const lines = layoutProgressPanel(snapshot, width, maxRows);

        expect(lines.length).toBeLessThanOrEqual(Math.max(0, maxRows));
        for (const line of lines) {
          const text = panelLineText(line);
          expect(visibleWidth(text)).toBeLessThanOrEqual(width);
          expect(text).not.toMatch(CONTROL);
        }
        expect(layoutProgressPanel(snapshot, width, maxRows)).toEqual(lines);
        expect(JSON.stringify(snapshot)).toBe(before);
      }),
      propertyOptions(300),
    );
  });

  it("shows exactly one current-state row per detailed workflow, even for dangling state names", () => {
    fc.assert(
      fc.property(fc.array(workflow, { maxLength: 6 }), timestamp, (loops, now) => {
        const shown = loops.filter((entry) => entry.status === "active" || entry.status === "paused").length;
        const current = layoutProgressPanel({ loops, tasks: [], now }, 80, 1_000)
          .map(panelLineText)
          .filter((line) => line.startsWith("  ▶ "));
        expect(current).toHaveLength(Math.min(shown, 2));
        for (const line of current) expect(line).toMatch(/ · try \d+(\/\d+)?$/);
      }),
      propertyOptions(300),
    );
  });

  it("keeps task rows and controller rows on their own authority", () => {
    fc.assert(
      fc.property(input, (snapshot) => {
        const rows = (value: typeof snapshot) => layoutProgressPanel(value, 60, 1_000).map(panelLineText);
        const controllerRows = rows({ ...snapshot, tasks: [] });
        const taskRows = rows({ ...snapshot, loops: [] });
        expect(controllerRows.some((line) => line.startsWith("□"))).toBe(false);
        expect(taskRows.some((line) => line.startsWith("◆") || line.startsWith("◇"))).toBe(false);
        // Composition is concatenation: neither source changes the other's rows.
        expect(rows(snapshot)).toEqual([...controllerRows, ...taskRows]);
      }),
      propertyOptions(200),
    );
  });

  it("frames every rendered line to exactly the overlay width", () => {
    fc.assert(
      fc.property(input, fc.integer({ min: 18, max: 80 }), (snapshot, width) => {
        for (const line of renderProgressPanel(theme, snapshot, width)) expect(visibleWidth(line)).toBe(width);
      }),
      propertyOptions(200),
    );
  });

  it("holds at most one open overlay across arbitrary sync, mode, and rebind sequences", () => {
    const step = fc.oneof(
      input.map((snapshot) => ({ kind: "sync" as const, snapshot })),
      fc.constant({ kind: "sync" as const, snapshot: { loops: [], tasks: [], now: PANEL_NOW } }),
      fc.constantFrom("auto", "off").map((mode) => ({ kind: "mode" as const, mode: mode as "auto" | "off" })),
      fc.integer({ min: 0, max: 2 }).map((index) => ({ kind: "rebind" as const, index })),
      fc.constant({ kind: "hostClose" as const }),
    );
    fc.assert(
      fc.asyncProperty(fc.array(step, { maxLength: 40 }), async (steps) => {
        const open = new Set<() => void>();
        const uis = [0, 1, 2].map(() => ({
          custom: (factory: (...args: unknown[]) => unknown) => new Promise<void>((resolve) => {
            const close = () => {
              open.delete(close);
              resolve();
            };
            open.add(close);
            factory({ requestRender() {} }, theme, {}, close);
          }),
        }));
        const panel = new ProgressPanelOverlay();
        panel.setUI(uis[0] as never);
        let mode: "auto" | "off" = "auto";
        for (const current of steps) {
          if (current.kind === "sync") panel.sync(current.snapshot);
          else if (current.kind === "mode") {
            mode = current.mode;
            panel.setMode(mode);
          }
          else if (current.kind === "rebind") panel.setUI(uis[current.index] as never);
          else for (const close of [...open]) close();
          await Promise.resolve();
          expect(open.size).toBeLessThanOrEqual(1);
          if (mode === "off") expect(open.size).toBe(0);
        }
        panel.dispose();
        expect(open.size).toBe(0);
      }),
      propertyOptions(150),
    );
  });

  it("gives every glyph tier one escape-free line carrying the same fields", () => {
    fc.assert(
      fc.property(workflow, timestamp, (entry, now) => {
        const before = JSON.stringify(entry);
        // Letters and digits only: glyphs and separators are presentation, not information.
        const fields = (line: string) => line.replace(/[^\p{L}\p{N}]+/gu, "");
        let reference: string | undefined;
        try {
          for (const tier of ["unicode", "nerd", "ascii"] as const) {
            setGlyphTier(tier);
            const lines = workflowCardPreview(entry, now).map(panelLineText);
            expect(lines).toHaveLength(1);
            expect(lines[0]).not.toMatch(CONTROL);
            reference ??= fields(lines[0] ?? "");
            expect(fields(lines[0] ?? "")).toBe(reference);
          }
        } finally {
          setGlyphTier("unicode");
        }
        expect(JSON.stringify(entry)).toBe(before);
      }),
      propertyOptions(300),
    );
  });
});
