import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { sameLoopActivation } from "../src/loop-activation.js";
import { LoopStore } from "../src/store.js";
import type { LoopEntry, Trigger } from "../src/types.js";

function activation(trigger: Trigger): LoopEntry {
  return { id: "1", prompt: "Work.", trigger, status: "active", recurring: true, createdAt: 1, updatedAt: 1, expiresAt: 100 };
}

const triggers: Trigger[] = [
  { type: "cron", schedule: "* * * * *" },
  { type: "event", source: "ready", filter: "{}" },
  { type: "hybrid", cron: "* * * * *", event: { source: "ready", filter: "{}" }, debounceMs: 1 },
  { type: "dynamic" },
];

describe("sameLoopActivation", () => {
  it.each(triggers)("accepts unchanged $type policies but rejects a different trigger kind", (trigger) => {
    const captured = activation(trigger);
    expect(sameLoopActivation(structuredClone(captured), captured)).toBe(true);
    const different = trigger.type === "dynamic" ? triggers[0]! : triggers[3]!;
    expect(sameLoopActivation(activation(different), captured)).toBe(false);
  });

  it.each<Trigger>([
    { type: "cron", schedule: "0 0 * * *" },
    { type: "event", source: "other", filter: "{}" },
    { type: "event", source: "ready", filter: "{\"ok\":true}" },
    { type: "hybrid", cron: "0 0 * * *", event: { source: "ready", filter: "{}" }, debounceMs: 1 },
    { type: "hybrid", cron: "* * * * *", event: { source: "other", filter: "{}" }, debounceMs: 1 },
    { type: "hybrid", cron: "* * * * *", event: { source: "ready", filter: "{\"ok\":true}" }, debounceMs: 1 },
    { type: "hybrid", cron: "* * * * *", event: { source: "ready", filter: "{}" }, debounceMs: 2 },
  ])("rejects changed $type policy", (trigger) => {
    const captured = activation(triggers.find((item) => item.type === trigger.type)!);
    expect(sameLoopActivation(activation(trigger), captured)).toBe(false);
  });

  it.each(["id", "createdAt", "state", "sequence", "revision", "execution", "monitor"] as const)("rejects changed %s identity", (field) => {
    const captured = new LoopStore().create({ type: "dynamic" }, "Work", {
      recurring: true,
      actor: { sessionId: "s", runtimeId: "r" },
      workflow: {
        version: 1, initialState: "work",
        states: {
          work: { prompt: "Work.", task: { subject: "Work", description: "Work." }, on: { done: "done" } },
          done: { prompt: "Done.", terminal: "completed" },
        },
      },
    });
    const current = structuredClone(captured);
    if (field === "id") current.id = "2";
    if (field === "createdAt") current.createdAt++;
    if (field === "state") current.workflow!.currentState = "done";
    if (field === "sequence") current.workflow!.transitionSeq++;
    if (field === "revision") current.workflow!.definitionRevision++;
    if (field === "execution") current.workflow!.activeExecution!.id += "-replacement";
    if (field === "monitor") current.workflow!.waitingMonitor = { monitorId: "1", stateId: "work", transitionSeq: 0, attachedAt: 1 };
    expect(sameLoopActivation(current, captured)).toBe(false);
  });

  it("ignores mutable fire accounting and bookkeeping", () => {
    const captured = activation({ type: "dynamic" });
    expect(sameLoopActivation({ ...captured, updatedAt: 2, fireCount: 1, dynamic: { goal: "Work", iteration: 1, awaitingUpdate: true } }, captured)).toBe(true);
  });
});

describe("LoopStore expiry controller identity", () => {
  it.each(["createdAt", "expiresAt"] as const)("rejects stale %s without changing state or recovery bytes", (field) => {
    const root = mkdtempSync(join(tmpdir(), "pi-loop-expiry-cas-"));
    const path = join(root, "loops.json");
    try {
      const store = new LoopStore(path);
      const entry = store.create({ type: "event", source: "ready" }, "Expire only this controller", { recurring: true });
      const expected = { createdAt: entry.createdAt, expiresAt: entry.expiresAt };
      expected[field]--;
      const before = readFileSync(path, "utf8");
      const previous = existsSync(`${path}.prev`) ? readFileSync(`${path}.prev`, "utf8") : undefined;
      expect(store.expireEntry(entry.id, entry.expiresAt, expected)).toBeUndefined();
      expect(store.get(entry.id)).toEqual(entry);
      expect(readFileSync(path, "utf8")).toBe(before);
      expect(existsSync(`${path}.prev`) ? readFileSync(`${path}.prev`, "utf8") : undefined).toBe(previous);
      expect(store.expireEntry(entry.id, entry.expiresAt, { createdAt: entry.createdAt, expiresAt: entry.expiresAt })).toMatchObject({ disposition: "deleted" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
