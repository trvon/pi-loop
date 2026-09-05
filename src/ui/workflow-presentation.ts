import { formatLastTransitionLines } from "../loop-format.js";
import { displayRows, type ToolDisplayDetails, type ToolDisplayTone } from "../tools/tool-result.js";
import type { LoopEntry } from "../types.js";
import { formatWorkflowGraphWarnings } from "../workflow-graph.js";
import { getWorkflowOutcomeAvailability, type WorkflowOutcomeAvailability } from "../workflow-reducer.js";

export type WorkflowActivityStatus = "running" | "paused" | "idle" | "stopped";

type UnavailableOutcome = WorkflowOutcomeAvailability["unavailable"][number];

function unavailableOutcomeLabel(item: UnavailableOutcome): string {
  if ("reason" in item) return `${item.outcome} (${item.targetState} unbounded self-loop)`;
  return `${item.outcome} (${item.targetState} exhausted ${item.maxAttempts})`;
}

export interface WorkflowActivity {
  status: WorkflowActivityStatus;
  statusSince: number;
  activityMs: number;
  workflowAgeMs: number;
  stateAgeMs: number;
}

function boundedAge(end: number, start: number): number {
  return Math.max(0, end - start);
}

export function formatCompactWorkflowDuration(ms: number): string {
  const bounded = Math.max(0, ms);
  if (bounded < 60_000) return `${Math.round(bounded / 1_000)}s`;
  if (bounded < 3_600_000) return `${Math.round(bounded / 60_000)}m`;
  return `${Math.round(bounded / 3_600_000)}h`;
}

export function deriveWorkflowActivity(entry: LoopEntry, now = Date.now()): WorkflowActivity {
  const workflow = entry.workflow;
  if (!workflow) {
    return {
      status: entry.status === "paused" ? "paused" : "idle",
      statusSince: entry.updatedAt,
      activityMs: boundedAge(now, entry.updatedAt),
      workflowAgeMs: boundedAge(now, entry.createdAt),
      stateAgeMs: 0,
    };
  }

  const state = workflow.definition.states[workflow.currentState];
  const execution = workflow.activeExecution;
  let status: WorkflowActivityStatus;
  let statusSince: number;
  let lifetimeEnd = now;

  if (entry.status === "paused") {
    status = "paused";
    statusSince = entry.pause?.at ?? entry.updatedAt;
  } else if (state?.terminal === "completed" || (execution && execution.status !== "active")) {
    status = "stopped";
    statusSince = execution?.settledAt ?? execution?.updatedAt ?? entry.updatedAt;
    lifetimeEnd = statusSince;
  } else if (workflow.waitingMonitor) {
    status = "idle";
    statusSince = workflow.waitingMonitor.attachedAt;
  } else if (execution?.lease && execution.lease.expiresAt > now) {
    status = "running";
    statusSince = execution.lease.acquiredAt;
  } else {
    status = "idle";
    statusSince = execution?.lease?.expiresAt ?? execution?.createdAt ?? workflow.stateEnteredAt;
  }

  return {
    status,
    statusSince,
    activityMs: boundedAge(now, statusSince),
    workflowAgeMs: boundedAge(lifetimeEnd, entry.createdAt),
    stateAgeMs: boundedAge(lifetimeEnd, workflow.stateEnteredAt),
  };
}

export function workflowActivityLabel(entry: LoopEntry, now = Date.now()): string {
  const activity = deriveWorkflowActivity(entry, now);
  return `${activity.status} ${formatCompactWorkflowDuration(activity.activityMs)}`;
}

export function workflowTimingLines(entry: LoopEntry, now = Date.now()): string[] {
  const activity = deriveWorkflowActivity(entry, now);
  return [
    `Activity: ${activity.status} · ${formatCompactWorkflowDuration(activity.activityMs)}`,
    `Workflow age: ${formatCompactWorkflowDuration(activity.workflowAgeMs)}`,
    `State age: ${formatCompactWorkflowDuration(activity.stateAgeMs)}`,
  ];
}

export function workflowTimingSummaryLine(entry: LoopEntry, now = Date.now()): string {
  const activity = deriveWorkflowActivity(entry, now);
  return `Activity: ${activity.status} ${formatCompactWorkflowDuration(activity.activityMs)} · workflow age ${formatCompactWorkflowDuration(activity.workflowAgeMs)} · state age ${formatCompactWorkflowDuration(activity.stateAgeMs)}`;
}

export function workflowAttemptLabel(entry: LoopEntry): string {
  const workflow = entry.workflow;
  if (!workflow) return "?";
  const state = workflow.definition.states[workflow.currentState];
  const attempt = workflow.attemptsByState[workflow.currentState] ?? 1;
  return state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
}

export function workflowLeaseLabel(entry: LoopEntry, now = Date.now()): string {
  const workflow = entry.workflow;
  if (!workflow) return "unavailable";
  const execution = workflow.activeExecution;
  if (!execution) return workflow.definition.states[workflow.currentState]?.task ? "missing" : "not required";
  if (!execution.lease) return "unowned";
  const qualifier = execution.lease.expiresAt > now ? "active until" : "expired at";
  return `${qualifier} ${new Date(execution.lease.expiresAt).toISOString()}`;
}

interface WorkflowDisplayOptions {
  entry: LoopEntry;
  action: string;
  tone: ToolDisplayTone;
  summary: string;
  extra?: string[];
}

export function workflowDisplayDetails({
  entry,
  action,
  tone,
  summary,
  extra = [],
}: WorkflowDisplayOptions): ToolDisplayDetails {
  const workflow = entry.workflow;
  if (!workflow) {
    return { kind: "workflow", action, tone, summary, expanded: displayRows(extra, 12) };
  }
  const state = workflow.definition.states[workflow.currentState];
  const availability = getWorkflowOutcomeAvailability(workflow);
  const now = Date.now();
  const activity = deriveWorkflowActivity(entry, now);
  const timedSummary = `${summary} · ${activity.status} ${formatCompactWorkflowDuration(activity.activityMs)} · age ${formatCompactWorkflowDuration(activity.workflowAgeMs)}`;
  const lines = [
    `Goal: ${entry.prompt}`,
    ...workflowTimingLines(entry, now),
    `State: ${workflow.currentState} · revision ${workflow.definitionRevision} · transition ${workflow.transitionSeq}`,
    `Attempt: ${workflowAttemptLabel(entry)}`,
    ...formatWorkflowGraphWarnings(workflow),
    state?.prompt ? `Instruction: ${state.prompt}` : undefined,
    workflow.activeExecution ? `Work: ${workflow.activeExecution.subject} (${workflow.activeExecution.id})` : undefined,
    `Lease: ${workflowLeaseLabel(entry, now)}`,
    availability.available.length > 0 ? `Outcomes: ${availability.available.join(", ")}` : undefined,
    availability.unavailable.length > 0 ? `Unavailable: ${availability.unavailable.map((item) => item.outcome).join(", ")}` : undefined,
    workflow.waitingMonitor ? `Waiting: monitor #${workflow.waitingMonitor.monitorId}` : undefined,
    workflow.lastTransition ? formatLastTransitionLines(workflow.lastTransition).join("\n") : undefined,
    ...extra,
  ].filter((line): line is string => line !== undefined);
  return { kind: "workflow", action, tone, summary: timedSummary, expanded: displayRows(lines, 15) };
}

export function formatWorkflowInspection(entry: LoopEntry): string {
  const workflow = entry.workflow;
  if (!workflow) return `#${entry.id}: ${entry.prompt}`;
  const state = workflow.definition.states[workflow.currentState];
  const availability = getWorkflowOutcomeAvailability(workflow);
  const now = Date.now();
  const lines = [
    `#${entry.id}: ${entry.prompt}`,
    ...workflowTimingLines(entry, now),
    `State: ${workflow.currentState} · attempt ${workflowAttemptLabel(entry)}`,
    `Revision: ${workflow.definitionRevision} · transition: ${workflow.transitionSeq}`,
    `Lease: ${workflowLeaseLabel(entry, now)}`,
    ...formatWorkflowGraphWarnings(workflow),
    availability.available.length > 0 ? `Outcomes: ${availability.available.join(", ")}` : "Outcomes: none",
    availability.unavailable.length > 0
      ? `Unavailable: ${availability.unavailable.map(unavailableOutcomeLabel).join(", ")}`
      : undefined,
    state?.prompt ? `Instruction: ${state.prompt}` : undefined,
    workflow.waitingMonitor ? `Waiting on monitor #${workflow.waitingMonitor.monitorId}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}
