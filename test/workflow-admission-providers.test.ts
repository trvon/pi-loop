import { describe, expect, it } from "vitest";
import { createMonitorWorkflowAdmissionProvider } from "../src/runtime/workflow-admission-providers.js";
import type { MonitorEntry } from "../src/types.js";
import type { WorkflowAdmissionContext, WorkflowBlockerClaim } from "../src/workflow-admission.js";

const NOW = 1_800_000_000_000;
const context: WorkflowAdmissionContext = {
  workflowId: "1",
  currentState: "validate",
  transitionSeq: 0,
  definitionRevision: 1,
  contextDigest: "workspace-A",
};

function claim(fact: string): WorkflowBlockerClaim {
  return { class: "environmental", provider: "monitor", subject: "monitor-1", fact, expected: true };
}

function monitor(): MonitorEntry {
  return {
    id: "monitor-1",
    command: "npm test",
    timeout: 1_000,
    status: "error",
    startedAt: NOW - 100,
    completedAt: NOW,
    exitCode: 1,
    outputLines: 1,
    outputBuffer: ["secret output must not become admission evidence"],
  };
}

describe("monitor workflow admission provider", () => {
  it.each([
    ["status", "error"],
    ["exitCode", 1],
    ["stopReason", null],
  ])("exposes bounded %s facts", async (fact, expected) => {
    const provider = createMonitorWorkflowAdmissionProvider(() => monitor());

    const observations = await provider.observe({ claim: claim(fact), context, now: NOW });

    expect(observations).toEqual([expect.objectContaining({
      fact,
      actual: expected,
      provider: "monitor",
      providerVersion: "1",
      status: "observed",
      context,
    })]);
    expect(JSON.stringify(observations)).not.toContain("secret output");
  });

  it.each([
    ["missing monitor", () => undefined, "status"],
    ["unsupported fact", () => monitor(), "output"],
  ])("abstains for %s", async (_label, getMonitor, fact) => {
    const provider = createMonitorWorkflowAdmissionProvider(getMonitor);

    const observations = await provider.observe({ claim: claim(fact), context, now: NOW });

    expect(observations).toEqual([expect.objectContaining({ status: "abstained" })]);
  });
});
