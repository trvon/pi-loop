import { formatTrigger } from "../loop-format.js";
import { atMaxFires } from "../loop-reducer.js";
import type { LoopStorageScope } from "../runtime/scope.js";
import type { LoopEntry } from "../types.js";
import { atWorkflowStateFireLimit, getActiveWorkflowStateLoop, isTerminalWorkflowRun } from "../workflow-reducer.js";

interface LifecycleInspectionContext {
  storageScope?: LoopStorageScope;
  nextFireAt?: number;
  now?: number;
}

const STORAGE_LABELS = {
  memory: "memory (process-local)",
  session: "session file (isolated by session ID)",
  project: "project file (shared; no scheduler owner election)",
  custom: "custom file (PI_LOOP override)",
} satisfies Record<LoopStorageScope, string>;

export function canResumeFromInspection(entry: LoopEntry, now = Date.now()): boolean {
  if (entry.status !== "paused" || now >= entry.expiresAt || entry.orchestration || isTerminalWorkflowRun(entry.workflow)) return false;
  return !(entry.pause?.kind === "controller_limit"
    && (atMaxFires(entry) || Boolean(entry.workflow && atWorkflowStateFireLimit(entry.workflow))));
}

function controllerKind(entry: LoopEntry): string {
  if (entry.workflow) return "workflow";
  if (entry.orchestration) return "orchestration";
  if (entry.taskBacklog) return "task-backlog loop";
  if (entry.trigger.type === "dynamic") return "dynamic loop";
  if (entry.trigger.type === "cron") return "scheduled loop";
  return `${entry.trigger.type} loop`;
}

function controllerAuthority(entry: LoopEntry): string {
  if (entry.workflow) return "LoopStore (embedded workflow work; not TaskStore)";
  if (entry.orchestration) return "LoopStore intent; pi-subagents execution";
  if (entry.autoTask || entry.taskBacklog) return "LoopStore scheduling; standalone task provider work";
  return "LoopStore";
}

function nextAction(entry: LoopEntry, now: number): string {
  if (now >= entry.expiresAt) return "Inspect retained work; expired controllers cannot resume. Recreate only if authorized.";
  if (entry.orchestration) return "Inspect OrchestrationGet before cancellation or deletion; do not replay uncertain work or use generic resume.";
  if (isTerminalWorkflowRun(entry.workflow)) return "Inspect the terminal outcome; do not resume.";
  if (entry.status === "paused") {
    if (!canResumeFromInspection(entry, now)) {
      if (entry.workflow && !atMaxFires(entry) && atWorkflowStateFireLimit(entry.workflow)) {
        return "Inspect LoopList outcomes; leave the exhausted state with an evidenced transition, not resume.";
      }
      return entry.workflow
        ? "Inspect available terminal outcomes with LoopList; do not resume or retry the same state."
        : "Inspect the fire budget; do not resume an exhausted controller.";
    }
    return "Resume explicitly when authorized; inspection does not resume work.";
  }
  if (entry.workflow?.waitingMonitor) return "Inspect MonitorList; wait for the terminal outcome, do not re-run the command.";
  if (entry.workflow) {
    const execution = entry.workflow.activeExecution;
    if (execution?.status === "active") {
      return execution.lease && execution.lease.expiresAt > now
        ? "Respect the live lease; inspect outcomes with LoopList. A claim is not proof of execution."
        : "Claim current work with WorkflowClaim before execution.";
    }
    return "Inspect available outcomes with LoopList; transition only with evidence.";
  }
  if (entry.dynamic?.awaitingUpdate) return "Persist progress with LoopUpdate; use continue while work remains.";
  if (entry.trigger.type === "event") return "Await the declared event; registration is not proof of wake delivery.";
  return "Observe the next fire; wakes deliver when Pi is idle.";
}

export function formatLoopLifecycle(entry: LoopEntry, context: LifecycleInspectionContext = {}): string[] {
  const now = context.now ?? Date.now();
  const cadence = entry.workflow && getActiveWorkflowStateLoop(entry.workflow);
  const trigger = cadence ? `workflow cron: ${cadence.schedule}` : formatTrigger(entry.trigger, "command");
  const nextDate = context.nextFireAt === undefined ? undefined : new Date(context.nextFireAt);
  const nextFire = nextDate && Number.isFinite(nextDate.getTime()) ? nextDate.toISOString() : "not reported";
  const lines = [
    `Kind: ${controllerKind(entry)} · status: ${entry.status}`,
    `Storage: ${context.storageScope ? STORAGE_LABELS[context.storageScope] : "unknown (inspection context unavailable)"}`,
    `Authority: ${controllerAuthority(entry)}`,
    `Trigger: ${trigger}`,
    `Expires at: ${new Date(entry.expiresAt).toISOString()}${now >= entry.expiresAt ? " (expired)" : ""}`,
    `Next fire: ${nextFire}`,
    `Fires: ${entry.fireCount ?? 0}/${entry.maxFires ?? "unbounded"} (accounted, not delivered wakes)`,
  ];
  if (entry.trigger.type === "hybrid") {
    lines.push(`Hybrid event: ${entry.trigger.event.source} · debounce: ${entry.trigger.debounceMs}ms`);
  }
  if (cadence) lines.push(`State fires: ${entry.workflow?.stateFireCounts?.[entry.workflow.currentState] ?? 0}/${cadence.maxFires ?? "unbounded"}`);
  if (entry.status === "paused") lines.push(`Pause: ${entry.pause?.kind ?? "legacy (unattributed)"}`);
  lines.push(`Next action: ${nextAction(entry, now)}`);
  return lines;
}
