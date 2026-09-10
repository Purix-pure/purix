// src/state/drift.ts
import type { ManifestEntry } from "../manifest/schema.js";
import { readComponentFiles } from "../entrypoints/modify.js";
import { computeSyncHash } from "./hash.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { getDependents, reVerifyDependents } from "../verify/impact.js";
import { writeManifest } from "../manifest/store.js";
import { appendAuditRecord } from "../security/audit_tamper_evidence.js";

export interface DriftCheckResult {
  drifted: boolean;
  liveFiles: { path: string; content: string }[];
  liveHash: string;
}

/**
 * Node 2a. Pure hash comparison, zero LLM cost, runs before every modify.
 *
 * Honest limitation, worth knowing before you rely on this: last_synced_hash
 * is a hash, not a stored snapshot — §4 deliberately keeps the manifest to
 * compact metadata, not raw source. So this can tell you THAT a component
 * drifted, but not what changed. What's built here instead: detect drift,
 * block modify until acknowledged, let a human explicitly accept the new
 * baseline.
 */
export async function checkDrift(
  entry: ManifestEntry,
  targetDir: string = process.cwd()
): Promise<DriftCheckResult> {
  const liveFiles = await readComponentFiles(entry, targetDir);
  const liveHash = computeSyncHash(liveFiles);
  const drifted = entry.last_synced_hash !== null && entry.last_synced_hash !== liveHash;
  if (drifted) {
    try {
      appendAuditRecord({ event: "ai_monitoring_event", type: "component_drift", component_id: entry.component_id });
    } catch {}
  }
  return {
    drifted,
    liveFiles,
    liveHash,
  };
}

export interface DriftAcceptResult {
  ok: boolean;
  reason?: string;
}

/**
 * Accepts current on-disk state as the new baseline. Since we can't diff,
 * we can't know if the manual edit was contract-changing — so this always
 * re-verifies dependents. Slightly more expensive than assuming, but it's
 * the safe default rather than the cheap one.
 *
 * Provenance note: whoever actually touched these files outside Purix's
 * pipeline is unknowable from a hash alone — could be a human editing
 * directly, or an external agent's change applied without ever going
 * through Node 0. Recorded as source_type: "external_diff" because
 * that's the one thing we're actually sure of — it did NOT come from
 * Purix's own Instruction Path. source_agent stays whatever the caller
 * knows, null if truly unknown.
 */
export async function acceptDrift(
  entry: ManifestEntry,
  liveFiles: { path: string; content: string }[],
  liveHash: string,
  targetDir: string = process.cwd(),
  sourceAgent: string | null = null
): Promise<DriftAcceptResult> {
  // acceptDrift doesn't write anything itself (the drift already
  // happened outside Purix), so there's no "before the write" moment to
  // protect the way activateMigration has one. But it still sets the
  // trust bar for what becomes the new baseline, and a compile-only
  // check plus a standalone secrets scan isn't that bar anywhere else
  // in the system — verifyInSandbox is. This one call subsumes both the
  // old verifyComponent check and the old standalone scanForSecrets
  // call (the sandbox already runs the secrets scan first, before tsc),
  // so there's no separate secrets step below anymore.
  const verification = verifyInSandbox(
    entry.component_id,
    liveFiles.map((f) => ({ path: f.path, new_content: f.content })),
    targetDir
  );
  if (verification.status !== "pass") {
    return {
      ok: false,
      reason: `Current on-disk state doesn't pass a full sandbox verification: ${verification.reason}. Fix it directly, or run "purix modify" to repair through the normal patch path instead of accepting broken drift as a baseline.`,
    };
  }

  entry.current_version += 1;
  entry.verification_status = "pass";
  entry.last_synced_hash = liveHash;
  entry.version_history.push({
    version: entry.current_version,
    operation: "drift_reconciled",
    patch_ref: `v${entry.current_version}-drift-accepted`,
    contract_changed: true, // unknown, so treated as worst-case for cascade purposes
    timestamp: new Date().toISOString(),
    provenance: { source_type: "external_diff", source_agent: sourceAgent },
  });
  writeManifest(entry);

  const dependents = getDependents(entry);
  if (dependents.length > 0) {
    console.log(`Re-verifying ${dependents.length} dependent(s) — can't rule out this drift being contract-changing.`);
    const cascade = reVerifyDependents(dependents, targetDir);
    for (const c of cascade) {
      console.log(
        c.status === "pass"
          ? `   ✅ ${c.component_id} still verifies`
          : `   ❌ ${c.component_id} now FAILS verification:\n      ${c.reason}`
      );
    }
  }

  return { ok: true };
}