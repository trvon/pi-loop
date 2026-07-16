import { describe, expect, it } from "vitest";
import { cronToNextFire, isValidCronExpression, parseInterval } from "../src/loop-parse.js";

describe("parseInterval", () => {
  describe("human-readable intervals", () => {
    it("parses 5m", () => {
      const result = parseInterval("5m");
      expect(result.cron).toBe("*/5 * * * *");
      expect(result.description).toBe("5 minutes");
    });

    it("parses 10m", () => {
      const result = parseInterval("10m");
      expect(result.cron).toBe("*/10 * * * *");
    });

    it("parses 15m", () => {
      const result = parseInterval("15m");
      expect(result.cron).toBe("*/15 * * * *");
    });

    it("parses 30m", () => {
      const result = parseInterval("30m");
      expect(result.cron).toBe("*/30 * * * *");
    });

    it("parses 1h", () => {
      const result = parseInterval("1h");
      expect(result.cron).toBe("0 * * * *");
      expect(result.description).toBe("1 hour");
    });

    it("parses 2h", () => {
      const result = parseInterval("2h");
      expect(result.cron).toBe("0 */2 * * *");
    });

    it("parses 1d", () => {
      const result = parseInterval("1d");
      expect(result.cron).toBe("0 0 * * *");
      expect(result.description).toBe("1 day");
    });

    it("parses with spaces", () => {
      const result = parseInterval(" 5 m ");
      expect(result.cron).toBe("*/5 * * * *");
    });

    it("parses uppercase units", () => {
      const result = parseInterval("5M");
      expect(result.cron).toBe("*/5 * * * *");
    });

    it("rounds 3m to nearest common interval", () => {
      const result = parseInterval("3m");
      expect(result.cron).toBe("*/2 * * * *");
    });

    it("rounds 7m to nearest common interval", () => {
      const result = parseInterval("7m");
      expect(result.cron).toBe("*/5 * * * *");
    });

    it("rounds 90m to nearest common interval", () => {
      const result = parseInterval("90m");
      expect(result.cron).toBe("0 * * * *");
    });

    it("handles seconds (rounds to 1m)", () => {
      const result = parseInterval("30s");
      expect(result.cron).toBe("*/1 * * * *");
      expect(result.description).toContain("seconds");
    });

    it("throws on invalid format", () => {
      expect(() => parseInterval("five minutes")).toThrow();
    });

    it("throws on empty string", () => {
      expect(() => parseInterval("")).toThrow();
    });
  });

  describe("full cron expressions", () => {
    it("passes through valid 5-field cron", () => {
      const result = parseInterval("0 9 * * 1-5");
      expect(result.cron).toBe("0 9 * * 1-5");
      expect(result.description).toContain("cron:");
    });

    it("passes through step expressions", () => {
      const result = parseInterval("*/15 * * * *");
      expect(result.cron).toBe("*/15 * * * *");
    });

    it("passes through specific time", () => {
      const result = parseInterval("30 14 15 3 *");
      expect(result.cron).toBe("30 14 15 3 *");
    });

    it("rejects out-of-range fields", () => {
      expect(() => parseInterval("99 * * * *")).toThrow("Invalid cron expression");
      expect(() => parseInterval("0 24 * * *")).toThrow("Invalid cron expression");
      expect(() => parseInterval("0 0 0 * *")).toThrow("Invalid cron expression");
    });

    it("recognizes supported cron syntax without accepting prose", () => {
      expect(isValidCronExpression("0 9 * * 1-5")).toBe(true);
      expect(isValidCronExpression("*/15 * * * *")).toBe(true);
      expect(isValidCronExpression("2026 release must ship by")).toBe(false);
      expect(isValidCronExpression("99 * * * *")).toBe(false);
      expect(isValidCronExpression("5/10 * * * *")).toBe(false);
    });
  });
});

describe("cronToNextFire", () => {
  it("finds next fire for every-5-minutes", () => {
    const from = new Date("2026-01-01T12:01:00");
    const next = cronToNextFire("*/5 * * * *", from);
    expect(next.getMinutes() % 5).toBe(0);
    expect(next.getTime()).toBeGreaterThan(from.getTime());
  });

  it("finds next fire for hourly", () => {
    const from = new Date("2026-01-01T12:01:00");
    const next = cronToNextFire("0 * * * *", from);
    expect(next.getMinutes()).toBe(0);
    expect(next.getHours()).toBe(13);
  });

  it("finds next fire for daily 9am", () => {
    const from = new Date("2026-01-01T08:00:00");
    const next = cronToNextFire("0 9 * * *", from);
    expect(next.getHours()).toBe(9);
    expect(next.getMinutes()).toBe(0);
  });

  it("finds next fire for specific minute past hour", () => {
    const from = new Date("2026-01-01T12:00:00");
    const next = cronToNextFire("7 * * * *", from);
    expect(next.getMinutes()).toBe(7);
  });

  it("finds next fire when already past the minute", () => {
    const from = new Date("2026-01-01T12:08:00");
    const next = cronToNextFire("7 * * * *", from);
    expect(next.getMinutes()).toBe(7);
    expect(next.getHours()).toBe(13);
  });

  it("finds next fire for weekday schedule", () => {
    const from = new Date("2026-01-05T08:00:00");
    const next = cronToNextFire("0 9 * * 1-5", from);
    expect(next.getHours()).toBe(9);
  });

  it("handles comma-separated minutes", () => {
    const from = new Date("2026-01-01T12:01:00");
    const next = cronToNextFire("0,15,30,45 * * * *", from);
    expect([0, 15, 30, 45]).toContain(next.getMinutes());
  });

  it("handles range in field", () => {
    const from = new Date("2026-01-01T00:00:00");
    const next = cronToNextFire("0 9-17 * * *", from);
    expect(next.getHours()).toBeGreaterThanOrEqual(9);
    expect(next.getHours()).toBeLessThanOrEqual(17);
  });

  it("returns a Date object", () => {
    const next = cronToNextFire("0 0 * * *");
    expect(next).toBeInstanceOf(Date);
  });

  it("throws on invalid cron", () => {
    expect(() => cronToNextFire("* * *")).toThrow();
  });
});
