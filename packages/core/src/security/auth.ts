// src/security/auth.ts
import { chmodSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";
import { confirm, lastConfirmHadNoInputAvailable, promptsLocked } from "../cli-io/confirm.js";
import { quarantineCorruptFile, readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

const AUTH_PATH = join(PURIX_DIRNAME, "authorized_operators.json");

/** The command a person runs, in a terminal in the project folder, to register themselves as an approver. */
export const REGISTER_APPROVER_COMMAND = "purix approve --register";

/**
 * What is said when no approver is on record and nobody can be asked. Registering is a question for a person, and a process whose
 * stdin/stdout carry a protocol (the MCP server) has no way to ask it, so it says what to do instead of asking.
 */
export function noApproverMessage(): string {
  return (
    `No approver is registered for this project yet (${AUTH_PATH}). Registering one is a one-time question for a person, ` +
    `and it cannot be asked inside an MCP session. In a terminal, in this project folder, run: ${REGISTER_APPROVER_COMMAND}   ` +
    `Then call this tool again.`
  );
}

export type ApproverStatus =
  | { ok: true }
  | { ok: false; reason: "none" | "not_listed" | "unreadable"; message: string };

/**
 * Is the person running this process an approver? Never prompts, never writes, never throws. For status and pre-flight
 * checks that must tell a person what is missing without asking them anything.
 */
export function approverStatus(): ApproverStatus {
  let state: AuthState;
  try {
    state = load();
  } catch (err) {
    return { ok: false, reason: "unreadable", message: err instanceof Error ? err.message : String(err) };
  }
  if (state.authorized.length === 0) return { ok: false, reason: "none", message: noApproverMessage() };
  const currentUser = userInfo().username;
  if (!state.authorized.includes(currentUser)) {
    return {
      ok: false,
      reason: "not_listed",
      message: `User "${currentUser}" is not in the authorized-approvers list (${AUTH_PATH}). Add them manually to that file to grant approval rights.`,
    };
  }
  return { ok: true };
}

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
    // Nobody can be asked (the MCP server): say what to do instead of writing a prompt into a protocol stream. Writes nothing.
    if (promptsLocked()) throw new Error(noApproverMessage());
    const proceed = await confirm(
      `No authorized approvers configured yet (${AUTH_PATH}). Register "${currentUser}" as the sole approver now?`
    );
    if (!proceed) {
      // Two different things looked identical here: a person typing "n", and a shell where nobody could answer (an agent's tool call,
      // a pipe, CI). Only the first is a decision; the second needs the person to do the one-time registration themselves.
      if (lastConfirmHadNoInputAvailable()) {
        throw new Error(
          `No approver is registered for this project yet, and this shell cannot ask the question (it is not an interactive terminal). Nothing was registered. ` +
            `A person has to do this once: in your own terminal, in this project folder, run: ${REGISTER_APPROVER_COMMAND}   Then run this command again.`
        );
      }
      throw new Error(`Bootstrap declined — no authorized approver on record. Nothing was registered. Run "${REGISTER_APPROVER_COMMAND}" when you want to register.`);
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