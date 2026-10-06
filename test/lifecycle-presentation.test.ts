import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LoopStore } from "../src/store.js";
import type { LoopEntry } from "../src/types.js";
import { canResumeFromInspection, formatLoopLifecycle } from "../src/ui/lifecycle-presentation.js";

const NOW = Date.UTC(2026, 9, 6, 12);

function workflow(store: LoopStore, stateCap = false, maxFires?: number): LoopEntry {
  return store.create({ type: "dynamic" }, "Review", {
    recurring: true, maxFires,
    workflow: {
      version: 1, initialState: "work",
      states: {
        work: {
          prompt: "Review.", task: { subject: "Review", description: "Collect evidence." },
          on: { done: "done" },
          ...(stateCap ? { loop: { schedule: "*/5 * * * *", maxFires: 1 } } : {}),
        },
        done: { prompt: "Report.", terminal: "completed" },
      },
    },
  });
}

function freeze(entry: LoopEntry): LoopEntry {
  function visit(value: unknown): void {
    if (!value || typeof value !== "object") return;
    for (const child of Object.values(value)) visit(child);
    Object.freeze(value);
  }
  visit(entry);
  return entry;
}

function text(entry: LoopEntry): string {
  return formatLoopLifecycle(entry, { storageScope: "memory", now: NOW }).join("\n");
}

describe("lifecycle inspection expectations and invariants", () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); });
  afterEach(() => vi.useRealTimers());

  it.each([
    ["memory", "memory (process-local)"],
    ["session", "session file (isolated by session ID)"],
    ["project", "project file (shared; no scheduler owner election)"],
    ["custom", "custom file (PI_LOOP override)"],
  ] as const)("reports %s storage without a filesystem path", (storageScope, expected) => {
    const entry = new LoopStore().create({ type: "event", source: "deploy:done", filter: '{"token":"secret"}' }, "Inspect", { recurring: true });
    const output = formatLoopLifecycle(entry, { storageScope, now: NOW }).join("\n");
    expect(output).toContain(`Storage: ${expected}`);
    expect(output).toContain("Kind: event loop");
    expect(output).toContain("Trigger: event: deploy:done");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("token");
    expect(output).toContain("Next fire: not reported");
  });

  it("does not invent a persistence boundary when inspection context is unavailable", () => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Inspect", { recurring: true });
    expect(formatLoopLifecycle(entry, { now: NOW }).join("\n")).toContain("Storage: unknown");
  });

  it("distinguishes live lease ownership from execution and preserves frozen current state", () => {
    const store = new LoopStore();
    const entry = workflow(store);
    expect(store.claimWorkflowExecution(entry.id, { sessionId: "private-session", runtimeId: "private-runtime" }).claimed).toBe(true);
    const current = freeze(structuredClone(store.get(entry.id)!));
    const before = structuredClone(current);
    const output = text(current);
    expect(output).toContain("Authority: LoopStore (embedded workflow work; not TaskStore)");
    expect(output).toContain("Respect the live lease");
    expect(output).not.toContain("private-session");
    expect(output).not.toContain("private-runtime");
    expect(output).not.toContain("work is running");
    expect(current).toEqual(before);
  });

  it.each(["unowned", "expired"])("directs %s work to WorkflowClaim without claiming it", (kind) => {
    const store = new LoopStore();
    if (kind === "expired") vi.setSystemTime(NOW - 3_600_000);
    const entry = workflow(store);
    if (kind === "expired") {
      expect(store.claimWorkflowExecution(entry.id, { sessionId: "s", runtimeId: "r" }).claimed).toBe(true);
      vi.setSystemTime(NOW);
    }
    const current = freeze(structuredClone(store.get(entry.id)!));
    expect(text(current)).toContain("WorkflowClaim");
    expect(current.workflow?.activeExecution?.lease?.expiresAt ?? 0).toBeLessThanOrEqual(NOW);
  });

  it("directs monitor waits to outcome inspection without exposing output or recommending replay", () => {
    const entry = workflow(new LoopStore());
    entry.workflow!.waitingMonitor = { monitorId: "7", stateId: "work", transitionSeq: 0, attachedAt: NOW };
    const output = text(freeze(entry));
    expect(output).toContain("Inspect MonitorList");
    expect(output).toContain("do not re-run the command");
    expect(output).not.toContain("WorkflowClaim");
  });

  it.each(["administrative", undefined] as const)("allows explicit authorized resume for %s pause without doing it", (kind) => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Observe", { recurring: true });
    entry.status = "paused";
    entry.pause = kind ? { kind, at: NOW } : undefined;
    expect(canResumeFromInspection(entry, NOW)).toBe(true);
    expect(text(entry)).toContain(kind ? "Pause: administrative" : "Pause: legacy (unattributed)");
    expect(text(entry)).toContain("Resume explicitly when authorized");
    expect(entry.status).toBe("paused");
  });

  it.each(["administrative", undefined] as const)("matches Store.resume for %s provenance at a controller cap", (kind) => {
    const store = new LoopStore();
    const entry = workflow(store, false, 1);
    store.fire(entry.id);
    const current = store.get(entry.id)!;
    expect(current.fireCount).toBe(1);
    // Model persisted provenance that is not created by automatic cap settlement.
    current.pause = kind ? { kind, at: NOW } : undefined;
    const before = structuredClone(current);
    const eligible = canResumeFromInspection(freeze(structuredClone(current)), NOW);
    expect(store.get(entry.id)).toEqual(before);
    expect(eligible).toBe(Boolean(store.resume(entry.id)));
    expect(eligible).toBe(true);
    expect(store.get(entry.id)?.fireCount).toBe(1);
  });

  it("matches Store.resume for an exhausted task-backlog pause", () => {
    const store = new LoopStore();
    const entry = store.create({ type: "event", source: "tasks:created" }, "Adopt", {
      recurring: true, taskBacklog: true, maxFires: 1,
    });
    store.fire(entry.id);
    const current = freeze(structuredClone(store.get(entry.id)!));
    const eligible = canResumeFromInspection(current, NOW);
    expect(eligible).toBe(Boolean(store.resume(entry.id)));
    expect(eligible).toBe(false);
    expect(text(current)).toContain("do not resume an exhausted controller");
    expect(store.get(entry.id)).toEqual(current);
  });

  it("retains hybrid event and debounce information without leaking its filter", () => {
    const entry = new LoopStore().create({
      type: "hybrid", cron: "*/5 * * * *", debounceMs: 12_000,
      event: { source: "deploy:done", filter: '{"token":"secret"}' },
    }, "Inspect", { recurring: true });
    const output = text(freeze(entry));
    expect(output).toContain("Hybrid event: deploy:done · debounce: 12000ms");
    expect(output).not.toContain("secret");
    expect(output).not.toContain("token");
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 9e15])("does not invent a deadline from invalid scheduler value %s", (nextFireAt) => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Inspect", { recurring: true });
    expect(formatLoopLifecycle(freeze(entry), { now: NOW, nextFireAt }).join("\n")).toContain("Next fire: not reported");
  });

  it("does not offer resume for a workflow state cap and preserves the budget", () => {
    const store = new LoopStore();
    const entry = workflow(store, true);
    store.fire(entry.id);
    const current = freeze(structuredClone(store.get(entry.id)!));
    expect(canResumeFromInspection(current, NOW)).toBe(false);
    expect(text(current)).toContain("leave the exhausted state with an evidenced transition");
    expect(text(current)).toContain("State fires: 1/1");
    expect(current.workflow?.stateFireCounts.work).toBe(1);
  });

  it("rejects resume exactly at expiry, even if a scheduler boundary is supplied", () => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Observe", { recurring: true });
    entry.status = "paused";
    entry.expiresAt = NOW;
    expect(canResumeFromInspection(entry, NOW)).toBe(false);
    expect(formatLoopLifecycle(entry, { now: NOW, nextFireAt: NOW + 10 }).join("\n")).toContain("expired controllers cannot resume");
  });

  it("does not recommend resume for a semantic terminal", () => {
    const entry = workflow(new LoopStore());
    entry.workflow!.currentState = "done";
    entry.status = "paused";
    expect(canResumeFromInspection(entry, NOW)).toBe(false);
    expect(text(entry)).toContain("Inspect the terminal outcome; do not resume");
  });

  it("keeps orchestration intent and execution authorities distinct", () => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Parallel review", {
      recurring: true,
      orchestration: { owner: { sessionId: "s", runtimeId: "r", generation: 1 }, definition: { goal: "Review", work: [{ prompt: "Inspect" }] } },
    });
    entry.status = "paused";
    const output = text(freeze(entry));
    expect(output).toContain("Authority: LoopStore intent; pi-subagents execution");
    expect(output).toContain("OrchestrationGet");
    expect(canResumeFromInspection(entry, NOW)).toBe(false);
  });

  it("keeps task-backlog work owned by the task provider", () => {
    const entry = new LoopStore().create({ type: "event", source: "tasks:created" }, "Adopt tasks", {
      recurring: true, taskBacklog: true,
    });
    expect(text(entry)).toContain("Authority: LoopStore scheduling; standalone task provider work");
  });

  it("directs a pending dynamic update to continue instead of deleting the controller", () => {
    const entry = new LoopStore().create({ type: "dynamic" }, "Observe", { recurring: true, dynamic: { goal: "Observe", iteration: 1, awaitingUpdate: true } });
    expect(text(freeze(entry))).toContain("LoopUpdate");
    expect(text(entry)).toContain("continue while work remains");
    expect(text(entry)).not.toContain("LoopDelete");
  });

  it("preserves both file-backed snapshots during pure inspection", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loop-inspection-"));
    try {
      const path = join(dir, "loops.json");
      const store = new LoopStore(path);
      const entry = workflow(store);
      store.pause(entry.id);
      const primary = readFileSync(path);
      const previous = readFileSync(`${path}.prev`);
      const current = freeze(structuredClone(store.get(entry.id)!));
      text(current);
      canResumeFromInspection(current, NOW);
      expect(readFileSync(path)).toEqual(primary);
      expect(readFileSync(`${path}.prev`)).toEqual(previous);
      expect(store.get(entry.id)?.status).toBe("paused");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
