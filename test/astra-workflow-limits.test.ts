import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";

describe("Astra workflow limit regressions", () => {
  let dir: string;
  let path: string;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    dir = mkdtempSync(join(tmpdir(), "pi-loop-astra-limits-"));
    path = join(dir, "loops.json");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.useRealTimers();
  });

  it.each(["workflow-wide", "state-local"] as const)("AUD-07: %s exhaustion rejects a second Store fire without a runtime pause", (limit) => {
    const a = new LoopStore(path);
    const entry = a.create({ type: "dynamic" }, "Poll release", {
      recurring: true,
      maxFires: limit === "workflow-wide" ? 1 : 10,
      workflow: {
        version: 1,
        initialState: "poll",
        states: {
          poll: {
            prompt: "Poll.",
            ...(limit === "state-local" ? { loop: { schedule: "* * * * *", maxFires: 1 } } : {}),
            on: { ready: "finish" },
          },
          finish: { prompt: "Finish.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const b = new LoopStore(path);
    expect(a.fire(entry.id)?.fireCount).toBe(1);
    const before = readFileSync(path, "utf8");

    expect.soft(b.fire(entry.id)).toBeUndefined();
    expect.soft(new LoopStore(path).get(entry.id)?.fireCount).toBe(1);
    expect.soft(readFileSync(path, "utf8")).toBe(before);
  });

  it.each(["workflow-wide", "state-local"] as const)("AUD-07: %s exhaustion rejects a nonterminal Store transition without a runtime pause", (limit) => {
    const a = new LoopStore(path);
    const entry = a.create({ type: "dynamic" }, "Poll release", {
      recurring: true,
      maxFires: limit === "workflow-wide" ? 1 : 10,
      workflow: {
        version: 1,
        initialState: "poll",
        states: {
          poll: {
            prompt: "Poll.",
            ...(limit === "state-local" ? { loop: { schedule: "* * * * *", maxFires: 1 } } : {}),
            on: { ready: "finish" },
          },
          finish: { prompt: "Finish.", on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const b = new LoopStore(path);
    expect(a.fire(entry.id)?.fireCount).toBe(1);
    const before = readFileSync(path, "utf8");
    const result = b.transitionWorkflow(entry.id, {
      outcome: "ready",
      ...(limit === "workflow-wide" ? { evidence: "Release is ready." } : {}),
    }, { currentState: "poll", transitionSeq: 0, definitionRevision: 1 });

    expect.soft(result.applied).toBe(false);
    expect.soft(new LoopStore(path).get(entry.id)?.workflow).toMatchObject({ currentState: "poll", transitionSeq: 0 });
    expect.soft(readFileSync(path, "utf8")).toBe(before);
  });
});
