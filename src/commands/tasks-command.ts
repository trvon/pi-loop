import type { ExtensionAPI, ExtensionCommandContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { emitNativeTaskEvent } from "../runtime/task-events.js";
import { TaskStore } from "../task-store.js";
import type { TaskEntry } from "../task-types.js";

export interface TaskBacklogResult {
  created: boolean;
  entry?: { id: string };
}

export interface TasksCommandOptions {
  pi: ExtensionAPI;
  getNativeTaskStore: () => TaskStore | undefined;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

export function registerTasksCommand(options: TasksCommandOptions): void {
  const { pi, getNativeTaskStore, evaluateTaskBacklog, updateWidget } = options;

  async function emitCreated(entry: TaskEntry) {
    emitNativeTaskEvent(pi, "tasks:created", entry);
    const taskStore = getNativeTaskStore();
    if (!taskStore) return { created: false } satisfies TaskBacklogResult;
    const backlog = await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
    updateWidget();
    return backlog;
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
    const entry = taskStore.create(subject, description);
    const backlog = await emitCreated(entry);
    ui.notify(`Task #${entry.id} created`, "info");
    if (backlog.created && backlog.entry) {
      ui.notify(`Backlog worker loop #${backlog.entry.id} created`, "info");
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
      const icon = task.status === "in_progress" ? ">" : task.status === "completed" ? "ok" : "*";
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

    const match = selected.match(/#(\d+)/);
    if (!match) return viewNativeTasks(ui);

    const task = taskStore.get(match[1]);
    if (!task) return viewNativeTasks(ui);

    const actions = ["x Delete"];
    if (task.status === "pending") {
      actions.unshift("ok Complete");
      actions.unshift("> Start");
    } else if (task.status === "in_progress") {
      actions.unshift("ok Complete");
      actions.unshift("* Return to pending");
    } else {
      actions.unshift("* Reopen");
    }
    actions.push("< Back");

    const action = await ui.select(`#${task.id}: ${task.subject}\n\n${task.description}`, actions);
    if (!action || action === "< Back") return viewNativeTasks(ui);

    if (action === "x Delete") {
      taskStore.delete(task.id);
      emitNativeTaskEvent(pi, "tasks:deleted", task, task.status);
      ui.notify(`Task #${task.id} deleted`, "info");
    } else if (action === "> Start") {
      const next = taskStore.start(task.id);
      if (next) emitNativeTaskEvent(pi, "tasks:started", next, task.status);
      ui.notify(`Task #${task.id} started`, "info");
    } else if (action === "ok Complete") {
      const next = taskStore.complete(task.id);
      if (next) emitNativeTaskEvent(pi, "tasks:completed", next, task.status);
      ui.notify(`Task #${task.id} completed`, "info");
    } else if (action === "* Return to pending" || action === "* Reopen") {
      const next = taskStore.reopen(task.id);
      if (next) emitNativeTaskEvent(pi, "tasks:reopened", next, task.status);
      ui.notify(`Task #${task.id} reopened`, "info");
    }

    updateWidget();
    await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
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
        const entry = taskStore.create(trimmed.slice(0, 80), trimmed);
        const backlog = await emitCreated(entry);
        ctx.ui.notify(`Task #${entry.id} created`, "info");
        if (backlog.created && backlog.entry) {
          ctx.ui.notify(`Backlog worker loop #${backlog.entry.id} created`, "info");
        }
        return;
      }
      await viewNativeTasks(ctx.ui);
    },
  });
}
