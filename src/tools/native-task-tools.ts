import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  createTask,
  deleteTask,
  type TaskBacklogResult,
  type TaskMutationContext,
  updateTask,
} from "../runtime/task-mutations.js";
import { TaskStore } from "../task-store.js";
import type { TaskStatus } from "../task-types.js";
import { renderToolCall, renderToolResult, toolArg } from "../ui/tool-renderer.js";
import { displayRows, textResult } from "./tool-result.js";

export type { TaskBacklogResult };

export interface NativeTaskToolsOptions {
  pi: ExtensionAPI;
  taskStore: TaskStore;
  evaluateTaskBacklog: (taskStore: TaskStore, pendingCount: number) => Promise<TaskBacklogResult>;
  updateWidget: () => void;
}

function backlogSuffix(backlog: TaskBacklogResult): string {
  return backlog.created && backlog.entry
    ? `\nBacklog worker loop #${backlog.entry.id} created`
    : "";
}

export function registerNativeTaskTools(options: NativeTaskToolsOptions): void {
  const { pi, taskStore, evaluateTaskBacklog, updateWidget } = options;
  const mutationCtx: TaskMutationContext = { pi, taskStore, evaluateTaskBacklog, updateWidget };

  pi.registerTool({
    name: "TaskCreate",
    label: "TaskCreate",
    renderCall: renderToolCall("Task", (args) => `create · ${String(toolArg(args, "subject") ?? "task").slice(0, 56)}`),
    renderResult: renderToolResult,
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
      const { entry, backlog } = await createTask(mutationCtx, {
        subject: params.subject,
        description: params.description,
      });
      return textResult(`Task #${entry.id} created: ${entry.subject}${backlogSuffix(backlog)}`, {
        kind: "task",
        action: "create",
        tone: "success",
        summary: `Task #${entry.id} pending · ${entry.subject.slice(0, 56)}`,
        expanded: [
          `Description: ${entry.description}`,
          backlog.created && backlog.entry ? `Backlog worker: loop #${backlog.entry.id} created` : "Backlog worker: unchanged",
        ],
      });
    },
  });

  pi.registerTool({
    name: "TaskList",
    label: "TaskList",
    renderCall: renderToolCall("Task", () => "status"),
    renderResult: renderToolResult,
    description: "List all tasks with status. Use to check progress and find available work.",
    parameters: Type.Object({}),
    execute() {
      const tasks = taskStore.list();
      if (tasks.length === 0) {
        return Promise.resolve(textResult("No tasks.", {
          kind: "task", action: "list", tone: "info", summary: "No tasks", expanded: ["Use TaskCreate for work that spans turns."],
        }));
      }

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
      return Promise.resolve(textResult(lines.join("\n"), {
        kind: "task",
        action: "list",
        tone: "info",
        summary: `${tasks.length} task${tasks.length === 1 ? "" : "s"} · ${statuses.pending} pending · ${statuses.in_progress} active`,
        expanded: displayRows(lines.slice(1)),
      }));
    },
  });

  pi.registerTool({
    name: "TaskUpdate",
    label: "TaskUpdate",
    renderCall: renderToolCall("Task", (args) => `update · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
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
      const result = await updateTask(mutationCtx, {
        id,
        status: status as TaskStatus | undefined,
        subject,
        description,
      });
      if (!result) {
        return textResult(`Task #${id} not found`, {
          kind: "task", action: "update", tone: "error", summary: `Task #${id} not found`, expanded: ["Use TaskList to find valid task IDs."],
        });
      }
      const statusMsg = status ? ` → ${status}` : "";
      return textResult(`Task #${id} updated${statusMsg}${backlogSuffix(result.backlog)}`, {
        kind: "task",
        action: "update",
        tone: "success",
        summary: `Task #${id}${status ? ` → ${status}` : " updated"}`,
        expanded: [
          `Subject: ${result.entry.subject}`,
          `Status: ${result.entry.status}`,
          result.backlog.created && result.backlog.entry ? `Backlog worker: loop #${result.backlog.entry.id} created` : "Backlog worker: unchanged",
        ],
      });
    },
  });

  pi.registerTool({
    name: "TaskDelete",
    label: "TaskDelete",
    renderCall: renderToolCall("Task", (args) => `delete · #${String(toolArg(args, "id") ?? "?")}`),
    renderResult: renderToolResult,
    description: "Delete a task by ID. Use for cleaning up completed or irrelevant tasks.",
    parameters: Type.Object({
      id: Type.String({ description: "Task ID to delete" }),
    }),
    async execute(_toolCallId, params) {
      const result = await deleteTask(mutationCtx, params.id);
      if (!result) {
        return textResult(`Task #${params.id} not found`, {
          kind: "task", action: "delete", tone: "error", summary: `Task #${params.id} not found`, expanded: ["Use TaskList to find valid task IDs."],
        });
      }
      return textResult(`Task #${params.id} deleted`, {
        kind: "task", action: "delete", tone: "success", summary: `Task #${params.id} deleted`, expanded: [],
      });
    },
  });
}
