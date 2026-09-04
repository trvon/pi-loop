export const DEFAULT_LOOP_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DATE_MS = 8_640_000_000_000_000;

export function parseLoopDurationMs(input: string): number {
  const match = input.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
  const value = match ? Number(match[1]) : Number.NaN;
  const unit = match?.[2]?.toLowerCase();
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  const durationMs = value * multiplier;
  if (!match || !Number.isSafeInteger(durationMs) || durationMs <= 0) {
    throw new Error(`Invalid loop expiration "${input}". Use a positive integer followed by s, m, h, or d.`);
  }
  return durationMs;
}

export function expiresAtFromDuration(now: number, durationMs: number): number {
  const expiresAt = now + durationMs;
  if (!Number.isSafeInteger(expiresAt) || expiresAt > MAX_DATE_MS) {
    throw new Error("Loop expiration exceeds the JavaScript valid date range.");
  }
  return expiresAt;
}

export function resolveDefaultLoopExpiryMs(input: string | undefined, now = Date.now()): number {
  if (input === undefined) return DEFAULT_LOOP_EXPIRY_MS;
  try {
    const durationMs = parseLoopDurationMs(input);
    expiresAtFromDuration(now, durationMs);
    return durationMs;
  } catch (error) {
    throw new Error(`Invalid PI_LOOP_EXPIRES_IN: ${(error as Error).message}`);
  }
}
