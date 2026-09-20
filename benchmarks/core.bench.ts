/// <reference types="node" />

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { arch } from "node:os";
import { dirname, resolve } from "node:path";
import { describe, test } from "vitest";
import {
  type BenchmarkBaseline,
  buildBaseline,
  compareToBaseline,
  formatComparison,
  formatTable,
  recordBenchmark,
} from "./report.js";
import { coreWorkloads } from "./workloads.js";

// Vitest 5 moved timing from the per-`bench()` options to the run options; the
// values mirror the pre-5.0 defaults so historical baselines stay comparable.
const runOptions = { time: 750, warmupTime: 250 };

// Vitest 5 dropped the `--outputJson`/`--compare` CLI flags; baseline and
// comparison are selected through env vars set by the npm scripts.
const baselineOut = process.env.BENCH_BASELINE_OUT;
const baselineIn = process.env.BENCH_BASELINE_IN;

describe("core workloads", () => {
  test("core", async ({ bench }) => {
    const records = [];
    for (const [name, workload] of Object.entries(coreWorkloads)) {
      const result = await bench(name, () => {
        workload();
      }).run(runOptions);
      records.push(recordBenchmark(name, result));
    }

    if (baselineIn) {
      const baseline = JSON.parse(readFileSync(resolve(baselineIn), "utf8")) as BenchmarkBaseline;
      process.stdout.write(`\n${formatComparison(compareToBaseline(records, baseline))}\n`);
      return;
    }

    process.stdout.write(`\n${formatTable(records)}\n`);

    if (baselineOut) {
      const path = resolve(baselineOut);
      mkdirSync(dirname(path), { recursive: true });
      const baseline = buildBaseline(records, {
        node: process.version,
        arch: arch(),
        platform: process.platform,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      });
      writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`);
      process.stdout.write(`\nbaseline written to ${baselineOut}\n`);
    }
  });
});
