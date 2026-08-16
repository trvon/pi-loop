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
      task: { subject: "Workflow attempt", description: "Complete this attempt, then use WorkflowTransition." },
      on: { retry: "work", done: "done" },
      maxAttempts: 3,
    },
    done: { prompt: "Report completion.", terminal: "completed" },
  },
});

describe("embedded workflow execution integration", () => {
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
    const taskPath = resolveTaskStorePath({ loopScope: "session", cwd }, sessionId)!;
    const loopPath = resolveLoopStorePath({ loopScope: "session", cwd }, sessionId)!;
    return { ...harness, taskPath, loopPath };
  }

  it("creates task-bearing workflow work before task-provider detection and leaves TaskStore empty", async () => {
    const h = await setup();
    const created = await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
    });

    expect(created.content[0].text).toContain("Active workflow work: Workflow attempt (work:0)");
    expect(new TaskStore(h.taskPath).list()).toEqual([]);
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      currentState: "work",
      activeExecution: { id: "work:0", status: "active", lease: { ownerSessionId: "workflow-integration" } },
    });
  });

  it("self-loops through durable embedded attempts and completes without task records", async () => {
    const h = await setup();
    await h.toolMap.get("WorkflowCreate")!.execute!("create", {
      goal: "Finish bounded workflow work",
      definition: RETRY_WORKFLOW,
      maxFires: 10,
    });

    const retried = await h.toolMap.get("WorkflowTransition")!.execute!("retry", {
      id: "1",
      outcome: "retry",
      evidence: "Attempt one exposed another case.",
    });
    expect(retried.content[0].text).toContain("work → work");
    expect(new LoopStore(h.loopPath).get("1")?.workflow).toMatchObject({
      transitionSeq: 1,
      attemptsByState: { work: 2 },
      activeExecution: { id: "work:1", status: "active" },
      executionHistory: [{ id: "work:0", status: "completed" }],
    });
    expect(new TaskStore(h.taskPath).list()).toEqual([]);

    const claimed = await h.toolMap.get("WorkflowClaim")!.execute!("claim", { id: "1" });
    expect(claimed.content[0].text).toContain("lease active until");
    expect(new LoopStore(h.loopPath).get("1")?.workflow?.activeExecution?.lease).toMatchObject({
      ownerSessionId: "workflow-integration",
    });

    const completed = await h.toolMap.get("WorkflowTransition")!.execute!("done", {
      id: "1",
      outcome: "done",
      evidence: "Attempt two satisfies the done criteria.",
    });
    expect(completed.content[0].text).toContain("completed and deleted");
    expect(new LoopStore(h.loopPath).list()).toEqual([]);
    expect(new TaskStore(h.taskPath).list()).toEqual([]);
  });
});
