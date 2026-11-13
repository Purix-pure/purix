// packages/core/src/security/savings_sync.ts
//
// Event-ID savings sync (ADR-044 amendment, Purix 4 section 7). Each local
// savings row is sent once with the key (machineId, projectAlias, localSeq);
// the server stores distinct events and sums them. A retry is harmless
// because the server is idempotent on that key. The client remembers the
// last acknowledged sequence so a failed upload resumes where it stopped.
//
// projectAlias is a random per-install alias, never a hash of the git
// remote, because a hash of a public repo URL can be recomputed by anyone.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { purixDir } from "../platform/layout.js";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { ApiRequestError, ApiUnreachableError, type SavingsEventPayload } from "./api_client.js";

export const SYNC_BATCH_SIZE = 500;

export interface SyncState {
  schema: 1;
  projectAlias: string;
  lastAckedSeq: number;
}

function statePath(baseDir: string): string {
  return join(purixDir(baseDir), "savings-sync.json");
}

export function readSyncState(baseDir: string): SyncState {
  const r = readJsonFile<SyncState>(statePath(baseDir));
  if (r.kind === "ok" && r.value.schema === 1 && typeof r.value.projectAlias === "string" && Number.isInteger(r.value.lastAckedSeq) && r.value.lastAckedSeq >= 0) {
    return r.value;
  }
  return { schema: 1, projectAlias: randomUUID(), lastAckedSeq: 0 };
}

function writeSyncState(baseDir: string, state: SyncState): void {
  writeJsonAtomic(statePath(baseDir), state);
}

export interface SavingsSyncDeps {
  baseDir: string;
  machineId: string;
  listEventsAfter: (afterSeq: number, limit: number) => SavingsEventPayload["events"];
  send: (payload: SavingsEventPayload) => Promise<{ ackedThroughSeq?: number }>;
}

export type SyncOutcome =
  | { status: "nothing_to_send" }
  | { status: "synced"; sent: number; lastAckedSeq: number }
  | { status: "unsupported" } // server has no event endpoint yet (404/405): caller may use the legacy path
  | { status: "failed"; reason: string }; // network or server error: retry on a later run

/** Sends everything above the last acknowledged sequence, in batches. Never throws. */
export async function syncSavingsEvents(deps: SavingsSyncDeps): Promise<SyncOutcome> {
  let state = readSyncState(deps.baseDir);
  let sent = 0;
  try {
    for (;;) {
      const events = deps.listEventsAfter(state.lastAckedSeq, SYNC_BATCH_SIZE);
      if (events.length === 0) break;
      const last = events[events.length - 1]!.localSeq;
      const res = await deps.send({ machineId: deps.machineId, projectAlias: state.projectAlias, events });
      const acked = typeof res?.ackedThroughSeq === "number" ? Math.min(res.ackedThroughSeq, last) : last;
      if (acked <= state.lastAckedSeq) return { status: "failed", reason: "server acknowledged nothing" };
      state = { ...state, lastAckedSeq: acked };
      writeSyncState(deps.baseDir, state); // resume point survives a crash between batches
      sent += events.filter((e) => e.localSeq <= acked).length;
      if (events.length < SYNC_BATCH_SIZE) break;
    }
  } catch (err) {
    if (err instanceof ApiRequestError && (err.status === 404 || err.status === 405)) return { status: "unsupported" };
    if (err instanceof ApiUnreachableError || err instanceof ApiRequestError) return { status: "failed", reason: err.message };
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
  if (sent === 0) {
    if (!existsSync(statePath(deps.baseDir))) writeSyncState(deps.baseDir, state);
    return { status: "nothing_to_send" };
  }
  return { status: "synced", sent, lastAckedSeq: state.lastAckedSeq };
}
