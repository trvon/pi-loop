import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const interposition = vi.hoisted(() => ({
  armed: false,
  observedOwnerName: "",
  staleOwnerPath: "",
  replacementOwnerPath: "",
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(source: import("node:fs").PathLike, destination: import("node:fs").PathLike) {
      const sourcePath = String(source);
      if (sourcePath.endsWith(".candidate") && actual.statSync(sourcePath).isDirectory()) {
        interposition.observedOwnerName = actual.readdirSync(sourcePath)[0] ?? "";
      }
      return actual.renameSync(source, destination);
    },
    readFileSync(path: import("node:fs").PathOrFileDescriptor, options?: unknown) {
      const pathText = String(path);
      const value = actual.readFileSync(path as never, options as never);
      if (interposition.armed && pathText === interposition.staleOwnerPath) {
        interposition.armed = false;
        const lockPath = dirname(pathText);
        actual.rmSync(lockPath, { recursive: true, force: true });
        actual.mkdirSync(lockPath);
        const replacementName = interposition.observedOwnerName === "owner"
          ? "owner"
          : `owner-${process.pid}-feedface`;
        interposition.replacementOwnerPath = join(lockPath, replacementName);
        actual.writeFileSync(interposition.replacementOwnerPath, `${process.pid}:feedface`);
      }
      return value;
    },
  };
});

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { AnyReducerEffect } from "../src/coordinator.js";
import { ReducerBackedStore, type ReducerResult } from "../src/reducer-backed-store.js";

interface Item { id: string; value: number }
interface State { nextId: number; itemsById: Record<string, Item> }
type Event = { type: "SET"; id: string; value: number };
interface Data { nextId: number; items: Item[] }

function reduce(state: State, event: Event): ReducerResult<State, AnyReducerEffect> {
  return {
    state: { ...state, itemsById: { ...state.itemsById, [event.id]: { id: event.id, value: event.value } } },
    effects: [],
  };
}

class ItemStore extends ReducerBackedStore<Item, State, Event, Data> {
  constructor(path: string) {
    super({
      baseDir: tmpdir(),
      reduce,
      toReducerState: (nextId, entries) => ({ nextId, itemsById: Object.fromEntries(entries) }),
      fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.itemsById)) }),
      serialize: (nextId, entries) => ({ nextId, items: [...entries.values()] }),
      deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.items.map((item) => [item.id, item])) }),
    }, path);
  }

  set(id: string, value: number): void {
    this.withLock(() => { this.applyReducerEvent({ type: "SET", id, value }); });
  }
}

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  interposition.armed = false;
  interposition.observedOwnerName = "";
  interposition.staleOwnerPath = "";
  interposition.replacementOwnerPath = "";
});

describe("stale lock replacement fencing", () => {
  it("does not remove a live owner published after stale-owner inspection", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-loop-lock-race-"));
    dirs.push(dir);
    const path = join(dir, "items.json");
    new ItemStore(path).set("x", 1);
    const before = readFileSync(path, "utf8");
    const lockPath = `${path}.lock`;
    mkdirSync(lockPath);
    const staleName = interposition.observedOwnerName === "owner"
      ? "owner"
      : "owner-999999-deadbeef";
    interposition.staleOwnerPath = join(lockPath, staleName);
    writeFileSync(interposition.staleOwnerPath, "999999:deadbeef");
    interposition.armed = true;
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (tick += 100));

    expect(() => new ItemStore(path).set("x", 2)).toThrow(/lock/i);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(interposition.replacementOwnerPath)).toBe(true);
    expect(readFileSync(interposition.replacementOwnerPath, "utf8")).toBe(`${process.pid}:feedface`);
  });
});
