import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import {
  createTask,
  deleteTask,
  type TaskBacklogResult,
  type TaskMutationContext,
  taskMutationRejectionMessage,
  updateTask,
} from "../runtime/task-mutations.js";
import { TaskStore } from "../task-store.js";


export interface TasksCommandOptions {
  pi: ExtensionAPI;
  getNativeTaskStore: () => TaskStore | undefined;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

export function registerTasksCommand(options: TasksCommandOptions): void {
  const { pi, getNativeTaskStore, evaluateTaskBacklog, updateWidget } = options;

  function mutationContext(taskStore: TaskStore): TaskMutationContext {
    return { pi, taskStore, evaluateTaskBacklog, updateWidget };
  }

  async function createNativeTask(subject: string, description: string) {
    const taskStore = getNativeTaskStore();
    if (!taskStore) return undefined;
    return await createTask(mutationContext(taskStore), { subject, description });
  }

  async function createNativeTaskInteractively(ui: ExtensionUIContext) {
    const taskStore = getNativeTaskStore();
    if (!taskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const subject = await ui.input("Task subject");
    if (!subject) return;
    const description = await ui.input("Task description") || subject;
    const created = await createNativeTask(subject, description);
    if (!created) return;
    ui.notify(`Task #${created.entry.id} created`, "info");
    if (created.backlog.created && created.backlog.entry) {
      ui.notify(`Backlog worker loop #${created.backlog.entry.id} created`, "info");
    }
  }

  async function viewNativeTasks(ui: ExtensionUIContext): Promise<void> {
    const taskStore = getNativeTaskStore();
    if (!taskStore) {
      ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
      return;
    }

    const tasks = taskStore.list();
    const choices = tasks.map((task) => {
      const icon = task.status === "in_progress" ? ">" : task.status === "completed" ? "ok" : task.status === "closed" ? "x" : "*";
      return `${icon} #${task.id} [${task.status}] ${task.subject.slice(0, 60)}`;
    });
    choices.unshift("+ Create task");
    choices.push("< Back");

    const selected = await ui.select("Tasks", choices);
    if (!selected || selected === "< Back") return;
    if (selected === "+ Create task") {
      await createNativeTaskInteractively(ui);
      return viewNativeTasks(ui);
    }

    const taskId = selected.match(/#(\d+)/)?.[1];
    if (!taskId) return viewNativeTasks(ui);

    const task = taskStore.get(taskId);
    if (!task) return viewNativeTasks(ui);

    const actions = ["x Delete"];
    if (task.status === "pending") {
      actions.unshift("x Close without completing");
      actions.unshift("ok Complete");
      actions.unshift("> Start");
    } else if (task.status === "in_progress") {
      actions.unshift("x Close without completing");
      actions.unshift("ok Complete");
    } else {
      actions.unshift("* Reopen");
    }
    actions.push("< Back");

    const action = await ui.select(`#${task.id}: ${task.subject}\n\n${task.description}`, actions);
    if (!action || action === "< Back") return viewNativeTasks(ui);

    const claimId = task.claim ? await ui.input("Claim token required") : undefined;
    if (task.claim && !claimId) {
      ui.notify(`Task #${task.id} unchanged: claim token required`, "warning");
      return viewNativeTasks(ui);
    }

    let changed = false;
    let rejection: string | undefined;
    if (action === "x Delete") {
      const result = await deleteTask(mutationContext(taskStore), { id: task.id, claimId });
      changed = result.applied;
      if (!result.applied) rejection = taskMutationRejectionMessage(task.id, result);
    } else {
      const status = action === "> Start"
        ? "in_progress"
        : action === "ok Complete"
          ? "completed"
          : action === "x Close without completing"
            ? "closed"
            : action === "* Reopen"
              ? "pending"
              : undefined;
      if (status) {
        const result = await updateTask(mutationContext(taskStore), { id: task.id, status, claimId });
        changed = result.applied;
        if (!result.applied) rejection = taskMutationRejectionMessage(task.id, result);
      }
    }

    if (!changed) {
      ui.notify(`Task #${task.id} unchanged: ${rejection ?? "operation rejected"}`, "warning");
      return viewNativeTasks(ui);
    }
    const pastTense = action === "x Delete" ? "deleted"
      : action === "> Start" ? "started"
        : action === "ok Complete" ? "completed"
          : action === "x Close without completing" ? "closed without completing"
            : "reopened";
    ui.notify(`Task #${task.id} ${pastTense}`, "info");
    return viewNativeTasks(ui);
  }

  pi.registerCommand("tasks", {
    description: "View or manage native pi-loop tasks when pi-tasks is not installed",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const trimmed = args.trim();
      const taskStore = getNativeTaskStore();
      if (!taskStore) {
        ctx.ui.notify("Native tasks are unavailable while pi-tasks is active", "warning");
        return;
      }
      if (trimmed) {
        const created = await createNativeTask(trimmed.slice(0, 80), trimmed);
        if (!created) return;
        ctx.ui.notify(`Task #${created.entry.id} created`, "info");
        if (created.backlog.created && created.backlog.entry) {
          ctx.ui.notify(`Backlog worker loop #${created.backlog.entry.id} created`, "info");
        }
        return;
      }
      await viewNativeTasks(ctx.ui);
    },
  });
}
