// packages/core/src/cli-io/gated-confirm.ts (moved into core alongside confirm.ts/notify.ts — every command module in packages/cli still imports confirmGated from here, which is fine: cli importing from core is allowed, only core importing from cli/api is forbidden)
import { confirm } from "./confirm.js";
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
  const approved = await confirm(message);
  recordEvent("confirm_response", { component_id: componentId, detail: { checkpoint_kind: checkpointKind, approved } });
  return approved;
}