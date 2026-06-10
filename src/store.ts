import { homedir } from "node:os";
import { join } from "node:path";
import { type LoopReducerEvent, type LoopReducerState, reduceLoopState } from "./loop-reducer.js";
import { ReducerBackedStore } from "./reducer-backed-store.js";
import type { LoopEntry, LoopStoreData, Trigger } from "./types.js";

const LOOPS_DIR = join(homedir(), ".pi", "loops");
const MAX_LOOPS = 25;

export class LoopStore extends ReducerBackedStore<LoopEntry, LoopReducerState, LoopReducerEvent, LoopStoreData> {
  constructor(listIdOrPath?: string) {
    super(
      {
        baseDir: LOOPS_DIR,
        reduce: (state, event) => reduceLoopState(state, event),
        toReducerState: (nextId, entries) => ({ nextId, loopsById: Object.fromEntries(entries.entries()) }),
        fromReducerState: (state) => ({ nextId: state.nextId, entries: new Map(Object.entries(state.loopsById)) }),
        serialize: (nextId, entries) => ({ nextId, loops: Array.from(entries.values()) }),
        deserialize: (data) => ({ nextId: data.nextId, entries: new Map(data.loops.map((l) => [l.id, l])) }),
      },
      listIdOrPath,
    );
  }

  create(trigger: Trigger, prompt: string, opts: { recurring: boolean; autoTask?: boolean; taskBacklog?: boolean; readOnly?: boolean; maxFires?: number }): LoopEntry {
    return this.withLock(() => {
      if (this.entries.size >= MAX_LOOPS) {
        throw new Error(`Maximum of ${MAX_LOOPS} loops reached. Delete some before creating new ones.`);
      }
      const now = Date.now();
      this.applyReducerEvent({
        type: "LOOP_CREATED",
        at: now,
        source: "tool",
        entityType: "loop",
        payload: {
          prompt,
          trigger,
          recurring: opts.recurring,
          autoTask: opts.autoTask,
          taskBacklog: opts.taskBacklog,
          readOnly: opts.readOnly,
          maxFires: opts.maxFires,
        },
      });
      return this.entries.get(String(this.nextId - 1))!;
    });
  }

  pause(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_PAUSED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  resume(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_RESUMED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  fire(id: string): LoopEntry | undefined {
    return this.withLock(() => {
      const entry = this.entries.get(id);
      if (!entry) return undefined;
      this.applyReducerEvent({
        type: "LOOP_FIRED",
        at: Date.now(),
        source: "system",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return this.entries.get(id);
    });
  }

  updateMetadata(id: string, fields: { trigger?: Trigger; prompt?: string }): { entry: LoopEntry | undefined; changedFields: string[] } {
    return this.withLock(() => {
      const current = this.entries.get(id);
      if (!current) return { entry: undefined, changedFields: [] };

      const changedFields: string[] = [];
      const now = Date.now();

      if (fields.trigger !== undefined) {
        current.trigger = fields.trigger;
        changedFields.push("trigger");
      }
      if (fields.prompt !== undefined) {
        current.prompt = fields.prompt;
        changedFields.push("prompt");
      }
      if (changedFields.length > 0) {
        current.updatedAt = now;
      }

      return { entry: this.entries.get(id), changedFields };
    });
  }

  delete(id: string): boolean {
    return this.withLock(() => {
      if (!this.entries.has(id)) return false;
      this.applyReducerEvent({
        type: "LOOP_DELETED",
        at: Date.now(),
        source: "tool",
        entityType: "loop",
        entityId: id,
        payload: { id },
      });
      return true;
    });
  }

  clearExpired(): number {
    return this.withLock(() => {
      const now = Date.now();
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (now < entry.expiresAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: now,
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "expires_at" },
        });
        count++;
      }
      return count;
    });
  }

  expireEventLoops(sessionStartedAt: number): number {
    return this.withLock(() => {
      let count = 0;
      for (const [id, entry] of [...this.entries.entries()]) {
        if (entry.status !== "active") continue;
        if (entry.trigger.type !== "event" && entry.trigger.type !== "hybrid") continue;
        if (entry.createdAt >= sessionStartedAt) continue;
        this.applyReducerEvent({
          type: "LOOP_EXPIRED",
          at: sessionStartedAt,
          source: "session",
          entityType: "loop",
          entityId: id,
          payload: { id, reason: "resume_event_stale" },
        });
        count++;
      }
      return count;
    });
  }

  clearAll(): number {
    return this.withLock(() => {
      const ids = [...this.entries.keys()];
      for (const id of ids) {
        this.applyReducerEvent({
          type: "LOOP_DELETED",
          at: Date.now(),
          source: "system",
          entityType: "loop",
          entityId: id,
          payload: { id },
        });
      }
      return ids.length;
    });
  }
}
