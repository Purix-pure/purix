// packages/core/src/usage/schema.ts
//
// Closed schema for Purix usage data (Purix 4, section 6). Every field is an
// enum, a count or a bucket. There is no free-text field: `dimension` must
// match a tight pattern (lowercase letters, digits and . _ : -), so a path,
// a prompt, a sentence or source code cannot pass validation. ADR-001 stays
// true by construction, and a test pins it.

export const USAGE_EVENTS = [
  "command_run", // dimension: <command>:<exit word>:<duration bucket>
  "step_reached", // dimension: install | connect | first_change | first_check_pass | return_day_two
  "gate_decision", // dimension: <gate id>:<decision>
  "tool_decision", // dimension: <tool id>:<approved|denied>
  "error_code", // dimension: <error code>
] as const;
export type UsageEventName = (typeof USAGE_EVENTS)[number];

export const DURATION_BUCKETS = ["lt_1s", "1_5s", "5_30s", "30s_2m", "gt_2m"] as const;
export type DurationBucket = (typeof DURATION_BUCKETS)[number];

export function durationBucket(ms: number): DurationBucket {
  if (!(ms >= 0)) return "lt_1s";
  if (ms < 1_000) return "lt_1s";
  if (ms < 5_000) return "1_5s";
  if (ms < 30_000) return "5_30s";
  if (ms < 120_000) return "30s_2m";
  return "gt_2m";
}

export interface UsageEvent {
  /** UTC calendar day, YYYY-MM-DD. No time of day, to keep the record coarse. */
  day: string;
  event: UsageEventName;
  dimension: string;
  count: number;
}

export const DIMENSION_PATTERN = /^[a-z0-9_.:-]{0,48}$/;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const MAX_COUNT = 100_000;

export type Validation = { ok: true; event: UsageEvent } | { ok: false; reason: string };

export function validateUsageEvent(input: unknown): Validation {
  if (typeof input !== "object" || input === null) return { ok: false, reason: "not an object" };
  const rec = input as Record<string, unknown>;
  const allowed = new Set(["day", "event", "dimension", "count"]);
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) return { ok: false, reason: `unknown field: ${key}` };
  }
  if (typeof rec.day !== "string" || !DAY_PATTERN.test(rec.day)) return { ok: false, reason: "bad day" };
  if (typeof rec.event !== "string" || !(USAGE_EVENTS as readonly string[]).includes(rec.event)) {
    return { ok: false, reason: "unknown event" };
  }
  if (typeof rec.dimension !== "string" || !DIMENSION_PATTERN.test(rec.dimension)) {
    return { ok: false, reason: "dimension is not a closed token" };
  }
  if (typeof rec.count !== "number" || !Number.isInteger(rec.count) || rec.count < 0 || rec.count > MAX_COUNT) {
    return { ok: false, reason: "count out of range" };
  }
  return {
    ok: true,
    event: { day: rec.day, event: rec.event as UsageEventName, dimension: rec.dimension, count: rec.count },
  };
}
