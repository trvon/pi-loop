import { formatLastTransitionLines } from "../loop-format.js";
import { displayRows, type ToolDisplayDetails, type ToolDisplayTone } from "../tools/tool-result.js";
import type { LoopEntry } from "../types.js";
import { getWorkflowOutcomeAvailability } from "../workflow-reducer.js";

export function workflowAttemptLabel(entry: LoopEntry): string {
  const workflow = entry.workflow;
  if (!workflow) return "?";
  const state = workflow.definition.states[workflow.currentState];
  const attempt = workflow.attemptsByState[workflow.currentState] ?? 1;
  return state?.maxAttempts ? `${attempt}/${state.maxAttempts}` : String(attempt);
}

export function workflowLeaseLabel(entry: LoopEntry): string {
  const workflow = entry.workflow;
  if (!workflow) return "unavailable";
  const execution = workflow.activeExecution;
  if (!execution) return workflow.definition.states[workflow.currentState]?.task ? "missing" : "not required";
  return execution.lease ? `active until ${new Date(execution.lease.expiresAt).toISOString()}` : "unowned";
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
  const lines = [
    `Goal: ${entry.prompt}`,
    `State: ${workflow.currentState} · revision ${workflow.definitionRevision} · transition ${workflow.transitionSeq}`,
    `Attempt: ${workflowAttemptLabel(entry)}`,
    state?.prompt ? `Instruction: ${state.prompt}` : undefined,
    workflow.activeExecution ? `Work: ${workflow.activeExecution.subject} (${workflow.activeExecution.id})` : undefined,
    `Lease: ${workflowLeaseLabel(entry)}`,
    availability.available.length > 0 ? `Outcomes: ${availability.available.join(", ")}` : undefined,
    availability.unavailable.length > 0 ? `Unavailable: ${availability.unavailable.map((item) => item.outcome).join(", ")}` : undefined,
    workflow.waitingMonitor ? `Waiting: monitor #${workflow.waitingMonitor.monitorId}` : undefined,
    workflow.lastTransition ? formatLastTransitionLines(workflow.lastTransition).join("\n") : undefined,
    ...extra,
  ].filter((line): line is string => line !== undefined);
  return { kind: "workflow", action, tone, summary, expanded: displayRows(lines, 12) };
}

export function formatWorkflowInspection(entry: LoopEntry): string {
  const workflow = entry.workflow;
  if (!workflow) return `#${entry.id}: ${entry.prompt}`;
  const state = workflow.definition.states[workflow.currentState];
  const availability = getWorkflowOutcomeAvailability(workflow);
  const lines = [
    `#${entry.id}: ${entry.prompt}`,
    `State: ${workflow.currentState} · attempt ${workflowAttemptLabel(entry)}`,
    `Revision: ${workflow.definitionRevision} · transition: ${workflow.transitionSeq}`,
    `Lease: ${workflowLeaseLabel(entry)}`,
    availability.available.length > 0 ? `Outcomes: ${availability.available.join(", ")}` : "Outcomes: none",
    state?.prompt ? `Instruction: ${state.prompt}` : undefined,
    workflow.waitingMonitor ? `Waiting on monitor #${workflow.waitingMonitor.monitorId}` : undefined,
  ].filter((line): line is string => line !== undefined);
  return lines.join("\n");
}
