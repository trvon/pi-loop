import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { LoopStore } from "../../src/store.js";
import { TaskStore } from "../../src/task-store.js";
import type { TaskStatus } from "../../src/task-types.js";
import { propertyOptions } from "./config.js";

type ModelTask = {
  id: string;
  subject: string;
  description: string;
  status: TaskStatus;
};

type StoreCommand =
  | { kind: "create"; subject: string; description: string }
  | { kind: "start" | "complete" | "reopen" | "delete"; id: number }
  | { kind: "update"; id: number; subject: string; description: string };

const text = fc.string({ maxLength: 30 });
const id = fc.integer({ min: 1, max: 15 });
const command: fc.Arbitrary<StoreCommand> = fc.oneof(
  fc.record({ kind: fc.constant<"create">("create"), subject: text, description: text }),
  fc.record({ kind: fc.constantFrom("start", "complete", "reopen", "delete"), id }),
  fc.record({ kind: fc.constant<"update">("update"), id, subject: text, description: text }),
);

function normalizedTasks(store: TaskStore): ModelTask[] {
  return store.list().map(({ id: taskId, subject, description, status }) => ({
    id: taskId,
    subject,
    description,
    status,
  }));
}

describe("workflow store properties", () => {
  it("never persists more fires than the selected controller cap", () => {
    fc.assert(
      fc.property(
        fc.constantFrom("workflow-wide", "state-local"),
        fc.integer({ min: 1, max: 8 }),
        fc.integer({ min: 1, max: 16 }),
        (limitKind, limit, attempts) => {
          const directory = mkdtempSync(join(tmpdir(), "pi-loop-workflow-property-"));
          const path = join(directory, "loops.json");
          try {
            const store = new LoopStore(path);
            const entry = store.create({ type: "dynamic" }, "Poll", {
              recurring: true,
              maxFires: limitKind === "workflow-wide" ? limit : limit + attempts + 1,
              workflow: {
                version: 1,
                initialState: "poll",
                states: {
                  poll: {
                    prompt: "Poll.",
                    loop: {
                      schedule: "* * * * *",
                      ...(limitKind === "state-local" ? { maxFires: limit } : {}),
                    },
                    on: { done: "done" },
                  },
                  done: { prompt: "Done.", terminal: "completed" },
                },
              },
            });

            for (let index = 0; index < attempts; index++) new LoopStore(path).fire(entry.id);

            const persisted = new LoopStore(path).get(entry.id);
            expect(persisted?.fireCount).toBe(Math.min(attempts, limit));
            expect(persisted?.workflow?.stateFireCounts.poll).toBe(Math.min(attempts, limit));
            expect(persisted?.status).toBe(attempts >= limit ? "paused" : "active");
          } finally {
            rmSync(directory, { recursive: true, force: true });
          }
        },
      ),
      propertyOptions(30, 100),
    );
  });
});

describe("task store properties", () => {
  it("preserves randomized command sequences across every reopen", () => {
    fc.assert(
      fc.property(fc.array(command, { maxLength: 30 }), (commands) => {
        const directory = mkdtempSync(join(tmpdir(), "pi-loop-property-"));
        const path = join(directory, "tasks.json");
        const model = new Map<string, ModelTask>();
        let nextId = 1;
        let store = new TaskStore(path);

        try {
          for (const current of commands) {
            if (current.kind === "create") {
              const created = store.create(current.subject, current.description);
              const taskId = String(nextId++);
              expect(created.id).toBe(taskId);
              model.set(taskId, {
                id: taskId,
                subject: current.subject,
                description: current.description,
                status: "pending",
              });
            } else {
              const taskId = String(current.id);
              const existing = model.get(taskId);
              switch (current.kind) {
                case "start": {
                  const allowed = existing !== undefined
                    && (existing.status === "pending" || existing.status === "in_progress");
                  expect(store.start(taskId) === undefined).toBe(!allowed);
                  if (allowed) existing.status = "in_progress";
                  break;
                }
                case "complete": {
                  const allowed = existing !== undefined
                    && (existing.status === "pending" || existing.status === "in_progress");
                  expect(store.complete(taskId) === undefined).toBe(!allowed);
                  if (allowed) existing.status = "completed";
                  break;
                }
                case "reopen": {
                  const allowed = existing?.status === "completed";
                  expect(store.reopen(taskId) === undefined).toBe(!allowed);
                  if (allowed) existing.status = "pending";
                  break;
                }
                case "delete":
                  expect(store.delete(taskId)).toBe(existing !== undefined);
                  model.delete(taskId);
                  break;
                case "update":
                  expect(
                    store.updateDetails(taskId, {
                      subject: current.subject,
                      description: current.description,
                    }) === undefined,
                  ).toBe(existing === undefined);
                  if (existing) {
                    existing.subject = current.subject;
                    existing.description = current.description;
                  }
                  break;
              }
            }

            store = new TaskStore(path);
            const expected = [...model.values()].sort((left, right) => Number(left.id) - Number(right.id));
            expect(normalizedTasks(store)).toEqual(expected);
          }
        } finally {
          rmSync(directory, { recursive: true, force: true });
        }
      }),
      propertyOptions(25, 250),
    );
  });
});
