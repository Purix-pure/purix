// packages/core/src/cli-io/gated-confirm.ts (moved into core alongside confirm.ts/notify.ts — every command module in packages/cli still imports confirmGated from here, which is fine: cli importing from core is allowed, only core importing from cli/api is forbidden)
import { confirm, isAutoConfirmActive } from "./confirm.js";
import { recordEvent } from "../manifest/events.js";
import { notifyGatedConfirmation } from "./notify.js";

/**
 * §7.5/§10: every checkpoint answer is exactly the raw material for the
 * "advisory acceptance rate" and "approval-response pattern" (approval-
 * fatigue) metrics. Wrapping confirm() here means every checkpoint gets
 * recorded the same way, once, rather than each call site remembering
 * to log it separately.
 *
 * Lives in its own module (not cli.ts) so every command module can import
 * it without a circular dependency back on cli.ts.
 */
export async function confirmGated(
  message: string,
  checkpointKind: string,
  componentId: string | null
): Promise<boolean> {
  await notifyGatedConfirmation(message, checkpointKind, componentId);
  // BUG FIX (GAPS-REPORT-2 §1): a real human "y" and an AUTO_CONFIRM=1
  // bypass used to write an identical event — read back later for an
  // incident review, a compliance audit, or the trust-scoring system
  // this event feed is meant to feed, the two were permanently
  // indistinguishable. Capture the bypass state before calling
  // confirm() (which consumes it) so it can be recorded alongside the
  // outcome, and warn loudly at the point it actually fires.
  const autoConfirmed = isAutoConfirmActive();
  if (autoConfirmed) {
    console.warn(
      `  ⚠ AUTO_CONFIRM active — "${checkpointKind}" checkpoint auto-approved with no human prompt (test-environment-only bypass; see confirm.ts)`
    );
  }
  const approved = await confirm(message);
  recordEvent("confirm_response", {
    component_id: componentId,
    detail: { checkpoint_kind: checkpointKind, approved, auto_confirmed: autoConfirmed },
  });
  return approved;
}