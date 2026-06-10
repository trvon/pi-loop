import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AnyReducerEffect } from "../src/coordinator.js";
import { ReducerBackedStore } from "../src/reducer-backed-store.js";

// Minimal concrete store to exercise the base contract in isolation.
interface Item {
  id: string;
  value: number;
}
interface ItemState {
  nextId: number;
  itemsById: Record<string, Item>;
}
interface ItemData {
  nextId: number;
  items: Item[];
}
type ItemEvent =
  | { type: "ITEM_SET"; id: string; value: number }
  | { type: "ITEM_NOOP" };

function reduceItem(state: ItemState, event: ItemEvent): { state: ItemState; effects: AnyReducerEffect[] } {
  if (event.type === "ITEM_SET") {
    const item: Item = { id: event.id, value: event.value };
    const isNew = !state.itemsById[event.id];
    return {
      state: {
        nextId: isNew ? state.nextId + 1 : state.nextId,
        itemsById: { ...state.itemsById, [event.id]: item },
      },
      effects: [{ type: "PERSIST_ITEM", entityId: event.id, payload: { item } }],
    };
  }
  return { state, effects: [] };
}

class ItemStore extends ReducerBackedStore<Item, ItemState, ItemEvent, ItemData> {
  readonly seenEffects: AnyReducerEffect[][] = [];

  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: join(tmpdir(), "pi-loop-item-store"),
        reduce: reduceItem,
        toReducerState: (nextId, entries) => ({ nextId, itemsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.itemsById)) }),
        serialize: (nextId, entries) => ({ nextId, items: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.items.map((i) => [i.id, i])) }),
      },
      listIdOrPath,
    );
  }

  protected override onEffects(effects: AnyReducerEffect[]): void {
    this.seenEffects.push(effects);
  }

  set(id: string, value: number): void {
    this.withLock(() => {
      this.applyReducerEvent({ type: "ITEM_SET", id, value });
    });
  }

  noop(): void {
    this.withLock(() => {
      this.applyReducerEvent({ type: "ITEM_NOOP" });
    });
  }
}

describe("ReducerBackedStore", () => {
  it("forwards reducer effects to the onEffects sink instead of dropping them", () => {
    const store = new ItemStore();
    store.set("a", 1);

    expect(store.seenEffects).toHaveLength(1);
    expect(store.seenEffects[0]).toEqual([
      { type: "PERSIST_ITEM", entityId: "a", payload: { item: { id: "a", value: 1 } } },
    ]);
  });

  it("does not invoke the sink when a reducer emits no effects", () => {
    const store = new ItemStore();
    store.noop();
    expect(store.seenEffects).toHaveLength(0);
  });

  it("applies reducer state back into get/list", () => {
    const store = new ItemStore();
    store.set("a", 1);
    store.set("b", 2);

    expect(store.get("a")).toEqual({ id: "a", value: 1 });
    expect(store.list()).toEqual([
      { id: "a", value: 1 },
      { id: "b", value: 2 },
    ]);
  });

  describe("file-backed persistence", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "pi-loop-rbs-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("persists through withLock and reloads from disk", () => {
      const path = join(dir, "items.json");
      const a = new ItemStore(path);
      a.set("x", 42);

      expect(existsSync(path)).toBe(true);
      const onDisk: ItemData = JSON.parse(readFileSync(path, "utf-8"));
      expect(onDisk.items).toEqual([{ id: "x", value: 42 }]);

      // A second store reading the same file sees the persisted entry.
      const b = new ItemStore(path);
      expect(b.get("x")).toEqual({ id: "x", value: 42 });
    });

    it("deleteFileIfEmpty removes the backing file only when empty", () => {
      const path = join(dir, "items.json");
      const store = new ItemStore(path);
      store.set("x", 1);
      expect(store.deleteFileIfEmpty()).toBe(false);
      expect(existsSync(path)).toBe(true);
    });
  });
});
