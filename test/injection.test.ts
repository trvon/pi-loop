import { describe, expect, it } from "vitest";
import { createCtx, createMockPi, flushAsync } from "./helpers/mock-pi.js";

describe("loop:fire custom message delivery", () => {
  it("wakes the agent to inspect a newly started monitor once the current turn is idle", async () => {
    const { pi, toolMap, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    await toolMap.get("MonitorCreate")!.execute!("monitor-1", {
      command: "sleep 30",
      description: "Run tests",
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.content).toContain("Monitor #1 started: Run tests");
    expect(sentMessages[0].message.content).toContain("Use MonitorList");

    await toolMap.get("MonitorStop")!.execute!("monitor-2", { monitorId: "1" });
  });

  it("injects a custom pi-loop message immediately when idle", async () => {
    const { pi, sentMessages, sentUserMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "42",
      prompt: "Pick up the next task and work on it",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    expect(sentUserMessages).toHaveLength(0);
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].options).toEqual({ deliverAs: "steer", triggerTurn: true });
    expect(sentMessages[0].message.customType).toBe("pi-loop");
    expect(sentMessages[0].message.display).toBe(false);
    expect(sentMessages[0].message.content).toContain("[pi-loop]");
    expect(sentMessages[0].message.content).toContain("Loop #42 fired");
    expect(sentMessages[0].message.content).toContain("Pick up the next task and work on it");
    expect(sentMessages[0].message.content).toContain("remains active after this iteration");
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete or pause it");
    expect(sentMessages[0].message.content).toContain("found no changes");
  });

  it("renders dynamic loop progress and LoopUpdate guidance", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "5",
      prompt: "finish dynamic loops",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      dynamic: {
        goal: "finish dynamic loops",
        state: "router done",
        metrics: "2/5 tasks complete",
        doneCriteria: "all tasks done",
        iteration: 2,
      },
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    const content = sentMessages[0].message.content;
    expect(content).toContain("Loop #5 fired (dynamic)");
    expect(content).toContain("Goal: finish dynamic loops");
    expect(content).toContain("State: router done");
    expect(content).toContain("Metrics: 2/5 tasks complete");
    expect(content).toContain("LoopUpdate");
    expect(content).toContain("idle-driven rewake");
    expect(content).toContain("persistent controller for the overall goal");
    expect(content).toContain("Do not call LoopDelete after this iteration");
    expect(content).toContain("call LoopUpdate exactly once");
    expect(content).toContain("only when the overall goal and done criteria are satisfied");
  });

  it("renders workflow state, declared outcomes, and WorkflowTransition guidance", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "8",
      prompt: "Fix the regression",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      workflow: {
        definition: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Find the cause.", task: { subject: "Investigate regression", description: "Find and reproduce the root cause." }, on: { found: "fix", blocked: "blocked" }, maxAttempts: 3 },
            fix: { prompt: "Implement the fix." },
            blocked: { prompt: "Report the blocker.", terminal: "paused" },
          },
        },
        definitionRevision: 2,
        revisionHistory: [{
          revision: 1,
          definition: {
            version: 1,
            initialState: "investigate",
            states: {
              investigate: { prompt: "Find the cause.", on: { found: "fix" } },
              fix: { prompt: "Implement the fix." },
            },
          },
          reason: "Added dependent validation after investigation.",
          supersededAt: Date.now(),
          supersededBy: { sessionId: "session-a", runtimeId: "runtime-a" },
          changes: [{ op: "add_transition", from: "investigate", outcome: "blocked", to: "blocked" }],
        }],
        currentState: "investigate",
        transitionSeq: 0,
        stateEnteredAt: Date.now(),
        attemptsByState: { investigate: 1 },
        activeExecution: {
          id: "investigate:0",
          stateId: "investigate",
          transitionSeq: 0,
          subject: "Investigate regression",
          description: "Find and reproduce the root cause.",
          status: "active",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          lease: {
            ownerSessionId: "session-a",
            ownerRuntimeId: "runtime-a",
            acquiredAt: Date.now(),
            heartbeatAt: Date.now(),
            expiresAt: Date.now() + 1_800_000,
            attempt: 1,
          },
        },
      },
    });
    await flushAsync();

    const content = sentMessages[0].message.content;
    expect(content).toContain("fired (workflow)");
    expect(content).toContain("Definition revision: 2");
    expect(content).toContain("State: investigate");
    expect(content).toContain("Transition sequence: 0");
    expect(content).toContain("Latest revision reason: Added dependent validation after investigation.");
    expect(content).toContain("Find the cause.");
    expect(content).toContain("Attempt: 1/3");
    expect(content).toContain("Active workflow work: Investigate regression (investigate:0)");
    expect(content).toContain("Lease owned by session-a/runtime-a");
    expect(content).toContain("do not call TaskClaim or TaskUpdate");
    expect(content).toContain("Allowed outcomes: found, blocked");
    expect(content).toContain("WorkflowTransition");
    expect(content).not.toContain("call LoopUpdate exactly once");
  });

  it("does not advertise a self-loop outcome after its target attempt limit is exhausted", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);
    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "8",
      prompt: "Finish bounded work",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      workflow: {
        definition: {
          version: 1,
          initialState: "work",
          states: {
            work: { prompt: "Choose retry or done.", on: { retry: "work", done: "done" }, maxAttempts: 3 },
            done: { prompt: "Done.", terminal: "completed" },
          },
        },
        currentState: "work",
        transitionSeq: 2,
        stateEnteredAt: Date.now(),
        attemptsByState: { work: 3 },
      },
    });
    await flushAsync();

    const content = sentMessages[0].message.content;
    expect(content).toContain("Attempt: 3/3");
    expect(content).toContain("Allowed outcomes: done");
    expect(content).toContain("Unavailable outcomes: retry");
    expect(content).not.toContain("Allowed outcomes: retry");
  });

  it("replays the last transition and its evidence in the next workflow state wake", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "9",
      prompt: "Fix the regression",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      workflow: {
        definition: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Find the cause.", on: { found: "fix" } },
            fix: { prompt: "Implement the fix.", on: { passing: "done" } },
            done: { prompt: "Report.", terminal: "completed" },
          },
        },
        currentState: "fix",
        transitionSeq: 1,
        stateEnteredAt: Date.now(),
        attemptsByState: { investigate: 1, fix: 1 },
        lastTransition: {
          from: "investigate",
          to: "fix",
          outcome: "found",
          evidence: "A null config reaches the parser.",
          at: Date.now(),
          sequence: 1,
        },
      },
    });
    await flushAsync();

    const content = sentMessages[0].message.content;
    expect(content).toContain("State: fix");
    expect(content).toContain("Last transition: investigate → fix via found");
    expect(content).toContain("Evidence: A null config reaches the parser.");
  });

  it("collapses multi-line transition evidence into a single wake line", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "10",
      prompt: "Fix the regression",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      workflow: {
        definition: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Find the cause.", on: { found: "fix" } },
            fix: { prompt: "Implement the fix.", on: { passing: "done" } },
            done: { prompt: "Report.", terminal: "completed" },
          },
        },
        currentState: "fix",
        transitionSeq: 1,
        stateEnteredAt: Date.now(),
        attemptsByState: { investigate: 1, fix: 1 },
        lastTransition: {
          from: "investigate",
          to: "fix",
          outcome: "found",
          evidence: "Line one.\nLine two.",
          at: Date.now(),
          sequence: 1,
        },
      },
    });
    await flushAsync();

    const content = sentMessages[0].message.content;
    expect(content).toContain("Evidence: Line one. Line two.");
    expect(content).not.toContain("Evidence: Line one.\n");
  });

  it("does not instruct a transition when the wake lands on a terminal state", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Fix the regression",
      trigger: { type: "dynamic" },
      timestamp: Date.now(),
      recurring: true,
      workflow: {
        definition: {
          version: 1,
          initialState: "investigate",
          states: {
            investigate: { prompt: "Find the cause.", on: { found: "blocked" } },
            blocked: { prompt: "Report the blocker.", terminal: "paused" },
          },
        },
        currentState: "blocked",
        transitionSeq: 1,
        stateEnteredAt: Date.now(),
        attemptsByState: { investigate: 1, blocked: 1 },
        lastTransition: {
          from: "investigate",
          to: "blocked",
          outcome: "found",
          evidence: "Missing credentials.",
          at: Date.now(),
          sequence: 1,
        },
      },
    });
    await flushAsync();

    const content = sentMessages[0].message.content;
    expect(content).toContain("State: blocked");
    expect(content).toContain("Terminal: paused");
    expect(content).not.toContain("call WorkflowTransition exactly once");
  });

  it("keeps backlog cleanup under pi-loop control", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "6",
      prompt: "Process the pending task backlog",
      trigger: { type: "event", source: "tasks:created" },
      timestamp: Date.now(),
      recurring: true,
      taskBacklog: true,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("adopts unfinished tasks and re-wakes after this turn");
    expect(sentMessages[0].message.content).toContain("ACTION REQUIRED NOW");
    expect(sentMessages[0].message.content).toContain("First tool call: TaskList");
    expect(sentMessages[0].message.content.indexOf("ACTION REQUIRED NOW"))
      .toBeLessThan(sentMessages[0].message.content.indexOf("Backlog goal:"));
    expect(sentMessages[0].message.content).toMatch(/claim or resume.*same turn/i);
    expect(sentMessages[0].message.content).toMatch(/do not end.*reporting state/i);
    expect(sentMessages[0].message.content).toContain("Tool calls, not a plan");
    expect(sentMessages[0].message.content).toMatch(/describing intended work does not count/i);
    expect(sentMessages[0].message.content).toMatch(/TaskGet.*execution authority/i);
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete");
    expect(sentMessages[0].message.content).toContain("report that and end this iteration");
    expect(sentMessages[0].message.details.taskBacklog).toBe(true);
  });

  it("includes the read-only constraint without advertising LoopCreate", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "7",
      prompt: "Check the build status",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      readOnly: true,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("READ-ONLY MODE");
    expect(sentMessages[0].message.content).toContain("MonitorList");
    expect(sentMessages[0].message.content).not.toContain("LoopCreate");
  });

  it("buffers recurring fires while the agent is active and flushes once idle", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "9",
      prompt: "Deliver after current work finishes",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Deliver after current work finishes");
  });

  it("dedupes buffered recurring fires by loop id and keeps the latest prompt", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "13",
      prompt: "Old prompt",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    pi.events.emit("loop:fire", {
      loopId: "13",
      prompt: "Latest prompt",
      trigger: { type: "cron", schedule: "*/1 * * * *" },
      timestamp: Date.now() + 1,
      recurring: true,
    });
    await flushAsync();

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Latest prompt");
    expect(sentMessages[0].message.content).not.toContain("Old prompt");
  });

  it("flushes one-shot monitor wakes after the current agent run", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Monitor completed — must deliver",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now(),
      recurring: false,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("Monitor completed");
    expect(sentMessages[0].message.content).toContain("one-shot wake and cleanup is automatic");
    expect(sentMessages[0].message.content).toContain("Do not call LoopDelete");
  });

  it("keeps one-shot buffered wakes independent even for the same loop id", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "First one-shot",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now(),
      recurring: false,
    });
    pi.events.emit("loop:fire", {
      loopId: "11",
      prompt: "Second one-shot",
      trigger: { type: "event", source: "monitor:done" },
      timestamp: Date.now() + 1,
      recurring: false,
    });
    await flushAsync();

    expect(sentMessages).toHaveLength(0);

    await emitExtension("agent_end", null, ctx);
    await flushAsync();
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0].message.content).toContain("First one-shot");

    await emitExtension("agent_end", null, ctx);
    await flushAsync();
    expect(sentMessages).toHaveLength(2);
    expect(sentMessages[1].message.content).toContain("Second one-shot");
  });

  it("clears buffered wakes on session switch", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "21",
      prompt: "Should be cleared on switch",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    await emitExtension("session_switch", { reason: "switch" }, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });

  it("clears buffered wakes on session shutdown", async () => {
    const { pi, sentMessages, emitExtension } = createMockPi();
    const extension = await import("../src/index.js");
    extension.default(pi);

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "22",
      prompt: "Should be cleared on shutdown",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      recurring: true,
    });
    await flushAsync();

    await emitExtension("session_shutdown", null, ctx);
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
  });

  it("drops a buffered autoTask wake when pending tasks reach zero before flush", async () => {
    let pendingTaskCount = 1;
    const { pi, sentMessages, emittedEvents, emitExtension } = createMockPi({
      respondToTaskPing: true,
      pendingTaskCount: () => pendingTaskCount,
    });
    const extension = await import("../src/index.js");
    extension.default(pi);
    await flushAsync();

    const ctx = createCtx(false);
    await emitExtension("turn_start", null, ctx);
    await emitExtension("agent_start", null, ctx);

    pi.events.emit("loop:fire", {
      loopId: "12",
      prompt: "Should be dropped before delivery",
      trigger: { type: "cron", schedule: "*/5 * * * *" },
      timestamp: Date.now(),
      autoTask: true,
      recurring: false,
    });
    await flushAsync();
    expect(sentMessages).toHaveLength(0);

    pendingTaskCount = 0;
    await emitExtension("agent_end", null, ctx);
    await flushAsync();

    expect(sentMessages).toHaveLength(0);
    expect(emittedEvents.some(event => event.name === "tasks:rpc:clean")).toBe(true);
  });
});
