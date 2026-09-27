
// packages/core/src/state/project_id_race_worker.ts
//
// Standalone entry point spawned as a real child process by
// project_id.test.ts's multi-process regression test. Calls getProjectId()
// exactly once against the given baseDir (with no id cached there yet)
// and prints the result, so the parent test can spawn several of these at
// once and check that every process gets back the SAME id.
//
// This is the regression test for a real bug found while investigating
// llm/budget_worktree.test.ts's pre-existing flaky failure: getProjectId()
// used to read its cache and, if empty, mint-and-persist a fresh id as two
// separate steps — a process could mint its own id before ever observing
// another process's write, so several concurrent first callers each ended
// up using a DIFFERENT id for the rest of that invocation, even though
// only one of their writes ultimately "won" on disk. See config.ts's
// getOrCreate() and project_id.ts's getProjectId() for the fix.
import { writeSync } from "node:fs";
import { getProjectId } from "./project_id.js";

const baseDir = process.argv[2];
if (!baseDir) {
  writeSync(2, "usage: project_id_race_worker.ts <baseDir>\n");
  process.exit(1);
}

// LIFECYCLE FIX: see budget_race_worker.ts's comment for why this is a
// synchronous write ahead of process.exit(), not process.stdout.write().
writeSync(1, getProjectId(baseDir) + "\n");
process.exit(0);