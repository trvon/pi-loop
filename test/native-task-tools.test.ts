import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { type NativeTaskToolsOptions, registerNativeTaskTools } from "../src/tools/native-task-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

function setup(backlog: NativeTaskToolsOptions["evaluateTaskBacklog"] = vi.fn(async () => ({ created: false }))) {
  const { pi, toolMap, emittedEvents } = createMockPi();
  const taskStore = new TaskStore();
  registerNativeTaskTools({ pi, taskStore, evaluateTaskBacklog: backlog, updateWidget: vi.fn() });
  const tool = (name: string) => toolMap.get(name)!;
  const text = async (name: string, args: any) => (await tool(name).execute!("t", args)).content[0].text as string;
  return { taskStore, tool, text, emittedEvents };
}

describe("TaskCreate", () => {
  it("creates a task and emits tasks:created", async () => {
    const { taskStore, text, emittedEvents } = setup();
    const out = await text("TaskCreate", { subject: "Fix bug", description: "the details" });
    expect(out).toBe("Task #1 created: Fix bug");
    expect(taskStore.get("1")?.subject).toBe("Fix bug");
    expect(emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === "1")).toBe(true);
  });

  it("appends a backlog-worker note when one is created", async () => {
    const { text } = setup(vi.fn(async () => ({ created: true, entry: { id: "9" } })));
    const out = await text("TaskCreate", { subject: "x", description: "y" });
    expect(out).toContain("Backlog worker loop #9 created");
  });
});

describe("TaskList", () => {
  it("reports no tasks when empty", async () => {
    const { text } = setup();
    expect(await text("TaskList", {})).toBe("No tasks.");
  });

  it("summarizes status counts", async () => {
    const { taskStore, text } = setup();
    taskStore.create("a", "d");
    const t2 = taskStore.create("b", "d");
    taskStore.start(t2.id);
    const out = await text("TaskList", {});
    expect(out).toContain("2 tasks (1 pending, 1 in progress, 0 done)");
    expect(out).toContain("#1");
    expect(out).toContain("[in_progress]");
  });
});

describe("TaskUpdate", () => {
  let h: ReturnType<typeof setup>;
  beforeEach(() => {
    h = setup();
    h.taskStore.create("subject", "desc");
  });

  it("transitions status through the lifecycle and emits task events", async () => {
    expect(await h.text("TaskUpdate", { id: "1", status: "in_progress" })).toContain("→ in_progress");
    expect(h.taskStore.get("1")?.status).toBe("in_progress");
    expect(await h.text("TaskUpdate", { id: "1", status: "completed" })).toContain("→ completed");
    expect(h.taskStore.get("1")?.status).toBe("completed");
    expect(await h.text("TaskUpdate", { id: "1", status: "pending" })).toContain("→ pending");
    expect(h.taskStore.get("1")?.status).toBe("pending");

    expect(h.emittedEvents.some((e) => e.name === "tasks:started" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:completed" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:reopened" && e.payload.taskId === "1")).toBe(true);
  });

  it("updates subject/description and emits tasks:updated", async () => {
    await h.text("TaskUpdate", { id: "1", subject: "renamed" });
    expect(h.taskStore.get("1")?.subject).toBe("renamed");
    expect(h.emittedEvents.some((e) => e.name === "tasks:updated" && e.payload.taskId === "1")).toBe(true);
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("TaskUpdate", { id: "99", status: "completed" })).toBe("Task #99 not found");
  });

  it("documents the taskId→id correction in its guidelines", () => {
    const guidelines = (h.tool("TaskUpdate") as any).promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("`id`, not `taskId`"))).toBe(true);
  });
});

describe("TaskDelete", () => {
  it("deletes an existing task and emits tasks:deleted", async () => {
    const h = setup();
    h.taskStore.create("a", "d");
    expect(await h.text("TaskDelete", { id: "1" })).toBe("Task #1 deleted");
    expect(h.taskStore.get("1")).toBeUndefined();
    expect(h.emittedEvents.some((e) => e.name === "tasks:deleted" && e.payload.taskId === "1")).toBe(true);
  });

  it("reports not found for an unknown id", async () => {
    const h = setup();
    expect(await h.text("TaskDelete", { id: "5" })).toBe("Task #5 not found");
  });
});
