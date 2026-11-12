import type { TaskEntry, TaskStatus } from "../../src/task-types.js";
import type { LoopEntry, OrchestrationState, WorkflowRunState } from "../../src/types.js";

export const PANEL_NOW = Date.UTC(2026, 0, 1, 12);

export function panelTask(id: string, status: TaskStatus, subject = `task ${id}`, claim?: { claimedAt: number; leaseExpiresAt: number }): TaskEntry {
  return {
    id,
    subject,
    description: "",
    status,
    createdAt: PANEL_NOW - 600_000,
    updatedAt: PANEL_NOW - 300_000,
    claim: claim
      ? { claimId: "c", ownerSessionId: "s", ownerRuntimeId: "r", heartbeatAt: claim.claimedAt, attempt: 1, ...claim }
      : undefined,
  };
}

export interface PanelWorkflowOptions {
  id?: string;
  prompt?: string;
  states?: string[];
  current?: string;
  visited?: string[];
  status?: LoopEntry["status"];
  lease?: "live" | "expired" | "none";
  maxAttempts?: number;
  waitingMonitor?: string;
}

/** A workflow entry built directly so presentation tests need no store. */
export function panelWorkflow(options: PanelWorkflowOptions = {}): LoopEntry {
  const names = options.states ?? ["plan", "implement", "review", "done"];
  const current = options.current ?? names[1] ?? names[0] ?? "plan";
  const states: WorkflowRunState["definition"]["states"] = {};
  names.forEach((name, index) => {
    const next = names[index + 1];
    states[name] = next
      ? { prompt: `Do ${name}.`, task: { subject: name, description: name }, on: { pass: next, retry: name }, maxAttempts: options.maxAttempts ?? 3 }
      : { prompt: "Done.", terminal: "completed" };
  });
  const attemptsByState: Record<string, number> = { [current]: 1 };
  for (const name of options.visited ?? names.slice(0, names.indexOf(current))) attemptsByState[name] = 1;
  const lease = options.lease ?? "live";
  const workflow: WorkflowRunState = {
    definition: { version: 1, initialState: names[0] ?? "plan", states },
    definitionRevision: 1,
    revisionHistory: [],
    currentState: current,
    transitionSeq: 1,
    stateEnteredAt: PANEL_NOW - 300_000,
    attemptsByState,
    stateFireCounts: {},
    activeExecution: {
      id: "exec-1",
      stateId: current,
      transitionSeq: 1,
      subject: current,
      description: current,
      status: "active",
      createdAt: PANEL_NOW - 300_000,
      updatedAt: PANEL_NOW - 300_000,
      lease: lease === "none" ? undefined : {
        ownerSessionId: "s",
        ownerRuntimeId: "r",
        acquiredAt: PANEL_NOW - 240_000,
        heartbeatAt: PANEL_NOW - 240_000,
        expiresAt: lease === "live" ? PANEL_NOW + 600_000 : PANEL_NOW - 60_000,
        attempt: 1,
      },
    },
    waitingMonitor: options.waitingMonitor
      ? { monitorId: options.waitingMonitor, stateId: current, transitionSeq: 1, attachedAt: PANEL_NOW - 120_000 }
      : undefined,
  };
  return {
    id: options.id ?? "3",
    prompt: options.prompt ?? "Ship migration",
    trigger: { type: "dynamic" },
    status: options.status ?? "active",
    recurring: true,
    createdAt: PANEL_NOW - 3_600_000,
    updatedAt: PANEL_NOW - 300_000,
    expiresAt: PANEL_NOW + 86_400_000,
    pause: options.status === "paused" ? { kind: "administrative", at: PANEL_NOW - 120_000 } as LoopEntry["pause"] : undefined,
    workflow,
  };
}

export function panelOrchestration(id: string, statuses: OrchestrationState["work"][number]["status"][], status: OrchestrationState["status"] = "active"): LoopEntry {
  return {
    id,
    prompt: "Fan out",
    trigger: { type: "dynamic" },
    status: "active",
    recurring: true,
    createdAt: PANEL_NOW - 60_000,
    updatedAt: PANEL_NOW,
    expiresAt: PANEL_NOW + 86_400_000,
    orchestration: {
      version: 1,
      revision: 1,
      status,
      goal: "Fan out",
      concurrency: 2,
      maxAttempts: 2,
      owner: { sessionId: "s", runtimeId: "r", generation: 0 },
      work: statuses.map((workStatus, index) => ({ id: String(index + 1), prompt: "p", status: workStatus, attemptCount: 0, dispatches: [] })),
      nextWakeSequence: 1,
      createdAt: PANEL_NOW - 60_000,
      updatedAt: PANEL_NOW,
    } as unknown as OrchestrationState,
  };
}
