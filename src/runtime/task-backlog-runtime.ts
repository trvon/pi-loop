import {
  createCoordinator,
  type ReducerEvent,
  type ReducerHandler,
} from "../coordinator.js";
import {
  reduceTaskBacklogEvent,
  type TaskBacklogEvent,
} from "../task-backlog-coordinator.js";
import type { TaskStore } from "../task-store.js";
import type { LoopDeletionTombstoneInput, LoopEntry, Trigger } from "../types.js";
import {
  buildLoopAutodeletedPayload,
  buildTaskBacklogEmptyPayload,
  type LoopAutodeletedPayload,
  type TaskBacklogEmptyPayload,
} from "./loop-events.js";

export const TASK_BACKLOG_ACTION_CONTRACT = "ACTION REQUIRED NOW — this is an execution turn, not a status-reporting turn. Tool calls, not a plan. First tool call: TaskList; do not write progress prose before it. After inspecting current state, claim or resume one eligible task and use the available work tools to perform concrete task work (implementation when required) and validation in this same turn before any summary. Describing intended work does not count. Validation must produce an observable tool result; reasoning-only validation does not count. Run the validation command or tool TaskGet requires and inspect its result; reads and edits alone do not prove validation. The TaskGet description is the execution authority; use normal implementation judgment and do not invent ambiguity as a blocker. Do not end after reporting state, selecting a task, or making a future-tense promise such as ‘starting now’, ‘will implement’, or ‘on the next wake’. A later wake is recovery, not permission to defer work. The only no-implementation exits are an empty backlog or a genuine live-owner/dependency blocker verified with TaskGet evidence.";

export const AUTO_TASK_WORKER_PROMPT = `${TASK_BACKLOG_ACTION_CONTRACT} Inspect every in_progress task before choosing a pending task; read each pending task's description and use TaskGet whenever an excerpt is truncated. Follow each prerequisite chain to the earliest unfinished task. Use TaskClaim for that task whether it is pending or in_progress; an expired claim can be taken over, but a live foreign claim must not be duplicated. Resume claimed in_progress work before claiming unrelated pending work. Keep the returned claimId, call TaskHeartbeat before its lease expires during long work, and pass claimId to TaskUpdate when completing or closing the task. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Never report no eligible task while any in_progress task exists: claim and resume it, verify evidence and complete it, or report its live owner/blocker and required recovery. Implement the claimed task, run validation, and complete it. If no unfinished tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.`;

// Worker loops persist their prompt in the loop store. Changing the prompt text
// must append the previous version here, or persisted workers orphan after an
// extension reload and never auto-delete.
export const AUTO_TASK_WORKER_LEGACY_PROMPTS: readonly string[] = [
  "Run TaskList and inspect every in_progress task before choosing a pending task; read each pending task's description and use TaskGet whenever an excerpt is truncated. Follow each prerequisite chain to the earliest unfinished task. Use TaskClaim for that task whether it is pending or in_progress; an expired claim can be taken over, but a live foreign claim must not be duplicated. Resume claimed in_progress work before claiming unrelated pending work. Keep the returned claimId, call TaskHeartbeat before its lease expires during long work, and pass claimId to TaskUpdate when completing or closing the task. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Never report no eligible task while any in_progress task exists: claim and resume it, verify evidence and complete it, or report its live owner/blocker and required recovery. Implement the claimed task, run validation, and complete it. If no unfinished tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
  "Run TaskList and inspect every in_progress task before choosing a pending task; read each pending task's description and use TaskGet whenever an excerpt is truncated. Resume an eligible in_progress task before claiming new work. If a dependent task is blocked, follow its prerequisite chain to the earliest unfinished task and resume it when it is in_progress. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Never report no eligible task while any in_progress task exists: resume it, verify evidence and complete it, or report why it is actively owned or blocked and what recovery is required. Mark newly claimed work in_progress, implement it, run validation, and complete it. If no unfinished tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
  "Run TaskList and read each pending task's description; use TaskGet whenever an excerpt is truncated. Prefer a pending task with no unresolved prerequisite. If task A names B as its next task, or B says it depends on A, complete A before B. Never choose a dependent task while its prerequisite is pending or in_progress. Mark the chosen task in_progress, implement it, run validation, and complete it. If no pending tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
  "Run TaskList, pick next pending task, mark it in_progress, implement it, run validation, and complete it. If no pending tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
  "Run TaskList, read each pending task's description, and pick the next pending task — prefer one whose description names a next task or successor, and any task whose description depends on an earlier one. Mark it in_progress, implement it, run validation, and complete it. If no pending tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
  "Run TaskList, read each pending task's description (use TaskGet when the excerpt truncates it), and pick the next pending task — prefer one whose description names a next task or successor, and any task whose description depends on an earlier one. Mark it in_progress, implement it, run validation, and complete it. If no pending tasks remain, report that and end this iteration; pi-loop manages the worker lifecycle automatically.",
];

export function isAutoTaskWorkerPrompt(prompt: string): boolean {
  return prompt === AUTO_TASK_WORKER_PROMPT || AUTO_TASK_WORKER_LEGACY_PROMPTS.includes(prompt);
}

export interface TaskBacklogRuntimeOptions {
  getLoops: () => LoopEntry[];
  deleteLoop: (id: string) => void;
  updateLoopWorker: (id: string, prompt: string) => LoopEntry | undefined;
  recordDeletionTombstone?: (id: string, tombstone: LoopDeletionTombstoneInput) => void;
  removeTrigger: (id: string) => void;
  updateWidget: () => void;
  hasPendingTasks: () => Promise<number>;
  adoptLoop: (entry: LoopEntry) => Promise<void> | void;
  triggerHasEventSource: (trigger: Trigger | string, source: string) => boolean;
  emitLoopAutodeleted?: (payload: LoopAutodeletedPayload) => void;
  emitTaskBacklogEmpty?: (payload: TaskBacklogEmptyPayload) => void;
  captureIsCurrent?: () => () => boolean;
  debug?: (...args: unknown[]) => void;
}

export interface TaskBacklogRuntime {
  cleanupTaskBacklogLoops(isCurrent?: () => boolean): Promise<number>;
  adoptTaskBacklogLoops(baselineFireCounts?: ReadonlyMap<string, number>, isCurrent?: () => boolean): Promise<number>;
  evaluateTaskBacklog(taskStore?: TaskStore, pendingCount?: number): Promise<{ entry?: LoopEntry; created: boolean; cleaned: number }>;
  isAutoTaskWorkerLoop(entry: LoopEntry): boolean;
  isTaskBacklogLoop(entry: LoopEntry): boolean;
  findAutoTaskWorkerLoop(): LoopEntry | undefined;
  migrateAutoTaskWorkerPrompts(): number;
}

export function createTaskBacklogRuntime(options: TaskBacklogRuntimeOptions): TaskBacklogRuntime {
  const {
    getLoops,
    deleteLoop,
    updateLoopWorker,
    recordDeletionTombstone,
    removeTrigger,
    updateWidget,
    hasPendingTasks,
    adoptLoop,
    triggerHasEventSource,
    emitLoopAutodeleted,
    emitTaskBacklogEmpty,
    captureIsCurrent,
    debug,
  } = options;

  function isAutoTaskWorkerLoop(entry: LoopEntry): boolean {
    return entry.status === "active"
      && !entry.workflow
      && !entry.orchestration
      && isAutoTaskWorkerPrompt(entry.prompt)
      && triggerHasEventSource(entry.trigger, "tasks:created");
  }

  function isTaskBacklogLoop(entry: LoopEntry): boolean {
    return entry.status === "active"
      && !entry.workflow
      && !entry.orchestration
      && triggerHasEventSource(entry.trigger, "tasks:created")
      && (entry.taskBacklog === true || isAutoTaskWorkerLoop(entry));
  }

  function findAutoTaskWorkerLoop(): LoopEntry | undefined {
    return getLoops().find(isAutoTaskWorkerLoop);
  }

  function migrateAutoTaskWorkerPrompts(): number {
    let migrated = 0;
    for (const entry of getLoops()) {
      if (entry.workflow || entry.orchestration) continue;
      if (!isAutoTaskWorkerPrompt(entry.prompt)) continue;
      if (!triggerHasEventSource(entry.trigger, "tasks:created")) continue;
      if (entry.prompt === AUTO_TASK_WORKER_PROMPT && entry.taskBacklog) continue;
      if (updateLoopWorker(entry.id, AUTO_TASK_WORKER_PROMPT)) migrated++;
    }
    return migrated;
  }

  function deleteTaskBacklogLoop(entry: LoopEntry, pendingCount: number): void {
    debug?.(`task backlog loop #${entry.id} — no pending tasks remain, deleting`);
    removeTrigger(entry.id);
    recordDeletionTombstone?.(entry.id, { reason: "task_backlog_empty", pendingCount });
    deleteLoop(entry.id);
    emitLoopAutodeleted?.(buildLoopAutodeletedPayload(entry, pendingCount));
  }

  async function adoptTaskBacklogLoops(
    baselineFireCounts?: ReadonlyMap<string, number>,
    isCurrent?: () => boolean,
  ): Promise<number> {
    if (isCurrent && !isCurrent()) return 0;
    const backlogLoops = getLoops().filter((entry) => isTaskBacklogLoop(entry)
      && (baselineFireCounts === undefined || (entry.fireCount ?? 0) <= (baselineFireCounts.get(entry.id) ?? 0)));
    if (backlogLoops.length === 0) return 0;

    const pending = await hasPendingTasks();
    if (isCurrent && !isCurrent()) return 0;
    if (pending <= 0) return 0;

    let adopted = 0;
    for (const entry of backlogLoops) {
      if (isCurrent && !isCurrent()) break;
      debug?.(`task backlog loop #${entry.id} — adopting ${pending} unfinished task(s)`);
      await adoptLoop(entry);
      adopted++;
    }
    return adopted;
  }

  async function cleanupTaskBacklogLoops(isCurrent?: () => boolean): Promise<number> {
    if (isCurrent && !isCurrent()) return 0;
    const backlogLoops = getLoops().filter(isTaskBacklogLoop);
    if (backlogLoops.length === 0) return 0;

    const pending = await hasPendingTasks();
    if (isCurrent && !isCurrent()) return 0;
    if (pending < 0 || pending > 0) return 0;

    const deletable = backlogLoops.filter((entry) => {
      const current = getLoops().find((candidate) => candidate.id === entry.id);
      return current?.createdAt === entry.createdAt && isTaskBacklogLoop(current);
    });
    if (deletable.length === 0) return 0;
    const deletedLoopIds = deletable.map((entry) => entry.id);
    emitTaskBacklogEmpty?.(buildTaskBacklogEmptyPayload(deletedLoopIds));
    let deleted = 0;
    for (const entry of deletable) {
      if (isCurrent && !isCurrent()) break;
      const current = getLoops().find((candidate) => candidate.id === entry.id);
      if (current?.createdAt !== entry.createdAt || !isTaskBacklogLoop(current)) continue;
      deleteTaskBacklogLoop(entry, pending);
      deleted++;
    }
    if (deleted > 0) updateWidget();
    return deleted;
  }

  type TaskBacklogDispatchResult = {
    kind: "cleanup";
    cleaned: number;
  };

  const taskBacklogReducerHandler: ReducerHandler = (incoming: ReducerEvent) => {
    if (incoming.type !== "TASK_BACKLOG_EVALUATED") return [];
    return reduceTaskBacklogEvent(incoming as TaskBacklogEvent);
  };

  async function evaluateTaskBacklog(taskStore?: TaskStore, pendingCount?: number): Promise<{ entry?: LoopEntry; created: boolean; cleaned: number }> {
    const isCurrent = captureIsCurrent?.();
    const resolvedPending = pendingCount ?? (taskStore ? taskStore.pendingCount() : await hasPendingTasks());
    if (isCurrent && !isCurrent()) return { created: false, cleaned: 0 };
    const taskBacklogCoordinator = createCoordinator<TaskBacklogDispatchResult>({
      reducers: [taskBacklogReducerHandler],
      effectHandlers: {
        CLEANUP_TASK_BACKLOG_LOOPS: async () => ({
          kind: "cleanup",
          cleaned: await cleanupTaskBacklogLoops(isCurrent),
        }),
      },
    });
    const results = await taskBacklogCoordinator.dispatch({
      type: "TASK_BACKLOG_EVALUATED",
      at: Date.now(),
      source: "system",
      entityType: "task",
      payload: { pendingCount: resolvedPending },
    });

    return {
      created: false,
      cleaned: results.find((result) => result.kind === "cleanup")?.cleaned ?? 0,
    };
  }

  return {
    cleanupTaskBacklogLoops,
    adoptTaskBacklogLoops,
    evaluateTaskBacklog,
    isAutoTaskWorkerLoop,
    isTaskBacklogLoop,
    findAutoTaskWorkerLoop,
    migrateAutoTaskWorkerPrompts,
  };
}
