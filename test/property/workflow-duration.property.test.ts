import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { formatCompactWorkflowDuration } from "../../src/ui/workflow-presentation.js";
import { propertyOptions } from "./config.js";

const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;
const UNIT_LIMIT = { s: 60, m: 60, h: 24, d: Number.POSITIVE_INFINITY } as const;

function parse(label: string): { value: number; unit: keyof typeof UNIT_MS; ms: number } {
  const match = /^(\d+)([smhd])$/.exec(label);
  if (!match?.[1] || !match[2]) throw new Error(`unparseable duration label: ${label}`);
  const unit = match[2] as keyof typeof UNIT_MS;
  const value = Number(match[1]);
  return { value, unit, ms: value * UNIT_MS[unit] };
}

const duration = fc.oneof(
  fc.integer({ min: 0, max: 120_000 }),
  fc.integer({ min: 0, max: 400 * 86_400_000 }),
  // Unit boundaries are where rounding spills into the next unit.
  fc.constantFrom(60_000, 3_600_000, 86_400_000).chain((edge) => fc.integer({ min: edge - 1_000, max: edge + 1_000 })),
);

describe("compact workflow duration properties", () => {
  // Reproduced bug: rounding printed overflowed labels ("60s", "60m") and had no day unit ("168h").
  it("carries the minimized unit-boundary cases into the next unit", () => {
    expect(formatCompactWorkflowDuration(59_500)).toBe("1m");
    expect(formatCompactWorkflowDuration(3_570_000)).toBe("1h");
    expect(formatCompactWorkflowDuration(23.5 * 3_600_000)).toBe("1d");
    expect(formatCompactWorkflowDuration(7 * 86_400_000)).toBe("7d");
  });

  it("keeps nearest-unit rounding inside a unit (control)", () => {
    expect(formatCompactWorkflowDuration(0)).toBe("0s");
    expect(formatCompactWorkflowDuration(-5)).toBe("0s");
    expect(formatCompactWorkflowDuration(59_400)).toBe("59s");
    expect(formatCompactWorkflowDuration(90_000)).toBe("2m");
    expect(formatCompactWorkflowDuration(5_400_000)).toBe("2h");
  });

  it("never overflows a unit and stays within half a unit of elapsed time", () => {
    fc.assert(
      fc.property(duration, (ms) => {
        const parsed = parse(formatCompactWorkflowDuration(ms));
        expect(parsed.value).toBeLessThan(UNIT_LIMIT[parsed.unit]);
        expect(Math.abs(ms - parsed.ms)).toBeLessThanOrEqual(UNIT_MS[parsed.unit] / 2);
      }),
      propertyOptions(500),
    );
  });

  it("is monotonic in elapsed time", () => {
    fc.assert(
      fc.property(duration, duration, (a, b) => {
        const [low, high] = a <= b ? [a, b] : [b, a];
        expect(parse(formatCompactWorkflowDuration(low)).ms).toBeLessThanOrEqual(parse(formatCompactWorkflowDuration(high)).ms);
      }),
      propertyOptions(500),
    );
  });
});
