/// <reference types="node" />

// Vitest 5 removed the built-in benchmark table, `--outputJson`, and `--compare`.
// `bench.compare()` now only runs the registrations and hands back their raw
// statistics; formatting, baselines, and comparison are the caller's job. These
// pure helpers keep that logic out of the `.bench.ts` file so it can be tested.

// Minimal shape of the tinybench statistics we consume; kept local so the
// helpers do not couple to vitest's evolving benchmark types.
export interface BenchStatistics {
  mean: number;
  rme: number;
}

export interface BenchResultLike {
  latency: BenchStatistics;
  throughput: BenchStatistics;
}

export interface RecordedBenchmark {
  name: string;
  /** Mean wall-clock latency per operation, in milliseconds. */
  latencyMeanMs: number;
  /** Mean throughput, in operations per second. */
  throughputMean: number;
  /** Relative margin of error on latency, as a percentage. */
  rme: number;
}

export interface BenchmarkBaseline {
  schemaVersion: 1;
  createdAt: string;
  node: string;
  arch: string;
  platform: string;
  timezone: string;
  benchmarks: Record<string, RecordedBenchmark>;
}

export function recordBenchmark(name: string, result: BenchResultLike): RecordedBenchmark {
  return {
    name,
    latencyMeanMs: result.latency.mean,
    throughputMean: result.throughput.mean,
    rme: result.latency.rme,
  };
}

function padEnd(value: string, width: number): string {
  return value.length >= width ? value : value + " ".repeat(width - value.length);
}

function padStart(value: string, width: number): string {
  return value.length >= width ? value : " ".repeat(width - value.length) + value;
}

function formatNumber(value: number, fractionDigits: number): string {
  if (!Number.isFinite(value)) return "n/a";
  return value.toLocaleString("en-US", {
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

export function formatTable(records: RecordedBenchmark[]): string {
  const header = ["name", "ops/sec", "mean ms", "±rme"];
  const rows = records.map((record) => [
    record.name,
    formatNumber(record.throughputMean, 0),
    formatNumber(record.latencyMeanMs, 4),
    `±${formatNumber(record.rme, 2)}%`,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column]!.length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) => (column === 0 ? padEnd(cell, widths[column]!) : padStart(cell, widths[column]!)))
      .join("  ");
  return [render(header), render(widths.map((width) => "-".repeat(width))), ...rows.map(render)].join("\n");
}

export interface ComparisonRow {
  name: string;
  current: RecordedBenchmark;
  baseline?: RecordedBenchmark;
  /** Signed percentage change in throughput vs. baseline; positive is faster. */
  throughputDeltaPct?: number;
}

export function compareToBaseline(
  current: RecordedBenchmark[],
  baseline: BenchmarkBaseline,
): ComparisonRow[] {
  return current.map((record) => {
    const previous = baseline.benchmarks[record.name];
    if (!previous || previous.throughputMean === 0) {
      return { name: record.name, current: record, baseline: previous };
    }
    const throughputDeltaPct =
      ((record.throughputMean - previous.throughputMean) / previous.throughputMean) * 100;
    return { name: record.name, current: record, baseline: previous, throughputDeltaPct };
  });
}

export function formatComparison(rows: ComparisonRow[]): string {
  const header = ["name", "ops/sec", "baseline", "change"];
  const body = rows.map((row) => [
    row.name,
    formatNumber(row.current.throughputMean, 0),
    row.baseline ? formatNumber(row.baseline.throughputMean, 0) : "new",
    row.throughputDeltaPct === undefined
      ? "—"
      : `${row.throughputDeltaPct >= 0 ? "+" : ""}${formatNumber(row.throughputDeltaPct, 2)}%`,
  ]);
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...body.map((cells) => cells[column]!.length)),
  );
  const render = (cells: string[]) =>
    cells
      .map((cell, column) => (column === 0 ? padEnd(cell, widths[column]!) : padStart(cell, widths[column]!)))
      .join("  ");
  return [render(header), render(widths.map((width) => "-".repeat(width))), ...body.map(render)].join("\n");
}

export function buildBaseline(
  records: RecordedBenchmark[],
  meta: Pick<BenchmarkBaseline, "node" | "arch" | "platform" | "timezone"> & { createdAt?: string },
): BenchmarkBaseline {
  return {
    schemaVersion: 1,
    createdAt: meta.createdAt ?? new Date().toISOString(),
    node: meta.node,
    arch: meta.arch,
    platform: meta.platform,
    timezone: meta.timezone,
    benchmarks: Object.fromEntries(records.map((record) => [record.name, record])),
  };
}
