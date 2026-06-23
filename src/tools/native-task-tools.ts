import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { emitNativeTaskEvent } from "../runtime/task-events.js";
import { TaskStore } from "../task-store.js";

export interface TaskBacklogResult {
  created: boolean;
  entry?: { id: string };
}

export interface NativeTaskToolsOptions {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

function textResult(msg: string) {
  return { content: [{ type: "text" as const, text: msg }], details: undefined as any };
}

export function registerNativeTaskTools(options: NativeTaskToolsOptions): void {
  const { pi, taskStore, evaluateTaskBacklog, updateWidget } = options;

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    description: `Create a task for tracking work across turns. Use when you need to track progress on complex multi-step tasks or turn a broad user goal into a concrete backlog.

Fields:
- subject: brief actionable title
- description: detailed requirements and done condition`,
    promptGuidelines: [
      "Use TaskCreate to track complex multi-step work across turns.",
      "When the user gives a broad goal, use multiple TaskCreate calls to decompose it into a small backlog of concrete tasks rather than one oversized task.",
      "If the user supplies a shared goal or meta-goal, preserve it explicitly using the user's wording and tie each created task back to that goal in its description.",
      "If several tasks share one goal, keep subjects short and put the shared goal in the first sentence of each description or as an equivalent explicit framing.",
      "Prefer 2-5 tasks that separate investigation, implementation, validation, and reporting or commit-prep when those phases are distinct.",
      "When the user asks to break work into tasks, create the backlog directly and do not pivot to loops, monitors, or other automation unless the user also asked for ongoing automation.",
      "Make each `subject` a short verb-object action.",
      "Make each `description` include the expected artifact, outcome, or done condition so another turn can pick the task up cleanly.",
      "Break work into small, independently completable tasks. A task should be finishable in one focused session — if a task would take multiple turns, split it further.",
      "TaskCreate accepts `subject` and `description` parameters only — do not invent extra fields unless the schema explicitly adds them.",
    ],
    parameters: Type.Object({
      subject: Type.String({ description: "Brief actionable title for the task" }),
      description: Type.String({ description: "Detailed description of what needs to be done" }),
    }),
    async execute(_toolCallId, params) {
      const entry = taskStore.create(params.subject, params.description);
      emitNativeTaskEvent(pi, "tasks:created", entry);
      const backlog = await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      updateWidget();

      const autoLoopMsg = backlog.created && backlog.entry
        ? `\nBacklog worker loop #${backlog.entry.id} created`
        : "";
      return Promise.resolve(textResult(`Task #${entry.id} created: ${entry.subject}${autoLoopMsg}`));
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    description: "List all tasks with status. Use to check progress and find available work.",
    parameters: Type.Object({}),
    execute() {
      const tasks = taskStore.list();
      if (tasks.length === 0) return Promise.resolve(textResult("No tasks."));

      const lines: string[] = [];
      const statuses: Record<"pending" | "in_progress" | "completed", number> = {
        pending: 0,
        in_progress: 0,
        completed: 0,
      };
      for (const t of tasks) {
        statuses[t.status]++;
        const icon = t.status === "completed" ? "ok" : t.status === "in_progress" ? ">" : "*";
        lines.push(`${icon} #${t.id} [${t.status}] ${t.subject.slice(0, 80)}`);
      }
      lines.unshift(`${tasks.length} tasks (${statuses.pending} pending, ${statuses.in_progress} in progress, ${statuses.completed} done)`);
      return Promise.resolve(textResult(lines.join("\n")));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    description: `Update task status or details. Set status to "in_progress" before starting work, "completed" when done.

Statuses: pending → in_progress → completed
Parameters: id (required), status, subject, description`,
    promptGuidelines: [
      "TaskUpdate uses parameter `id`, not `taskId`.",
      "Accepted parameters: `id` (required), `status`, `subject`, `description`.",
      "When validation fails with 'must have required properties id', you passed `taskId` instead of `id`. Correct silently and retry.",
    ],
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to update" }),
      status: Type.Optional(Type.String({ description: "New status", enum: ["pending", "in_progress", "completed"] })),
      subject: Type.Optional(Type.String({ description: "New title" })),
      description: Type.Optional(Type.String({ description: "New description" })),
    }),
    async execute(_toolCallId, params) {
      const { id, status, subject, description } = params;
      let entry = taskStore.get(id);
      if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));

      const previousStatus = entry.status;
      if (status === "in_progress") {
        entry = taskStore.start(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:started", entry, previousStatus);
      } else if (status === "completed") {
        entry = taskStore.complete(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:completed", entry, previousStatus);
      } else if (status === "pending") {
        entry = taskStore.reopen(id);
        if (entry) emitNativeTaskEvent(pi, "tasks:reopened", entry, previousStatus);
      }

      if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));
      if (subject !== undefined || description !== undefined) {
        entry = taskStore.updateDetails(id, { subject, description });
        if (entry) emitNativeTaskEvent(pi, "tasks:updated", entry, previousStatus);
      }
      if (!entry) return Promise.resolve(textResult(`Task #${id} not found`));
      updateWidget();
      const backlog = await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
      const statusMsg = status ? ` → ${status}` : "";
      const autoLoopMsg = backlog.created && backlog.entry
        ? `\nBacklog worker loop #${backlog.entry.id} created`
        : "";
      return Promise.resolve(textResult(`Task #${id} updated${statusMsg}${autoLoopMsg}`));
    },
  });

  pi.registerTool({
    name: "TaskDelete",
    label: "TaskDelete",
    description: "Delete a task by ID. Use for cleaning up completed or irrelevant tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete" }),
    }),
    async execute(_toolCallId, params) {
      const existing = taskStore.get(params.id);
      const deleted = taskStore.delete(params.id);
      updateWidget();
      if (deleted) {
        if (existing) emitNativeTaskEvent(pi, "tasks:deleted", existing, existing.status);
        await evaluateTaskBacklog(taskStore, taskStore.pendingCount());
        return Promise.resolve(textResult(`Task #${params.id} deleted`));
      }
      return Promise.resolve(textResult(`Task #${params.id} not found`));
    },
  });
}
