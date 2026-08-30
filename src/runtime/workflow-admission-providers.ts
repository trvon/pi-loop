import type { MonitorEntry } from "../types.js";
import type { WorkflowAdmissionProvider, WorkflowFactValue } from "../workflow-admission.js";

const OBSERVATION_TTL_MS = 5_000;

function monitorFact(entry: MonitorEntry, fact: string): WorkflowFactValue | undefined {
  if (fact === "status") return entry.status;
  if (fact === "exitCode") return entry.exitCode ?? null;
  if (fact === "stopReason") return entry.stopReason ?? null;
  return undefined;
}

export function createMonitorWorkflowAdmissionProvider(
  getMonitor: (id: string) => MonitorEntry | undefined,
): WorkflowAdmissionProvider {
  return {
    id: "monitor",
    sourceClass: "environmental",
    async observe({ claim, context, now }) {
      const entry = getMonitor(claim.subject);
      const actual = entry && monitorFact(entry, claim.fact);
      return [{
        fact: claim.fact,
        actual: actual ?? null,
        sourceClass: "environmental",
        provider: "monitor",
        providerVersion: "1",
        observedAt: now,
        expiresAt: now + OBSERVATION_TTL_MS,
        context,
        status: entry && actual !== undefined ? "observed" : "abstained",
      }];
    },
  };
}
