import { formatLastTransitionLines } from "../loop-format.js";
import { displayRows, type ToolDisplayDetails, type ToolDisplayTone } from "../tools/tool-result.js";
import type { LoopEntry } from "../types.js";
import { formatWorkflowGraphWarnings } from "../workflow-graph.js";
import { getWorkflowOutcomeAvailability, type WorkflowOutcomeAvailability } from "../workflow-reducer.js";
import { activeCardGlyphs } from "./card-style.js";
import { ACTIVITY_TONE, type PanelLine, type PanelSegment, plainPanelText, stateWindow } from "./progress-panel.js";

const CARD_STATE_WINDOW = 5;
const LIST_PREVIEW_WORKFLOWS = 3;
// Same status word as the summary line, so the two never disagree. Only our own
// words are upper-cased; an identifier is information, not style.
function activityTag(entry: LoopEntry, activity: WorkflowActivity): string {
  const workflow = entry.workflow;
  const monitor = workflow?.waitingMonitor ? ` MONITOR #${plainPanelText(workflow.waitingMonitor.monitorId)}` : "";
  // Idle current work without a live lease is waiting on WorkflowClaim.
  const unclaimed = activity.status === "idle" && workflow?.activeExecution?.status === "active" ? " (unclaimed)" : "";
  return `${activity.status.toUpperCase()}${monitor} ${formatCompactWorkflowDuration(activity.activityMs)}${unclaimed}`;
}

/**
 * One dense line for the collapsed tool card: the state trail, derived
 * activity, attempt, and available outcomes. Presentation only; "claimed" is a
 * live lease, not observed execution. Glyphs follow the active card style.
 */
export function workflowCardPreview(entry: LoopEntry, now = Date.now()): PanelLine[] {
  const workflow = entry.workflow;
  if (!workflow) return [];
  const glyphs = activeCardGlyphs();
  const activity = deriveWorkflowActivity(entry, now);
  const tone = ACTIVITY_TONE[activity.status];
  const window = stateWindow(Object.keys(workflow.definition.states), workflow.currentState, CARD_STATE_WINDOW);
  const hop: PanelSegment = { text: glyphs.hop, tone: "dim" };
  const field: PanelSegment = { text: glyphs.field, tone: "dim" };
  const line: PanelLine = [{ text: "  ", tone: "dim" }];
  if (window.before > 0) line.push({ text: glyphs.ellipsis, tone: "dim" }, hop);
  window.names.forEach((name, index) => {
    if (index > 0) line.push(hop);
    const label = plainPanelText(name);
    if (name === workflow.currentState) line.push({ text: `${glyphs.currentOpen}${label}${glyphs.currentClose}`, tone: "accent" });
    // Visited is marked explicitly: rework can revisit a state left of one already done.
    else if ((workflow.attemptsByState[name] ?? 0) > 0) line.push({ text: `${glyphs.visited}${label}`, tone: "success" });
    else line.push({ text: label, tone: "dim" });
  });
  if (window.after > 0) line.push(hop, { text: glyphs.ellipsis, tone: "dim" });

  line.push(field, { text: activityTag(entry, activity), tone });
  const state = workflow.definition.states[workflow.currentState];
  if (state && !state.terminal) line.push(field, { text: `try ${workflowAttemptLabel(entry)}`, tone: "muted" });
  const outcomes = getWorkflowOutcomeAvailability(workflow).available;
  if (outcomes.length > 0) {
    line.push(field, { text: `${glyphs.next}${outcomes.map(plainPanelText).join(glyphs.outcomeJoin)}`, tone: "muted" });
  }
  return [line];
}

/** Collapsed LoopList preview: the full trail for one workflow, a one-line roster for several. */
export function workflowListPreview(entries: readonly LoopEntry[], now = Date.now()): PanelLine[] {
  const workflows = entries.filter((entry) => entry.workflow !== undefined);
  const only = workflows[0];
  if (workflows.length === 0) return [];
  if (workflows.length === 1 && only) return workflowCardPreview(only, now);
  const glyphs = activeCardGlyphs();
  const line: PanelLine = [{ text: "  ", tone: "dim" }];
  workflows.slice(0, LIST_PREVIEW_WORKFLOWS).forEach((entry, index) => {
    const activity = deriveWorkflowActivity(entry, now);
    if (index > 0) line.push({ text: glyphs.field, tone: "dim" });
    line.push(
      { text: `#${entry.id} `, tone: "dim" },
      { text: `${glyphs.currentOpen}${plainPanelText(entry.workflow?.currentState ?? "?")}${glyphs.currentClose}`, tone: "accent" },
      { text: ` ${activityTag(entry, activity)}`, tone: ACTIVITY_TONE[activity.status] },
    );
  });
  if (workflows.length > LIST_PREVIEW_WORKFLOWS) {
    line.push({ text: `${glyphs.field}+${workflows.length - LIST_PREVIEW_WORKFLOWS}`, tone: "dim" });
  }
  return [line];
}

export type WorkflowActivityStatus = "claimed" | "waiting" | "paused" | "idle" | "stopped";

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

// Rounds to the nearest unit, but carries into the next unit instead of
// printing an overflowed label such as "60s", "60m", or "168h".
export function formatCompactWorkflowDuration(ms: number): string {
  const bounded = Math.max(0, ms);
  const seconds = Math.round(bounded / 1_000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(bounded / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(bounded / 3_600_000);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(bounded / 86_400_000)}d`;
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
    status = "waiting";
    statusSince = workflow.waitingMonitor.attachedAt;
  } else if (execution?.lease && execution.lease.expiresAt > now) {
    status = "claimed";
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
    ...workflowTimingLines(entry, now),
    `State: ${workflow.currentState} · revision ${workflow.definitionRevision} · transition ${workflow.transitionSeq}`,
    `Attempt: ${workflowAttemptLabel(entry)}`,
    // The renderer caps expanded output, so short actionable rows precede the
    // free-form prose (goal, instruction) that can wrap past the cap.
    `Lease: ${workflowLeaseLabel(entry, now)}`,
    availability.available.length > 0 ? `Outcomes: ${availability.available.join(", ")}` : undefined,
    availability.unavailable.length > 0 ? `Unavailable: ${availability.unavailable.map((item) => item.outcome).join(", ")}` : undefined,
    workflow.waitingMonitor ? `Waiting: monitor #${workflow.waitingMonitor.monitorId}` : undefined,
    ...formatWorkflowGraphWarnings(workflow),
    workflow.activeExecution ? `Work: ${workflow.activeExecution.subject} (${workflow.activeExecution.id})` : undefined,
    `Goal: ${entry.prompt}`,
    state?.prompt ? `Instruction: ${state.prompt}` : undefined,
    workflow.lastTransition ? formatLastTransitionLines(workflow.lastTransition).join("\n") : undefined,
    ...extra,
  ].filter((line): line is string => line !== undefined);
  return { kind: "workflow", action, tone, summary: timedSummary, expanded: displayRows(lines, 15), preview: workflowCardPreview(entry, now) };
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
