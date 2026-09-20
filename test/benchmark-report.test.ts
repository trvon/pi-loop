import { describe, expect, it } from "vitest";
import {
  type BenchResultLike,
  buildBaseline,
  compareToBaseline,
  formatComparison,
  formatTable,
  recordBenchmark,
} from "../benchmarks/report.js";

function result(latencyMean: number, throughputMean: number, rme = 1.5): BenchResultLike {
  return {
    latency: { mean: latencyMean, rme },
    throughput: { mean: throughputMean, rme },
  };
}

describe("benchmark report helpers", () => {
  it("records the fields we report from a raw benchmark result", () => {
    const record = recordBenchmark("cron", result(0.5, 2000, 2.25));
    expect(record).toEqual({
      name: "cron",
      latencyMeanMs: 0.5,
      throughputMean: 2000,
      rme: 2.25,
    });
  });

  it("computes signed throughput deltas against a baseline", () => {
    const baseline = buildBaseline([recordBenchmark("cron", result(1, 1000))], {
      node: "v26.0.0",
      arch: "arm64",
      platform: "darwin",
      timezone: "UTC",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    const rows = compareToBaseline([recordBenchmark("cron", result(0.8, 1250))], baseline);
    expect(rows[0]!.throughputDeltaPct).toBeCloseTo(25, 6);
  });

  it("marks a benchmark absent from the baseline as new without a delta", () => {
    const baseline = buildBaseline([], {
      node: "v26.0.0",
      arch: "arm64",
      platform: "darwin",
      timezone: "UTC",
    });
    const rows = compareToBaseline([recordBenchmark("added", result(1, 1000))], baseline);
    expect(rows[0]!.throughputDeltaPct).toBeUndefined();
    expect(rows[0]!.baseline).toBeUndefined();
    expect(formatComparison(rows)).toContain("new");
  });

  it("does not divide by a zero-throughput baseline", () => {
    const baseline = buildBaseline([recordBenchmark("stalled", result(0, 0))], {
      node: "v26.0.0",
      arch: "arm64",
      platform: "darwin",
      timezone: "UTC",
    });
    const rows = compareToBaseline([recordBenchmark("stalled", result(1, 1000))], baseline);
    expect(rows[0]!.throughputDeltaPct).toBeUndefined();
  });

  it("renders a table with a header and one row per benchmark", () => {
    const table = formatTable([
      recordBenchmark("cron", result(0.5, 2000)),
      recordBenchmark("workflow", result(0.1, 10_000)),
    ]);
    const lines = table.split("\n");
    expect(lines[0]).toContain("ops/sec");
    expect(lines).toHaveLength(4); // header, divider, two rows
    expect(table).toContain("cron");
    expect(table).toContain("workflow");
  });
});
