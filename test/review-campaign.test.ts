import { describe, expect, it } from "vitest";
import { evaluateReviewCampaign, type ReviewEvidence, type ReviewPolicy } from "./helpers/review-campaign.js";

const policy: ReviewPolicy = { snapshot: "tree:one", partitions: ["authority", "delivery"], maxCalls: 12, maxRepairBatches: 2 };
function complete(): ReviewEvidence {
  return {
    calls: 4, repairBatches: 0,
    partitions: policy.partitions.map((id) => ({ id, snapshot: policy.snapshot, outcome: "ok" })),
    findings: [], gatesPassed: true, closurePassed: true, workersQuiesced: true,
  };
}
const finding = (verdict: "confirmed" | "refuted" | "unresolved") => ({ key: "fire-identity", snapshot: policy.snapshot, verdict });

describe("bounded review campaign reference policy", () => {
  it("accepts complete final-snapshot evidence without mutating inputs", () => {
    const evidence = complete();
    const before = structuredClone({ policy, evidence });
    expect(evaluateReviewCampaign(policy, evidence)).toEqual({ status: "clean", reasons: [], blockers: [] });
    expect({ policy, evidence }).toEqual(before);
  });

  it.each(["failed", "skipped"] as const)("does not convert all-%s discovery to a dry success", (outcome) => {
    const evidence = complete();
    evidence.partitions = evidence.partitions.map((p) => ({ ...p, outcome }));
    expect(evaluateReviewCampaign(policy, evidence).status).toBe("incomplete");
    // Counterexample to filtering null worker results before counting a dry round.
    expect([null, null].filter(Boolean)).toEqual([]);
  });

  it.each(["missing", "duplicate", "stale", "undeclared"])("rejects %s partition evidence", (kind) => {
    const evidence = complete();
    if (kind === "missing") evidence.partitions = evidence.partitions.slice(1);
    if (kind === "duplicate") evidence.partitions = [...evidence.partitions, evidence.partitions[0]!];
    if (kind === "stale") evidence.partitions = evidence.partitions.map((p) => ({ ...p, snapshot: "tree:old" }));
    if (kind === "undeclared") evidence.partitions = [...evidence.partitions, { id: "extra", snapshot: policy.snapshot, outcome: "ok" }];
    expect(evaluateReviewCampaign(policy, evidence).status).toBe("incomplete");
  });

  it("keeps uncertain and contradictory verification unresolved", () => {
    for (const findings of [[finding("unresolved")], [finding("confirmed"), finding("refuted")]]) {
      expect(evaluateReviewCampaign(policy, { ...complete(), findings }).status).toBe("incomplete");
    }
  });

  it("deduplicates repeated confirmed findings without erasing their blocker", () => {
    expect(evaluateReviewCampaign(policy, { ...complete(), findings: [finding("confirmed"), finding("confirmed")] }))
      .toEqual({ status: "repair", reasons: [], blockers: ["fire-identity"] });
  });

  it("retains refutation only for the reviewed snapshot", () => {
    const evidence = { ...complete(), findings: [finding("refuted"), finding("refuted")] };
    expect(evaluateReviewCampaign(policy, evidence).status).toBe("clean");
    expect(evaluateReviewCampaign({ ...policy, snapshot: "tree:two" }, evidence).status).toBe("incomplete");
  });

  it.each(["calls", "repairBatches"] as const)("stops novel findings at the %s boundary", (field) => {
    const evidence = { ...complete(), findings: [finding("confirmed")] };
    evidence[field] = field === "calls" ? policy.maxCalls : policy.maxRepairBatches;
    expect(evaluateReviewCampaign(policy, evidence)).toMatchObject({ status: "incomplete", reasons: ["repair budget exhausted"] });
  });

  it.each(["gatesPassed", "closurePassed", "workersQuiesced"] as const)("requires %s for clean closure", (field) => {
    expect(evaluateReviewCampaign(policy, { ...complete(), [field]: false }).status).toBe("incomplete");
  });

  it.each([-1, Number.NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid accounting %s", (calls) => {
    expect(evaluateReviewCampaign(policy, { ...complete(), calls }).status).toBe("incomplete");
  });

  it("cannot renew the frozen campaign budget with a new snapshot", () => {
    expect(evaluateReviewCampaign({ ...policy, snapshot: "tree:two" }, {
      ...complete(), calls: policy.maxCalls + 1, partitions: policy.partitions.map((id) => ({ id, snapshot: "tree:two", outcome: "ok" })),
    }).status).toBe("incomplete");
  });

  it.each([{ ...policy, partitions: [] }, { ...policy, partitions: ["authority", "authority"] }, { ...policy, maxCalls: 0 }])(
    "rejects vacuous or invalid coverage policy %#", (invalid) => {
      expect(evaluateReviewCampaign(invalid, complete()).status).toBe("incomplete");
    },
  );
});
