// packages/core/src/security/savings_sync_run.ts
//
// The one entry point that syncs savings for the current project. It tries
// the event-ID endpoint first; if the server does not have it yet (404/405)
// it falls back to the legacy window-total call, so a new client keeps
// working against today's server. Never throws; safe to call after a command.
import { apiClient } from "./api_client.js";
import { loadSession } from "./session.js";
import { getMachineId } from "../state/machine_id.js";
import { getProjectId } from "../state/project_id.js";
import { getSavingsSummary, listSavingsEventsAfter } from "../llm/budget.js";
import { syncSavingsEvents, type SyncOutcome } from "./savings_sync.js";

export type RunOutcome = SyncOutcome | { status: "not_logged_in" } | { status: "legacy_synced" };

export async function runSavingsSync(baseDir: string = process.cwd()): Promise<RunOutcome> {
  try {
    if (!loadSession()) return { status: "not_logged_in" };
    const machineId = getMachineId();
    const out = await syncSavingsEvents({
      baseDir,
      machineId,
      listEventsAfter: (after, limit) => listSavingsEventsAfter(after, limit),
      send: (p) => apiClient.syncSavingsEvents(p),
    });
    if (out.status !== "unsupported") return out;

    // Legacy path: today's server only knows window totals.
    const summary = getSavingsSummary(3650);
    if (summary.callCount === 0) return { status: "nothing_to_send" };
    await apiClient.syncSavings([
      { projectId: getProjectId(), machineId, windowStart: new Date(0).toISOString(), totalSavingsUsd: summary.totalSavingsUsd, callCount: summary.callCount },
    ]);
    return { status: "legacy_synced" };
  } catch (err) {
    return { status: "failed", reason: err instanceof Error ? err.message : String(err) };
  }
}
