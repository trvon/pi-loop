// Reference policy for deterministic harness fixtures, not controller authority.
export interface ReviewPolicy {
  snapshot: string;
  partitions: readonly string[];
  maxCalls: number;
  maxRepairBatches: number;
}

export interface ReviewEvidence {
  calls: number;
  repairBatches: number;
  partitions: readonly {
    id: string;
    snapshot: string;
    outcome: "ok" | "failed" | "skipped";
  }[];
  findings: readonly {
    key: string;
    snapshot: string;
    verdict: "confirmed" | "refuted" | "unresolved";
  }[];
  gatesPassed: boolean;
  closurePassed: boolean;
  workersQuiesced: boolean;
}

export interface ReviewDecision {
  status: "clean" | "repair" | "incomplete";
  reasons: string[];
  blockers: string[];
}

export function evaluateReviewCampaign(policy: ReviewPolicy, evidence: ReviewEvidence): ReviewDecision {
  const reasons: string[] = [];
  if (!policy.snapshot || policy.partitions.length === 0
    || new Set(policy.partitions).size !== policy.partitions.length
    || policy.partitions.some((id) => !id)
    || !Number.isSafeInteger(policy.maxCalls) || policy.maxCalls < 1
    || !Number.isSafeInteger(policy.maxRepairBatches) || policy.maxRepairBatches < 0) {
    return { status: "incomplete", reasons: ["invalid policy"], blockers: [] };
  }
  if (!Number.isSafeInteger(evidence.calls) || evidence.calls < 0
    || !Number.isSafeInteger(evidence.repairBatches) || evidence.repairBatches < 0
    || evidence.calls > policy.maxCalls || evidence.repairBatches > policy.maxRepairBatches) {
    reasons.push("invalid or exceeded budget");
  }
  for (const id of policy.partitions) {
    const observations = evidence.partitions.filter((p) => p.id === id);
    if (observations.length !== 1 || observations[0]?.outcome !== "ok"
      || observations[0]?.snapshot !== policy.snapshot) reasons.push(`incomplete partition: ${id}`);
  }
  if (evidence.partitions.some((p) => !policy.partitions.includes(p.id))) reasons.push("undeclared partition");
  if (evidence.calls < evidence.partitions.length) reasons.push("unaccounted discovery calls");
  const blockers = new Set<string>();
  const verdicts = new Map<string, string>();
  for (const finding of evidence.findings) {
    if (!finding.key || finding.snapshot !== policy.snapshot) {
      reasons.push("unscoped or stale finding");
      continue;
    }
    const previous = verdicts.get(finding.key);
    if (previous && previous !== finding.verdict) reasons.push(`conflicting verdict: ${finding.key}`);
    verdicts.set(finding.key, finding.verdict);
    if (finding.verdict === "unresolved") reasons.push(`unresolved finding: ${finding.key}`);
    if (finding.verdict === "confirmed") blockers.add(finding.key);
  }
  if (!evidence.workersQuiesced) reasons.push("worker termination unproved");
  const sortedBlockers = [...blockers].sort();
  if (reasons.length) return { status: "incomplete", reasons: [...new Set(reasons)].sort(), blockers: sortedBlockers };
  if (sortedBlockers.length) {
    const exhausted = evidence.calls >= policy.maxCalls || evidence.repairBatches >= policy.maxRepairBatches;
    return { status: exhausted ? "incomplete" : "repair", reasons: exhausted ? ["repair budget exhausted"] : [], blockers: sortedBlockers };
  }
  if (!evidence.gatesPassed) reasons.push("final gates missing");
  if (!evidence.closurePassed) reasons.push("final closure missing");
  return { status: reasons.length ? "incomplete" : "clean", reasons, blockers: [] };
}
