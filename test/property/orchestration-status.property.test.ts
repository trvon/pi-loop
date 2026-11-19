import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LoopStore } from "../../src/store.js";
import type { LoopEntry } from "../../src/types.js";
import { layoutProgressPanel, panelLineText } from "../../src/ui/progress-panel.js";
import { LoopWidget } from "../../src/ui/widget.js";
import { PANEL_NOW, panelOrchestration } from "../helpers/progress-panel-fixtures.js";
import { propertyOptions } from "./config.js";

type Settled = "completed" | "cancelled" | "needs_attention";
const OPEN = new Set(["active", "needs_attention"]);

/** The status line as the user sees it: the last value painted, or undefined when cleared. */
function statusLine(store: { list(): LoopEntry[] }): { read(): string | undefined; dispose(): void } {
  let painted: string | undefined;
  const widget = new LoopWidget(store as never, { list: () => [] } as never, "off");
  widget.setUICtx({ setStatus: (_key: string, value: string | undefined) => { painted = value; }, setWidget: () => {} } as never);
  return { read: () => { widget.update(); return painted; }, dispose: () => widget.dispose() };
}

function shownCount(line: string | undefined): number {
  const match = line?.match(/◇ (\d+) orchestrations?\b/);
  return match ? Number(match[1]) : 0;
}

function panelIds(loops: LoopEntry[]): string[] {
  return layoutProgressPanel({ loops, tasks: [], now: PANEL_NOW }, 80, 1_000)
    .map(panelLineText)
    .flatMap((line) => line.match(/^◇ #(\d+) /)?.[1] ?? []);
}

const snapshot = fc.uniqueArray(
  fc.record({
    id: fc.integer({ min: 1, max: 999 }).map(String),
    loopStatus: fc.constantFrom("active", "paused", "expired"),
    status: fc.constantFrom("active", "needs_attention", "completed", "cancelled"),
    work: fc.array(fc.constantFrom("pending", "active", "completed", "failed", "uncertain", "cancelled"), { maxLength: 6 }),
  }),
  { maxLength: 30, selector: (spec) => spec.id },
).map((specs) => specs.map((spec) => ({ ...panelOrchestration(spec.id, spec.work as never, spec.status as never), status: spec.loopStatus as LoopEntry["status"] })));

describe("orchestration status surfaces", () => {
  it("count exactly the orchestrations that are still running or need attention, for any snapshot", () => {
    fc.assert(
      fc.property(snapshot, (loops) => {
        const before = JSON.stringify(loops);
        const open = loops.filter((entry) => (entry.status === "active" || entry.status === "paused") && OPEN.has(entry.orchestration!.status));
        const status = statusLine({ list: () => loops });
        try {
          const line = status.read();
          expect(shownCount(line)).toBe(open.length);
          if (open.length === 0) expect(line).toBeUndefined();
          if (open.length === 1) expect(line).toContain(`| #${open[0]!.id} `);
        } finally {
          status.dispose();
        }
        // The panel lists the same set, in order, never a finished batch ahead of a running one.
        expect(panelIds(loops)).toEqual(open.slice(0, 2).map((entry) => entry.id));
        expect(JSON.stringify(loops)).toBe(before);
      }),
      propertyOptions(300),
    );
  });

  it("decrement when a batch settles or is deleted, through any order of starts and endings", () => {
    const op = fc.oneof(
      fc.record({ kind: fc.constant("create" as const) }),
      fc.record({ kind: fc.constant("settle" as const), pick: fc.nat(), to: fc.constantFrom<Settled>("completed", "cancelled", "needs_attention") }),
      fc.record({ kind: fc.constant("delete" as const), pick: fc.nat() }),
    );
    fc.assert(
      fc.property(fc.array(op, { maxLength: 40 }), (ops) => {
        const store = new LoopStore();
        const status = statusLine(store);
        const model = new Map<string, string>();
        try {
          for (const step of ops) {
            const ids = [...model.keys()];
            const previous = shownCount(status.read());
            if (step.kind === "create") {
              if (model.size >= 25) continue;
              const entry = store.create({ type: "dynamic" }, "Swarm", {
                recurring: true,
                orchestration: { owner: { sessionId: "s", runtimeId: "r", generation: 1 }, definition: { goal: "Swarm", work: [{ prompt: "A" }, { prompt: "B" }] } },
              });
              model.set(entry.id, "active");
            } else if (ids.length > 0) {
              const id = ids[step.pick % ids.length]!;
              if (step.kind === "delete") {
                store.delete(id);
                model.delete(id);
              } else if (model.get(id) === "active") {
                const entry = store.list().find((candidate) => candidate.id === id)!;
                entry.orchestration!.status = step.to;
                store.pause(id, "orchestration_settlement", "batch settled");
                model.set(id, step.to);
              }
            }
            const expected = [...model.values()].filter((value) => OPEN.has(value)).length;
            const shown = shownCount(status.read());
            expect(shown).toBe(expected);
            // Only a start may raise the number.
            if (step.kind !== "create") expect(shown).toBeLessThanOrEqual(previous);
          }
          // Everything finished: nothing is left on the bar, while the results stay stored.
          for (const [id, value] of model) {
            if (!OPEN.has(value)) continue;
            store.list().find((candidate) => candidate.id === id)!.orchestration!.status = "completed";
            if (value === "active") store.pause(id, "orchestration_settlement", "batch settled");
          }
          expect(status.read()).toBeUndefined();
          expect(store.list()).toHaveLength(model.size);
        } finally {
          status.dispose();
        }
      }),
      propertyOptions(200),
    );
  });
});
