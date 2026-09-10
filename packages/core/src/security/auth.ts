// src/security/auth.ts
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { userInfo } from "node:os";
import { confirm } from "../cli-io/confirm.js";

const AUTH_PATH = ".purix/authorized_operators.json";

interface AuthState {
  authorized: string[];
}

function load(): AuthState {
  if (!existsSync(AUTH_PATH)) return { authorized: [] };
  try {
    return JSON.parse(readFileSync(AUTH_PATH, "utf-8"));
  } catch {
    return { authorized: [] };
  }
}

function save(state: AuthState): void {
  mkdirSync(dirname(AUTH_PATH), { recursive: true });
  writeFileSync(AUTH_PATH, JSON.stringify(state, null, 2), "utf-8");
  // Security fix: authorized_operators.json decides who can approve TrustGate
  // confirmations. Lock it to owner-read/write only, same discipline
  // secrets_manager.ts already applies to its store — see security review
  // finding #1. This closes the "wrong permission bits" half of the gap;
  // it does not add cryptographic identity verification (known v1 tradeoff:
  // "authorized" here means "trusted to write to this directory").
  try {
    chmodSync(AUTH_PATH, 0o600);
  } catch {}
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