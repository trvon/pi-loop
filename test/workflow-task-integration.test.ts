import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import extension from "../src/index.js";
import { resolveLoopStorePath, resolveTaskStorePath } from "../src/runtime/scope.js";
import { LoopStore } from "../src/store.js";
import { TaskStore } from "../src/task-store.js";
import { createMockPi } from "./helpers/mock-pi.js";

const RETRY_WORKFLOW = JSON.stringify({
  version: 1,
  initialState: "work",
  states: {
    work: {
      prompt: "Run one bounded attempt, then choose retry or done.",
      task: {
        subject: "Workflow attempt",
        description: "Claim this linked task, then use WorkflowTransition. Do not close it directly.",
      },
      on: { retry: "work", done: "done" },
      maxAttempts: 3,
    },
    done: { prompt: "Report completion.", terminal: "completed" },
  },
});

describe("linked workflow task integration", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(() => {
    vi.useFakeTimers();
    originalCwd = process.cwd();
    cwd = mkdtempSync(join(tmpdir(), "pi-loop-workflow-integration-"));
    process.chdir(cwd);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    vi.useRealTimers();
  });

  async function setup() {
    const harness = createMockPi();
    extension(harness.pi as any);
    const sessionId = "workflow-integration";
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => sessionId },
    };
    for (const handler of harness.extensionHandlers.get("turn_start") ?? []) await handler(null, ctx);
    await vi.advanceTimersByTimeAsync(6100);
    const taskPath = resolveTaskStorePath({ loopScope: "session", cwd }, sessionId)!;
    const loopPath = resolveLoopStorePath({ loopScope: "session", cwd }, sessionId)!;
    return { ...harness, ctx, taskPath, loopPath };
  }

  it("defers a task-bearing workflow until native task-provider detection settles", async () => {
    const harness = createMockPi();
    extension(harness.pi as any);
    const sessionId = "workflow-detection";
    const ctx = {
      ui: { setStatus: vi.fn(), setWidget: vi.fn() },
      hasPendingMessages: () => false,
      sessionManager: { getSessionId: () => sessionId },
    };
    for (const handler of harness.extensionHandlers.get("turn_start") ?? []) await handler(null, ctx);

    const deferred = await harness.toolMap.get("WorkflowCreate")!.execute!("early-create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
    });
    expect(deferred.content[0].text).toContain("Task system is still initializing");
    expect(harness.toolMap.get("LoopList")!.execute).toBeDefined();
    expect((await harness.toolMap.get("LoopList")!.execute!("early-list", {})).content[0].text).toBe("No loops configured. Use LoopCreate to set up a schedule.");

    await vi.advanceTimersByTimeAsync(6_100);
    const created = await harness.toolMap.get("WorkflowCreate")!.execute!("ready-create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
    });
    expect(created.content[0].text).toContain("Active task: #1");
    const taskPath = resolveTaskStorePath({ loopScope: "session", cwd }, sessionId)!;
    expect(new TaskStore(taskPath).get("1")?.workflow).toMatchObject({
      loopId: "1",
      stateId: "work",
      transitionSeq: 0,
    });
  });

  it("self-loops through fresh linked attempts and terminates without orphan tasks", async () => {
    const h = await setup();
    const created = await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
      maxFires: 10,
    });
    expect(created.content[0].text).toContain("Attempt: 1/3");

    let tasks = new TaskStore(h.taskPath).list();
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: "pending",
      workflow: { loopId: "1", stateId: "work", transitionSeq: 0 },
    });

    await h.toolMap.get("TaskClaim")!.execute!("claim-1", { id: tasks[0].id, leaseSeconds: 600 });
    let taskStore = new TaskStore(h.taskPath);
    const firstClaimId = taskStore.get(tasks[0].id)?.claim?.claimId;
    expect(firstClaimId).toBeDefined();

    const directClose = await h.toolMap.get("TaskUpdate")!.execute!("close-1", {
      id: tasks[0].id,
      status: "closed",
      claimId: firstClaimId,
    });
    expect(directClose.content[0].text).toContain("managed by workflow #1");
    expect(new TaskStore(h.taskPath).get(tasks[0].id)?.status).toBe("in_progress");

    const retried = await h.toolMap.get("WorkflowTransition")!.execute!("retry", {
      id: "1",
      outcome: "retry",
      evidence: "Attempt one exposed another case.",
      claimId: firstClaimId,
    });
    expect(retried.content[0].text).toContain("work → work");
    expect(retried.content[0].text).toContain("Attempt: 2/3");

    const loop = new LoopStore(h.loopPath).get("1");
    expect(loop?.workflow).toMatchObject({
      currentState: "work",
      transitionSeq: 1,
      attemptsByState: { work: 2 },
      activeTaskId: "2",
    });
    tasks = new TaskStore(h.taskPath).list();
    expect(tasks).toHaveLength(2);
    expect(tasks[0].status).toBe("completed");
    expect(tasks[1]).toMatchObject({
      status: "pending",
      workflow: { loopId: "1", stateId: "work", transitionSeq: 1 },
    });

    await h.toolMap.get("TaskClaim")!.execute!("claim-2", { id: tasks[1].id, leaseSeconds: 600 });
    taskStore = new TaskStore(h.taskPath);
    const secondClaimId = taskStore.get(tasks[1].id)?.claim?.claimId;
    const completed = await h.toolMap.get("WorkflowTransition")!.execute!("done", {
      id: "1",
      outcome: "done",
      evidence: "Attempt two satisfies the done criteria.",
      claimId: secondClaimId,
    });

    expect(completed.content[0].text).toContain("completed and deleted");
    expect(new LoopStore(h.loopPath).list()).toHaveLength(0);
    expect(new TaskStore(h.taskPath).list().map((task) => task.status)).toEqual(["completed", "completed"]);
  });

  it("recovers an explicitly closed legacy state task through WorkflowTransition", async () => {
    const h = await setup();
    await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Recover legacy workflow state",
      definition: RETRY_WORKFLOW,
    });
    const taskStore = new TaskStore(h.taskPath);
    expect(taskStore.close("1")?.status).toBe("closed");

    const result = await h.toolMap.get("WorkflowTransition")!.execute!("recover", {
      id: "1",
      outcome: "retry",
      evidence: "The prior attempt was closed before workflow ownership was enforced.",
    });

    expect(result.content[0].text).toContain("work → work");
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      transitionSeq: 1,
      attemptsByState: { work: 2 },
      activeTaskId: "2",
    });
    expect(new TaskStore(h.taskPath).list()).toMatchObject([
      { id: "1", status: "closed" },
      { id: "2", status: "pending", workflow: { transitionSeq: 1 } },
    ]);
  });
});
