import { describe, expect, it } from "vitest";
import {
  DEFAULT_LOOP_EXPIRY_MS,
  expiresAtFromDuration,
  parseLoopDurationMs,
  resolveDefaultLoopExpiryMs,
} from "../src/loop-expiry.js";

describe("loop expiry configuration", () => {
  it("preserves the seven-day default", () => {
    expect(resolveDefaultLoopExpiryMs(undefined, 100)).toBe(DEFAULT_LOOP_EXPIRY_MS);
  });

  it.each([
    ["30s", 30_000],
    ["30m", 1_800_000],
    ["12H", 43_200_000],
    ["14d", 1_209_600_000],
  ])("parses %s", (input, expected) => {
    expect(parseLoopDurationMs(input)).toBe(expected);
  });

  it.each(["", "0s", "-1d", "1.5h", "1w", "forever", "999999999999999999999d"])(
    "rejects invalid duration %s",
    (input) => {
      expect(() => parseLoopDurationMs(input)).toThrow(`Invalid loop expiration "${input}"`);
    },
  );

  it("rejects deadlines outside the JavaScript date range", () => {
    const duration = parseLoopDurationMs("99999999d");
    expect(() => expiresAtFromDuration(1_000_000_000_000, duration)).toThrow("valid date range");
    expect(() => resolveDefaultLoopExpiryMs("99999999d", 1_000_000_000_000)).toThrow("PI_LOOP_EXPIRES_IN");
  });
});
