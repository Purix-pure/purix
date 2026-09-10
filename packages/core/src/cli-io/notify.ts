// packages/core/src/cli-io/notify.ts (moved for the same reason as confirm.ts — gated-confirm.ts, its only importer, must stay in core)
//
// Signature Scheme (Webhook Verification):
// Outbound requests include an `X-Signature` header matching the pattern used for
// inbound Lemon Squeezy webhook verification in lemonsqueezy_webhook.ts (HMAC-SHA256 hex digest).

import { createHmac } from "node:crypto";
import { getSecret } from "../security/secrets_manager.js";

function getWebhookSecret(): string {
  const envSecret = process.env.PURIX_WEBHOOK_SECRET;
  if (envSecret) return envSecret;
  try {
    const stored = getSecret("purix_webhook_secret");
    if (stored) return stored;
  } catch {}
  return "dev-webhook-secret";
}

async function fetchWithRetry(url: string, init: RequestInit, retries = 1, backoffMs = 1000): Promise<Response> {
  try {
    const res = await fetch(url, init);
    if (!res.ok) throw new Error(`HTTP error ${res.status}`);
    return res;
  } catch (err) {
    if (retries <= 0) throw err;
    await new Promise((resolve) => setTimeout(resolve, backoffMs));
    return fetchWithRetry(url, init, retries - 1, backoffMs);
  }
}

/**
 * Section 23: "a minimum webhook or notification hook... required in v1
 * alongside the confirmation-gating design in Section 20." A CLI-only
 * interface has nowhere for a gated request to surface unless someone's
 * staring at the terminal — this is the minimum viable fix, not the
 * full dashboard deferred to Phase 2.
 *
 * Fire-and-forget, same discipline as manifest/events.ts: a failed
 * notification must never block or fail the confirmation it's
 * announcing. Silent no-op if PURIX_WEBHOOK_URL isn't set.
 */
export async function notifyGatedConfirmation(
  message: string,
  checkpointKind: string,
  componentId: string | null
): Promise<void> {
  const url = process.env.PURIX_WEBHOOK_URL;
  if (!url) return;

  // Pro-gated (see licensing/tier.ts). Deliberately fails silent rather than
  // throwing: this function's whole contract is "never block the checkpoint
  // it's announcing," and a Free-tier user setting PURIX_WEBHOOK_URL without
  // Pro shouldn't get a confusing crash in the middle of a gated confirmation.
  try {
    const { getEntitlements } = await import("../licensing/tier.js");
    if (!getEntitlements().webhooks) {
      console.warn(`  [notify] webhook delivery is a Pro feature — skipping (tier-status for details)`);
      return;
    }
  } catch {
    return;
  }

  try {
    const bodyObj = {
      event: "purix.confirmation_pending",
      checkpoint_kind: checkpointKind,
      component_id: componentId,
      message,
      timestamp: new Date().toISOString(),
    };
    const bodyStr = JSON.stringify(bodyObj);
    const secret = getWebhookSecret();
    const signature = createHmac("sha256", secret).update(bodyStr).digest("hex");

    await fetchWithRetry(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Signature": signature,
      },
      body: bodyStr,
      signal: AbortSignal.timeout(3000),
    }, 1, 1000);
  } catch (err) {
    console.warn(`  [notify] webhook call failed (non-fatal): ${err instanceof Error ? err.message : err}`);
  }
}
