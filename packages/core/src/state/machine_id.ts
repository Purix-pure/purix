// packages/core/src/state/machine_id.ts
//
// A stable per-MACHINE identifier, distinct from getProjectId() (per-
// REPOSITORY, see project_id.ts). Used by `purix login`'s savings-sync
// call to tell the server "these savings numbers, across however many
// different projects/repos this login touches, all came from the same
// physical machine" — see cli/commands/auth.ts and Part 3's schema
// (savings_history is keyed on the pair (projectId, machineId), not
// projectId alone).
//
// FIX PROVENANCE (2026-08-30): this file previously contained a
// mis-filed duplicate of project_id.ts's OLD (pre-ADR-042-fix) logic —
// itself a second copy of getProjectId(), under the wrong filename, with
// no getMachineId() defined anywhere. cli/commands/auth.ts imported
// getMachineId from this file and crashed at module load
// (`SyntaxError: ... does not provide an export named 'getMachineId'`)
// on every `purix login` invocation. This is a from-scratch, correct
// implementation, not a patch of what was here.
//
// Deliberately NOT baseDir-scoped like getProjectId() — a machine
// identity must be the same no matter which directory Purix is run from
// on that machine, which is the actual bug in the old
// machine_id.test.ts's premise (it asserted DIFFERENT ids for different
// baseDirs — that's project-id semantics, not machine-id semantics; the
// test itself has been corrected alongside this file, see its own
// updated header comment). Cached under the OS home directory (one
// Purix-wide location, not per-project, not per-worktree) so it's
// genuinely stable across every repo and worktree this machine ever
// touches. A `baseDir` parameter is still accepted (default
// process.cwd(), unused by the real cache path) purely so tests can
// redirect the cache location without touching a real machine's home
// directory — see the accompanying test file.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { createFileExclusive, writeFileAtomic } from "../platform/atomic_write.js";
import { purixDir } from "../platform/layout.js";

const MACHINE_ID_FILE = "machine-id";

/**
 * Resolves the directory the machine id is cached in. Real callers get
 * <homedir>/.purix (one per machine, regardless of cwd). Tests pass an
 * explicit baseDir so they don't read/write a real machine's home
 * directory or collide with each other when run in parallel.
 */
function machineIdDir(baseDir?: string): string {
  return purixDir(baseDir ?? homedir());
}

/**
 * Stable per-machine identifier. Computed once per machine (or, in
 * tests, once per explicit baseDir), cached thereafter — never
 * recomputed once a value exists, so reinstalling Purix or updating it
 * doesn't fragment a machine's savings history server-side.
 */
export function getMachineId(baseDir?: string): string {
  const dir = machineIdDir(baseDir);
  const filePath = join(dir, MACHINE_ID_FILE);

  if (existsSync(filePath)) {
    try {
      const cached = readFileSync(filePath, "utf8").trim();
      if (cached.length > 0) return cached;
    } catch {
      // fall through and mint a new one below — a corrupted/unreadable
      // cache file shouldn't hard-fail `purix login`, it should just
      // regenerate (a machine getting a new id after a corrupted cache
      // is a far smaller correctness issue than login itself crashing).
    }
  }

  const id = randomUUID();
  try {
    // Create-if-absent, not "check then write": two processes starting together on a fresh machine would
    // both see no file and each keep their own id, splitting the machine's savings history server-side.
    if (createFileExclusive(filePath, id)) return id;
    // Someone created it between our check and now. Their id is the machine's id; use it.
    const winner = readFileSync(filePath, "utf8").trim();
    if (winner.length > 0) return winner;
    // The file exists but is empty (damaged): replace it, atomically.
    writeFileAtomic(filePath, id);
  } catch {
    // Best-effort persistence: if the write fails (read-only filesystem,
    // permissions, etc.), still return a value for this call so login
    // doesn't crash — just accept that the NEXT call in a fresh process
    // may mint a different id. This mirrors this codebase's existing
    // "degrade explicitly, never silently" posture (ADR-039/035/012, formerly ADR-002/040/043)
    // applied to a low-stakes identifier rather than a safety gate.
  }
  return id;
}
