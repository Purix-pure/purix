// packages/core/src/recovery/heal_config.ts
//
// AI-12 (PURIX-33): the one switch the repair loops read. Reads the environment through platform/env.ts (single-point rule R4).
import { purixEnv } from "../platform/env.js";

/**
 * PURIX_HEAL_EARLY_STOP: when on, the repair loop stops as soon as a round fails with the same error class at the same file and
 * line as the round before it, instead of spending the remaining rounds. Off unless set to 1, true, on or yes. It stays off
 * until AI-16 has call-record data on how often a third round rescues a patch (PURIX-33, section on AI-16).
 */
export function healEarlyStopEnabled(): boolean {
  const v = purixEnv("PURIX_HEAL_EARLY_STOP");
  return v !== undefined && ["1", "true", "on", "yes"].includes(v.trim().toLowerCase());
}
