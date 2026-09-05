import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { applyOrchestrationEvent, createOrchestrationState, hasUnconfirmedDispatches, normalizeOrchestrationStops } from "../src/orchestration-reducer.js";
import { LoopStore } from "../src/store.js";
import type { OrchestrationState } from "../src/types.js";

const owner = { sessionId: "s", runtimeId: "r", generation: 1 };
const expected = (state: OrchestrationState) => ({ revision: state.revision, ownerRuntimeId: state.owner.runtimeId, generation: state.owner.generation });
function spawning() {
  const initial = createOrchestrationState({ goal: "check", work: [{ prompt: "work" }], maxAttempts: 3 }, owner, 1);
  return applyOrchestrationEvent(initial, { type: "dispatch_requested", expected: expected(initial), at: 2, workId: "1", dispatchId: "d1" }).state;
}
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("orchestration stop authority", () => {
  it.each(["stopped", "interrupted", "uncertain"] as const)("normalizes legacy %s without renewing work", (status) => {
    const state = spawning();
    state.work[0]!.dispatches[0]!.status = status;
    state.work[0]!.dispatches[0]!.consumeStatus = "pending";
    state.work[0]!.status = "pending";
    const before = structuredClone(state);
    const normalized = normalizeOrchestrationStops(state);
    expect(state).toEqual(before);
    expect(normalized).toMatchObject({ status: "needs_attention", work: [{ status: "uncertain", dispatches: [{ status: "uncertain", consumeStatus: "unavailable" }] }] });
    expect(normalizeOrchestrationStops(normalized)).toEqual(normalized);
    expect(applyOrchestrationEvent(normalized, { type: "dispatch_requested", expected: expected(normalized), at: 5, workId: "1", dispatchId: "d2" }).applied).toBe(false);
  });

  it("binds a late reply to cancelled uncertainty without restoring execution", () => {
    const state = spawning();
    const cancelled = applyOrchestrationEvent(state, { type: "cancelled", expected: expected(state), at: 3 }).state;
    const event = { type: "cleanup_bound" as const, expected: expected(cancelled), at: 4, workId: "1", dispatchId: "d1", attempt: 1, agentId: "late" };
    const before = structuredClone(cancelled);
    for (const change of [{ attempt: 2 }, { dispatchId: "different" }, { expected: { ...expected(cancelled), generation: 2 } }]) {
      expect(applyOrchestrationEvent(cancelled, { ...event, ...change }).applied).toBe(false);
      expect(cancelled).toEqual(before);
    }
    const bound = applyOrchestrationEvent(cancelled, event).state;
    expect(bound).toMatchObject({ status: "cancelled", work: [{ status: "cancelled", dispatches: [{ agentId: "late", status: "uncertain", consumeStatus: "unavailable" }] }] });
    expect(applyOrchestrationEvent(bound, { ...event, expected: expected(bound), agentId: "replacement" }).applied).toBe(false);
    for (const outcome of ["completed", "failed"] as const) {
      expect(applyOrchestrationEvent(bound, { type: "dispatch_settled", expected: expected(bound), at: 5, agentId: "late", outcome }).applied).toBe(false);
    }
    expect(hasUnconfirmedDispatches(bound)).toBe(true);
  });

  it("retains cancelled and unidentified history across file-backed reload and repeated deletion", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loop-stop-"));
    dirs.push(dir);
    const path = join(dir, "loops.json");
    const store = new LoopStore(path);
    const entry = store.create({ type: "dynamic" }, "check", { recurring: true, orchestration: { owner, definition: { goal: "check", work: [{ prompt: "work" }] } } });
    store.mutateOrchestration(entry.id, { type: "dispatch_requested", expected: expected(entry.orchestration!), at: 2, workId: "1", dispatchId: "d1" });
    const current = store.get(entry.id)!.orchestration!;
    store.mutateOrchestration(entry.id, { type: "cancelled", expected: expected(current), at: 3 });
    store.pause(entry.id);
    const before = readFileSync(path, "utf8");
    const reloaded = new LoopStore(path);
    expect(reloaded.delete(entry.id)).toBe(false);
    expect(reloaded.delete(entry.id)).toBe(false);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(reloaded.get(entry.id)?.orchestration?.work[0]?.dispatches[0]?.status).toBe("uncertain");

    const raw = JSON.parse(before);
    raw.loops[0].orchestration.work[0].dispatches[0].status = "stopped";
    raw.loops[0].orchestration.work[0].dispatches[0].consumeStatus = "pending";
    writeFileSync(path, JSON.stringify(raw));
    const migrated = new LoopStore(path);
    expect(migrated.get(entry.id)?.orchestration?.work[0]?.dispatches[0]).toMatchObject({ status: "uncertain", consumeStatus: "unavailable" });
    expect(migrated.delete(entry.id)).toBe(false);
  });

  it("allows deletion of never-dispatched and normally settled controls", () => {
    for (const settle of [false, true]) {
      const store = new LoopStore();
      const entry = store.create({ type: "dynamic" }, "check", { recurring: true, orchestration: { owner, definition: { goal: "check", work: [{ prompt: "work" }] } } });
      if (settle) {
        store.mutateOrchestration(entry.id, { type: "dispatch_requested", expected: expected(store.get(entry.id)!.orchestration!), at: 2, workId: "1", dispatchId: "d1" });
        store.mutateOrchestration(entry.id, { type: "dispatch_bound", expected: expected(store.get(entry.id)!.orchestration!), at: 3, workId: "1", dispatchId: "d1", agentId: "done" });
        store.mutateOrchestration(entry.id, { type: "dispatch_settled", expected: expected(store.get(entry.id)!.orchestration!), at: 4, agentId: "done", outcome: "completed" });
      }
      expect(store.delete(entry.id)).toBe(true);
    }
  });
});
