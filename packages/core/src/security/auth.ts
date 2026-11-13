// src/security/auth.ts
import { chmodSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { confirm } from "../cli-io/confirm.js";
import { quarantineCorruptFile, readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

const AUTH_PATH = join(PURIX_DIRNAME, "authorized_operators.json");

interface AuthState {
  authorized: string[];
}

function load(): AuthState {
  const read = readJsonFile<unknown>(AUTH_PATH);
  if (read.kind === "missing") return { authorized: [] };
  if (read.kind === "ok") {
    const v = read.value as { authorized?: unknown } | null;
    if (v !== null && typeof v === "object" && Array.isArray(v.authorized) && v.authorized.every((u) => typeof u === "string")) {
      return { authorized: v.authorized };
    }
  }
  // A damaged approvers file used to read as "nobody is authorized", which sent the next call down the
  // bootstrap path and would overwrite whatever was left. Same rule as the secrets store (TEST-REPORT
  // F2b): fail loudly, keep a copy, change nothing.
  const reason = read.kind === "corrupt" ? read.error : 'no "authorized" list of user names';
  const copy = quarantineCorruptFile(AUTH_PATH);
  throw new Error(
    `${AUTH_PATH} could not be read (${reason}). Nothing was changed.` +
      (copy ? ` A copy was kept at ${copy}.` : "") +
      ` Restore the file, or delete it to register an approver again.`
  );
}

function save(state: AuthState): void {
  writeJsonAtomic(AUTH_PATH, state, { mode: 0o600 });
  // Security fix: authorized_operators.json decides who can approve TrustGate
  // confirmations. Created 0600 above; the chmod stays as a belt-and-braces for
  // an umask or filesystem that ignores the open mode. Same discipline
  // secrets_manager.ts already applies to its store — see security review
  // finding #1. This closes the "wrong permission bits" half of the gap;
  // it does not add cryptographic identity verification (known v1 tradeoff:
  // "authorized" here means "trusted to write to this directory").
  try {
    chmodSync(AUTH_PATH, 0o600);
  } catch { /* chmod best-effort — not all filesystems support it */ }
}

/**
 * BUG FIX: previously bootstrapped silently on the very first call —
 * including calls that happen BEFORE a confirm prompt the person might
 * then decline (e.g. "purix create" checked this before showing the
 * write confirmation), meaning just previewing a plan permanently
 * registered you as sole approver with no real decision point. Now the
 * bootstrap itself is a Section 20 checkpoint: it asks, and fails
 * closed if declined, instead of writing the file regardless.
 *
 * Now async — every call site must `await` it.
 */
export async function assertAuthorizedToApprove(): Promise<void> {
  const currentUser = userInfo().username;
  const state = load();

  if (state.authorized.length === 0) {
    const proceed = await confirm(
      `No authorized approvers configured yet (${AUTH_PATH}). Register "${currentUser}" as the sole approver now?`
    );
    if (!proceed) {
      throw new Error(`Bootstrap declined — no authorized approver on record. Nothing was registered.`);
    }
    state.authorized = [currentUser];
    save(state);
    console.log(`  [auth] bootstrapped ${AUTH_PATH} — "${currentUser}" is the sole authorized approver.`);
    return;
  }

  if (!state.authorized.includes(currentUser)) {
    throw new Error(
      `User "${currentUser}" is not in the authorized-approvers list (${AUTH_PATH}). ` +
        `Add them manually to that file to grant approval rights.`
    );
  }
}