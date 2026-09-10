// src/gates/path_guard.ts
import { resolve, sep } from "node:path";

export interface PathCheckResult {
  ok: boolean;
  resolved?: string;
  reason?: string;
}

/**
 * Path-traversal guard. A relative path is "trusted" in this codebase
 * only when it was produced by Purix's own deterministic code walking a
 * manifest's own `files` list. Everywhere else a path string enters the
 * system from something Purix doesn't fully control — an ingested diff's
 * `--- a/...` / `+++ b/...` header, an LLM-produced TopologyPlan during
 * scaffold, a replayed before/after snapshot during reconciliation or
 * migration activation — it needs to be re-validated before it's ever
 * joined onto a real filesystem path and read from or written to.
 *
 * A `..` segment, an absolute path, or anything else that resolves
 * outside targetDir is rejected outright. This mirrors the rest of the
 * codebase's own discipline (ingest.ts's hunk-apply, compile.ts's
 * anchor-text matching): fail closed and say why, never guess a
 * "probably fine" interpretation of an ambiguous path.
 */
export function resolveSafePath(targetDir: string, relPath: string): PathCheckResult {
  if (relPath == null || relPath.trim() === "") {
    return { ok: false, reason: `empty path` };
  }

  const root = resolve(targetDir);
  const resolved = resolve(root, relPath);
  const rootWithSep = root.endsWith(sep) ? root : root + sep;

  if (resolved !== root && !resolved.startsWith(rootWithSep)) {
    return {
      ok: false,
      reason: `path "${relPath}" resolves to "${resolved}", which is outside the target directory "${root}" — refusing to read or write outside the repo root`,
    };
  }

  return { ok: true, resolved };
}

/** Convenience for call sites validating a whole batch (a diff, a scaffold plan, a snapshot) at once. */
export function findUnsafePaths(targetDir: string, relPaths: string[]): { path: string; reason: string }[] {
  const bad: { path: string; reason: string }[] = [];
  for (const p of relPaths) {
    const check = resolveSafePath(targetDir, p);
    if (!check.ok) bad.push({ path: p, reason: check.reason! });
  }
  return bad;
}