const UNIT_TO_CRON: Record<string, number> = {
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
};

const COMMON_INTERVALS: Record<number, string> = {
  60: "*/1 * * * *",
  120: "*/2 * * * *",
  300: "*/5 * * * *",
  600: "*/10 * * * *",
  900: "*/15 * * * *",
  1800: "*/30 * * * *",
  3600: "0 * * * *",
  7200: "0 */2 * * *",
  10800: "0 */3 * * *",
  14400: "0 */4 * * *",
  21600: "0 */6 * * *",
  28800: "0 */8 * * *",
  43200: "0 */12 * * *",
  86400: "0 0 * * *",
};

function roundToNearestCommon(seconds: number): { cron: string; description: string } {
  // COMMON_INTERVALS is a non-empty const table, so keys[0] and
  // COMMON_INTERVALS[best] below are true invariants, not runtime fallbacks.
  const keys = Object.keys(COMMON_INTERVALS).map(Number).sort((a, b) => a - b);
  let best = keys[0] as number;
  for (const k of keys) {
    if (Math.abs(k - seconds) < Math.abs(best - seconds)) best = k;
  }

  const mins = best / 60;
  let description: string;
  if (mins < 60) {
    description = `${mins} minute${mins !== 1 ? "s" : ""}`;
  } else {
    const hrs = mins / 60;
    if (hrs % 24 === 0) {
      const days = hrs / 24;
      description = `${days} day${days !== 1 ? "s" : ""}`;
    } else {
      description = `${hrs} hour${hrs !== 1 ? "s" : ""}`;
    }
  }

  return { cron: COMMON_INTERVALS[best] as string, description };
}

function isFullCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  return parts.length === 5;
}

function parseCronNumber(input: string, min: number, max: number): number | undefined {
  if (!/^\d+$/.test(input)) return undefined;
  const value = Number.parseInt(input, 10);
  return value >= min && value <= max ? value : undefined;
}

function isValidCronField(field: string, min: number, max: number): boolean {
  return field.split(",").every((part) => {
    const [base, step, extra] = part.split("/");
    if (extra !== undefined || base === undefined) return false;
    if (step !== undefined && (parseCronNumber(step, 1, max - min + 1) === undefined)) return false;
    if (base === "*") return true;

    const range = base.split("-");
    if (range.length === 1) return step === undefined && parseCronNumber(base, min, max) !== undefined;
    if (range.length !== 2) return false;

    const start = parseCronNumber(range[0] ?? "", min, max);
    const end = parseCronNumber(range[1] ?? "", min, max);
    return start !== undefined && end !== undefined && start <= end;
  });
}

export function isValidCronExpression(expr: string): boolean {
  const fields = expr.trim().split(/\s+/);
  if (fields.length !== 5) return false;

  const ranges = [
    [0, 59],
    [0, 23],
    [1, 31],
    [1, 12],
    [0, 6],
  ] as const;
  return fields.every((field, index) => {
    const range = ranges[index];
    return range !== undefined && isValidCronField(field, range[0], range[1]);
  });
}

export function parseInterval(input: string): { cron: string; description: string } {
  const trimmed = input.trim();

  if (isFullCron(trimmed)) {
    if (!isValidCronExpression(trimmed)) {
      throw new Error(`Invalid cron expression: ${trimmed}`);
    }
    return { cron: trimmed, description: `cron: ${trimmed}` };
  }

  const match = trimmed.match(/^(\d+)\s*(s|m|h|d)$/i);
  if (match) {
    const value = parseInt(match[1] ?? "", 10);
    const unit = (match[2] ?? "").toLowerCase();
    const totalSec = value * (UNIT_TO_CRON[unit] ?? 60);

    if (totalSec < 60) {
      return { cron: `*/1 * * * *`, description: `${totalSec} seconds (rounded to 1 minute)` };
    }

    return roundToNearestCommon(totalSec);
  }

  throw new Error(
    `Cannot parse interval "${input}". Use formats like "5m", "2h", "1d", or a full cron expression.`
  );
}

export function cronToNextFire(cronExpr: string, fromDate: Date = new Date()): Date {
  const parts = cronExpr.trim().split(/\s+/);
  if (!isValidCronExpression(cronExpr)) throw new Error(`Invalid cron expression: ${cronExpr}`);

  const [minF, hourF, dayF, monthF, dowF] = parts;
  if (
    minF === undefined ||
    hourF === undefined ||
    dayF === undefined ||
    monthF === undefined ||
    dowF === undefined
  ) {
    throw new Error(`Invalid cron expression: ${cronExpr}`);
  }
  const now = new Date(fromDate);
  now.setSeconds(0, 0);

  for (let minutesAdvanced = 1; minutesAdvanced < 525600; minutesAdvanced++) {
    now.setMinutes(now.getMinutes() + 1);

    if (!cronFieldMatches(minF, now.getMinutes())) continue;
    if (!cronFieldMatches(hourF, now.getHours())) continue;
    if (!cronFieldMatches(dayF, now.getDate())) continue;
    if (!cronFieldMatches(monthF, now.getMonth() + 1)) continue;
    if (!cronFieldMatches(dowF, now.getDay())) continue;

    return new Date(now);
  }

  throw new Error(`No matching time found for cron expression: ${cronExpr}`);
}

function cronFieldMatches(field: string, value: number): boolean {
  if (field === "*") return true;

  const parts = field.split(",");
  for (const part of parts) {
    if (part === "*") return true;

    if (part.includes("/")) {
      const [range = "", stepStr = ""] = part.split("/");
      const step = parseInt(stepStr, 10);
      let rangeMin: number;
      let rangeMax: number;

      if (range === "*") {
        rangeMin = 0;
        rangeMax = 59;
      } else if (range.includes("-")) {
        const [minS = "", maxS = ""] = range.split("-");
        rangeMin = parseInt(minS, 10);
        rangeMax = parseInt(maxS, 10);
      } else {
        continue;
      }

      let v = rangeMin;
      while (v <= rangeMax) {
        if (v === value) return true;
        v += step;
      }
      continue;
    }

    if (part.includes("-")) {
      const [minS = "", maxS = ""] = part.split("-");
      const min = parseInt(minS, 10);
      const max = parseInt(maxS, 10);
      if (value >= min && value <= max) return true;
      continue;
    }

    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

export function computeJitter(taskId: string, recurring: boolean, scheduleMinutes: number): number {
  let hash = 0;
  for (let i = 0; i < taskId.length; i++) {
    hash = ((hash << 5) - hash) + taskId.charCodeAt(i);
    hash |= 0;
  }
  const normalized = Math.abs(hash % 10000) / 10000;

  if (recurring && scheduleMinutes <= 30) {
    return Math.floor(normalized * (scheduleMinutes / 2) * 60 * 1000);
  }
  if (recurring) {
    return Math.floor(normalized * 30 * 60 * 1000);
  }
  return Math.floor(normalized * 90 * 1000);
}
