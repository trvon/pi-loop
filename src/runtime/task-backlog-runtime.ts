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
import type { LoopEntry, Trigger } from "../types.js";

export const AUTO_TASK_WORKER_THRESHOLD = 5;
export const AUTO_TASK_WORKER_PROMPT = "Run TaskList, pick next pending task, mark it in_progress, implement it, run validation, complete it. If no pending tasks remain, call LoopDelete on your own loop ID.";

export interface TaskBacklogRuntimeOptions {
  getLoops: () => LoopEntry[];
  createLoop: (trigger: Trigger, prompt: string, options: {
    recurring: boolean;
    taskBacklog?: boolean;
    maxFires?: number;
  }) => LoopEntry;
  deleteLoop: (id: string) => void;
  addTrigger: (entry: LoopEntry) => void;
  removeTrigger: (id: string) => void;
  updateWidget: () => void;
  hasPendingTasks: () => Promise<number>;
  bootstrapTaskLoop: (entry: LoopEntry) => Promise<boolean>;
  triggerHasEventSource: (trigger: Trigger | string, source: string) => boolean;
  debug?: (...args: unknown[]) => void;
}

export interface TaskBacklogRuntime {
  cleanupTaskBacklogLoops(): Promise<number>;
  ensureAutoTaskWorkerLoop(taskStore: TaskStore): Promise<{ entry?: LoopEntry; created: boolean }>;
  evaluateTaskBacklog(taskStore?: TaskStore, pendingCount?: number): Promise<{ entry?: LoopEntry; created: boolean; cleaned: number }>;
  isAutoTaskWorkerLoop(entry: LoopEntry): boolean;
  isTaskBacklogLoop(entry: LoopEntry): boolean;
  findAutoTaskWorkerLoop(): LoopEntry | undefined;
}

export function createTaskBacklogRuntime(options: TaskBacklogRuntimeOptions): TaskBacklogRuntime {
  const {
    getLoops,
    createLoop,
    deleteLoop,
    addTrigger,
    removeTrigger,
    updateWidget,
    hasPendingTasks,
    bootstrapTaskLoop,
    triggerHasEventSource,
    debug,
  } = options;

  function isAutoTaskWorkerLoop(entry: LoopEntry): boolean {
    return entry.status === "active"
      && entry.prompt === AUTO_TASK_WORKER_PROMPT
      && triggerHasEventSource(entry.trigger, "tasks:created");
  }

  function isTaskBacklogLoop(entry: LoopEntry): boolean {
    return entry.status === "active"
      && triggerHasEventSource(entry.trigger, "tasks:created")
      && (entry.taskBacklog === true || isAutoTaskWorkerLoop(entry));
  }

  function findAutoTaskWorkerLoop(): LoopEntry | undefined {
    return getLoops().find(isAutoTaskWorkerLoop);
  }

  async function cleanupTaskBacklogLoops(): Promise<number> {
    const backlogLoops = getLoops().filter(isTaskBacklogLoop);
    if (backlogLoops.length === 0) return 0;

    const pending = await hasPendingTasks();
    if (pending < 0 || pending > 0) return 0;

    for (const entry of backlogLoops) {
      debug?.(`task backlog loop #${entry.id} — no pending tasks remain, deleting`);
      removeTrigger(entry.id);
      deleteLoop(entry.id);
    }
    updateWidget();
    return backlogLoops.length;
  }

  async function ensureAutoTaskWorkerLoop(taskStore: TaskStore): Promise<{ entry?: LoopEntry; created: boolean }> {
    if (taskStore.pendingCount() < AUTO_TASK_WORKER_THRESHOLD) return { created: false };

    const existing = findAutoTaskWorkerLoop();
    if (existing) return { entry: existing, created: false };

    const trigger: Trigger = {
      type: "hybrid",
      cron: "*/5 * * * *",
      event: { source: "tasks:created" },
      debounceMs: 30000,
    };
    const entry = createLoop(trigger, AUTO_TASK_WORKER_PROMPT, {
      recurring: true,
      taskBacklog: true,
      maxFires: 30,
    });
    addTrigger(entry);
    await bootstrapTaskLoop(entry);
    updateWidget();
    return { entry, created: true };
  }

  let taskBacklogCoordinatorStore: TaskStore | undefined;
  let taskBacklogCoordinatorWorker: { entry?: LoopEntry; created: boolean } = { created: false };
  let taskBacklogCoordinatorCleanupCount = 0;

  const taskBacklogReducerHandler: ReducerHandler = (incoming: ReducerEvent) => {
    if (incoming.type !== "TASK_BACKLOG_EVALUATED") return [];
    return reduceTaskBacklogEvent(incoming as TaskBacklogEvent);
  };

  const taskBacklogCoordinator = createCoordinator({
    reducers: [taskBacklogReducerHandler],
    effectHandlers: {
      ENSURE_AUTO_TASK_WORKER: async () => {
        if (!taskBacklogCoordinatorStore) return;
        taskBacklogCoordinatorWorker = await ensureAutoTaskWorkerLoop(taskBacklogCoordinatorStore);
      },
      CLEANUP_TASK_BACKLOG_LOOPS: async () => {
        taskBacklogCoordinatorCleanupCount = await cleanupTaskBacklogLoops();
      },
    },
  });

  async function evaluateTaskBacklog(taskStore?: TaskStore, pendingCount?: number): Promise<{ entry?: LoopEntry; created: boolean; cleaned: number }> {
    const resolvedPending = pendingCount ?? (taskStore ? taskStore.pendingCount() : await hasPendingTasks());
    taskBacklogCoordinatorStore = taskStore;
    taskBacklogCoordinatorWorker = { created: false };
    taskBacklogCoordinatorCleanupCount = 0;

    await taskBacklogCoordinator.dispatch({
      type: "TASK_BACKLOG_EVALUATED",
      at: Date.now(),
      source: "system",
      entityType: "task",
      payload: { pendingCount: resolvedPending, threshold: AUTO_TASK_WORKER_THRESHOLD },
    });

    taskBacklogCoordinatorStore = undefined;
    return {
      entry: taskBacklogCoordinatorWorker.entry,
      created: taskBacklogCoordinatorWorker.created,
      cleaned: taskBacklogCoordinatorCleanupCount,
    };
  }

  return {
    cleanupTaskBacklogLoops,
    ensureAutoTaskWorkerLoop,
    evaluateTaskBacklog,
    isAutoTaskWorkerLoop,
    isTaskBacklogLoop,
    findAutoTaskWorkerLoop,
  };
}
