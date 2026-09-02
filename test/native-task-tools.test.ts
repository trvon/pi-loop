import { beforeEach, describe, expect, it, vi } from "vitest";
import { TaskStore } from "../src/task-store.js";
import { type NativeTaskToolsOptions, registerNativeTaskTools } from "../src/tools/native-task-tools.js";
import { createMockPi } from "./helpers/mock-pi.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as any;

function setup(backlog: NativeTaskToolsOptions["evaluateTaskBacklog"] = vi.fn(async () => ({ created: false }))) {
  const { pi, toolMap, emittedEvents } = createMockPi();
  const taskStore = new TaskStore();
  registerNativeTaskTools({
    pi,
    getTaskStore: () => taskStore,
    evaluateTaskBacklog: backlog,
    getTaskOwner: () => ({ sessionId: "session-a", runtimeId: "runtime-a" }),
    updateWidget: vi.fn(),
  });
  const tool = (name: string) => toolMap.get(name)!;
  const result = async (name: string, args: any) => await tool(name).execute!("t", args);
  const text = async (name: string, args: any) => (await result(name, args)).content[0].text as string;
  return { taskStore, tool, text, result, emittedEvents };
}

describe("task tool call renderers", () => {
  it("summarizes the action and task identifier", () => {
    const { tool } = setup();
    const render = (name: string, args: Record<string, unknown>) =>
      (tool(name) as any).renderCall(args, theme).render(120).map((line: string) => line.trimEnd());

    expect(render("TaskCreate", { subject: "Fix a failing check" })).toEqual(["Task create · Fix a failing check"]);
    expect(render("TaskList", {})).toEqual(["Task status"]);
    expect(render("TaskClaim", { id: "7" })).toEqual(["Task claim · #7"]);
    expect(render("TaskHeartbeat", { id: "7" })).toEqual(["Task heartbeat · #7"]);
    expect(render("TaskUpdate", { id: "7" })).toEqual(["Task update · #7"]);
    expect(render("TaskDelete", { id: "7" })).toEqual(["Task delete · #7"]);
  });
});

describe("TaskCreate", () => {
  it("creates a task and emits tasks:created", async () => {
    const { taskStore, text, emittedEvents } = setup();
    const out = await text("TaskCreate", { subject: "Fix bug", description: "the details" });
    expect(out).toBe("Task #1 created: Fix bug");
    expect(taskStore.get("1")?.subject).toBe("Fix bug");
    expect(emittedEvents.some((e) => e.name === "tasks:created" && e.payload.taskId === "1")).toBe(true);
    expect((setup().tool("TaskCreate") as any).renderResult).toBeTypeOf("function");
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
    expect(out).toContain("2 tasks (1 pending, 1 in progress, 0 done, 0 closed)");
    expect(out).toContain("#1");
    expect(out).toContain("[in_progress]");
  });

  it("keeps a 200-task display result compact while preserving the full text result", async () => {
    const { taskStore, result } = setup();
    for (let index = 0; index < 200; index++) taskStore.create(`task ${index + 1}`, "d");

    const output = await result("TaskList", {});
    const details = output.details as { summary: string; expanded: string[] };

    expect(output.content[0].text).toContain("#200");
    expect(details.summary).toBe("200 tasks · 200 pending · 0 active");
    expect(details.expanded).toHaveLength(9);
    expect(details.expanded.at(-1)).toBe("… 392 more");
  });

  it("surfaces descriptions so a fresh agent can reconstruct context", async () => {
    const { taskStore, result } = setup();
    taskStore.create(
      "Investigate regression",
      "Find the root cause; next: implement fix (task #2).",
    );

    const output = await result("TaskList", {});
    const content = output.content[0].text;
    const details = output.details as { summary: string; expanded: string[] };
    const expanded = details.expanded.join("\n");
    expect(content).toContain("Investigate regression");
    expect(content).toContain("Find the root cause; next: implement fix (task #2).");
    expect(expanded).toContain("Investigate regression");
    expect(expanded).toContain("Find the root cause; next: implement fix (task #2).");
  });

  it("guides state-based task flows with goal-state and next-step conventions", () => {
    const guidelines = (setup().tool("TaskCreate") as any).promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("goal state"))).toBe(true);
    expect(guidelines.some((g) => g.includes("next task"))).toBe(true);
    expect(guidelines.some((g) => g.toLowerCase().includes("workflowcreate"))).toBe(true);
  });
});

describe("TaskGet", () => {
  it("returns full untruncated context for a known task", async () => {
    const { taskStore, result } = setup();
    const description =
      "Goal state: tests pass. Increment: apply the fix found in task #1 and run targeted validation. Next: task #3 validate the full suite.";
    taskStore.create("Implement fix", description, { loopId: "9" });

    const output = await result("TaskGet", { id: "1" });
    const text = output.content[0].text;
    expect(text).toContain("Task #1");
    expect(text).toContain("Implement fix");
    expect(text).toContain("[pending]");
    expect(text).toContain(description);

    const details = output.details as { summary: string; expanded: string[] };
    expect(details.expanded.join("\n")).toContain("Metadata: {\"loopId\":\"9\"}");
  });

  it("reports not found for an unknown id", async () => {
    const { text } = setup();
    expect(await text("TaskGet", { id: "99" })).toBe("Task #99 not found");
  });

  it("documents the id parameter convention in its guidelines", () => {
    const guidelines = (setup().tool("TaskGet") as any).promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("`id`, not `taskId`"))).toBe(true);
  });
});

describe("TaskClaim and TaskHeartbeat", () => {
  it("claims work, exposes ownership, and renews the lease", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    const claimOutput = await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
    const claimId = h.taskStore.get("1")?.claim?.claimId;
    expect(claimOutput).toContain("Task #1 claimed");
    expect(claimId).toBeTruthy();
    expect(await h.text("TaskList", {})).toContain(`claim ${claimId}`);
    expect(await h.text("TaskGet", { id: "1" })).toContain(`Claim: ${claimId}`);

    const heartbeat = await h.text("TaskHeartbeat", { id: "1", claimId, leaseSeconds: 120 });
    expect(heartbeat).toContain("lease renewed");
  });

  it("rejects a wrong heartbeat and distinguishes missing from mismatched completion claims", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    await h.text("TaskClaim", { id: "1" });
    const claimId = h.taskStore.get("1")?.claim?.claimId;

    expect(await h.text("TaskHeartbeat", { id: "1", claimId: "wrong" })).toContain("Claim token does not match");
    expect(await h.text("TaskUpdate", { id: "1", status: "completed" })).toContain("claimId is required");
    expect(await h.text("TaskUpdate", { id: "1", status: "completed", claimId: "wrong" })).toContain("Claim token does not match");
    expect(await h.text("TaskUpdate", { id: "1", status: "completed", claimId })).toContain("→ completed");
  });

  it("explains a heartbeat sent before claiming", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");

    expect(await h.text("TaskHeartbeat", { id: "1", claimId: "stale" })).toContain("has no live claim; claim the task");
  });

  it("treats TaskClaim followed by in_progress as idempotent", async () => {
    const h = setup();
    h.taskStore.create("subject", "desc");
    await h.text("TaskClaim", { id: "1" });
    const claimed = h.taskStore.get("1")!;

    const output = await h.text("TaskUpdate", { id: "1", status: "in_progress" });

    expect(output).toContain("already in_progress");
    expect(output).toContain("ownership unchanged");
    expect(h.taskStore.get("1")).toEqual(claimed);
  });

  it("reports an expired completion lease instead of a token mismatch", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      const h = setup();
      h.taskStore.create("subject", "desc");
      await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
      const claimId = h.taskStore.get("1")?.claim?.claimId;
      vi.advanceTimersByTime(60_001);

      expect(await h.text("TaskHeartbeat", { id: "1", claimId })).toContain("claim lease expired; reclaim the task");
      expect(await h.text("TaskUpdate", { id: "1", status: "completed", claimId })).toContain("lease expired; reclaim the task");
    } finally {
      vi.useRealTimers();
    }
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
    expect(await h.text("TaskUpdate", { id: "1", status: "closed" })).toContain("→ closed");
    expect(h.taskStore.get("1")?.status).toBe("closed");
    expect(h.taskStore.get("1")?.completedAt).toBeDefined();
    expect(await h.text("TaskUpdate", { id: "1", status: "pending" })).toContain("→ pending");
    expect(h.taskStore.get("1")?.status).toBe("pending");

    expect(h.emittedEvents.some((e) => e.name === "tasks:started" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:completed" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:closed" && e.payload.taskId === "1")).toBe(true);
    expect(h.emittedEvents.some((e) => e.name === "tasks:reopened" && e.payload.taskId === "1")).toBe(true);
  });

  it("updates subject/description and emits tasks:updated", async () => {
    await h.text("TaskUpdate", { id: "1", subject: "renamed" });
    expect(h.taskStore.get("1")?.subject).toBe("renamed");
    expect(h.emittedEvents.some((e) => e.name === "tasks:updated" && e.payload.taskId === "1")).toBe(true);
  });

  it("rejects a detail edit when another owner claims after the initial read", async () => {
    const original = h.taskStore.updateDetails.bind(h.taskStore);
    vi.spyOn(h.taskStore, "updateDetails").mockImplementation((id, fields, options) => {
      h.taskStore.claim(id, {
        claimId: "racing-claim",
        ownerSessionId: "session-b",
        ownerRuntimeId: "runtime-b",
        leaseMs: 60_000,
      });
      return original(id, fields, options);
    });

    expect(await h.text("TaskUpdate", { id: "1", description: "racing rewrite" })).toContain("claimId is required");
    expect(h.taskStore.get("1")?.description).toBe("desc");
    expect(h.taskStore.get("1")?.claim?.claimId).toBe("racing-claim");
  });

  it("requires a claim bearer before changing claimed task instructions", async () => {
    await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
    const before = h.taskStore.get("1");

    expect(await h.text("TaskUpdate", { id: "1", description: "unowned rewrite" })).toContain("claimId is required");
    expect(h.taskStore.get("1")).toEqual(before);
  });

  it("rejects the wrong claim bearer without changing task instructions", async () => {
    await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
    const before = h.taskStore.get("1");

    expect(await h.text("TaskUpdate", { id: "1", description: "wrong rewrite", claimId: "wrong" }))
      .toContain("Claim token does not match");
    expect(h.taskStore.get("1")).toEqual(before);
  });

  it("allows the live claim bearer to change task instructions", async () => {
    await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
    const claimId = h.taskStore.get("1")?.claim?.claimId;

    expect(await h.text("TaskUpdate", { id: "1", description: "owner rewrite", claimId })).toContain("updated");
    expect(h.taskStore.get("1")?.description).toBe("owner rewrite");
  });

  it("requires reclaim before an expired bearer changes task instructions", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      h = setup();
      h.taskStore.create("subject", "desc");
      await h.text("TaskClaim", { id: "1", leaseSeconds: 60 });
      const claimId = h.taskStore.get("1")?.claim?.claimId;
      vi.advanceTimersByTime(60_001);
      const before = h.taskStore.get("1");

      expect(await h.text("TaskUpdate", { id: "1", description: "expired rewrite", claimId }))
        .toContain("lease expired; reclaim the task");
      expect(h.taskStore.get("1")).toEqual(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an update with no requested changes", async () => {
    const before = h.taskStore.get("1");
    expect(await h.text("TaskUpdate", { id: "1" })).toContain("No update fields were provided");
    expect(h.taskStore.get("1")).toEqual(before);
  });

  it.each([
    ["pending", "pending", true],
    ["pending", "in_progress", true],
    ["pending", "completed", true],
    ["pending", "closed", true],
    ["in_progress", "pending", false],
    ["in_progress", "in_progress", true],
    ["in_progress", "completed", true],
    ["in_progress", "closed", true],
    ["completed", "pending", true],
    ["completed", "in_progress", false],
    ["completed", "completed", false],
    ["completed", "closed", false],
    ["closed", "pending", true],
    ["closed", "in_progress", false],
    ["closed", "completed", false],
    ["closed", "closed", false],
  ] as const)("models %s → %s as applied=%s", async (from, to, applied) => {
    const matrix = setup();
    matrix.taskStore.create("subject", "desc");
    if (from === "in_progress") matrix.taskStore.start("1");
    if (from === "completed") matrix.taskStore.complete("1");
    if (from === "closed") matrix.taskStore.close("1");

    const output = await matrix.text("TaskUpdate", { id: "1", status: to });

    if (applied) {
      expect(output).not.toContain("rejected");
      expect(matrix.taskStore.get("1")?.status).toBe(to);
    } else {
      expect(output).toContain(`Transition from ${from} to ${to} is not allowed`);
      expect(matrix.taskStore.get("1")?.status).toBe(from);
    }
  });

  it("reports not found for an unknown id", async () => {
    expect(await h.text("TaskUpdate", { id: "99", status: "completed" })).toBe("Task #99 not found");
  });

  it("documents the taskId→id correction and unfinished handoff persistence", () => {
    const guidelines = (h.tool("TaskUpdate") as any).promptGuidelines as string[];
    expect(guidelines.some((g) => g.includes("`id`, not `taskId`"))).toBe(true);
    expect(guidelines.some((g) => g.includes("persist material progress, discovered dependencies, and the next action"))).toBe(true);
    expect(guidelines.some((g) => g.includes("closed means intentionally abandoned"))).toBe(true);
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

  it("rejects deletion of live claimed work without its token", async () => {
    const h = setup();
    h.taskStore.create("claimed", "d");
    await h.text("TaskClaim", { id: "1" });
    const claimId = h.taskStore.get("1")?.claim?.claimId;

    expect(await h.text("TaskDelete", { id: "1" })).toContain("claimId is required");
    expect(h.taskStore.get("1")).toBeDefined();
    expect(await h.text("TaskDelete", { id: "1", claimId })).toBe("Task #1 deleted");
  });

  it("reports not found for an unknown id", async () => {
    const h = setup();
    expect(await h.text("TaskDelete", { id: "5" })).toBe("Task #5 not found");
  });
});
