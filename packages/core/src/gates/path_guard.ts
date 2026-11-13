// src/gates/path_guard.ts
import { resolve, sep, dirname } from "node:path";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";

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
/**
 * BUG FIX (GAPS-REPORT §2.6): the lexical check above (path.resolve() +
 * prefix match) cannot detect a path component INSIDE targetDir that is
 * itself a symlink pointing outside it — e.g. a component named
 * `shared -> /etc` planted by an ingested diff or scaffold plan before
 * this guard runs against a path like `shared/passwd`. `resolve()`
 * computes a path that is lexically inside targetDir and passes the
 * check above, while the real filesystem read/write that follows
 * resolves through the symlink to the real target outside the repo.
 *
 * Walks from the resolved path up toward root looking for the nearest
 * EXISTING component and resolves its real path via realpathSync(),
 * which follows any symlink along the way. Deliberately never walks
 * above root itself — this only cares whether something already on
 * disk inside targetDir secretly points outside it, not whether
 * targetDir's own real-filesystem ancestors do (targetDir may not even
 * exist yet, e.g. in tests or a not-yet-scaffolded repo, which must
 * stay a safe/no-op case, not a false escape).
 */
function findSymlinkEscape(root: string, resolved: string, depth: number = 0): string | null {
  const rootWithSep = root.endsWith(sep) ? root : root + sep;
  const inside = (p: string) => p === root || p.startsWith(rootWithSep);
  if (depth > 8) return resolved; // a chain of links this long is not a project layout; refuse rather than follow it forever
  let current = resolved;
  while (inside(current)) {
    // lstat, not existsSync: existsSync follows links, so a DANGLING link (its target does not exist yet) read as "nothing here",
    // the walk went on up to a safe parent, and a write through the link then created the file outside the root.
    let st;
    try {
      st = lstatSync(current);
    } catch {
      st = null; // nothing at this component yet: look at its parent
    }
    if (st) {
      let real: string;
      try {
        real = realpathSync(current);
      } catch {
        if (st.isSymbolicLink()) {
          // A dangling link. Where it points decides: outside the root is an escape (a write would create the target there).
          let target: string;
          try {
            target = resolve(dirname(current), readlinkSync(current));
          } catch {
            return current; // a link that cannot be read cannot be shown safe
          }
          if (!inside(target)) return target;
          return findSymlinkEscape(root, target, depth + 1); // inside the root, but that path may itself run through a link
        }
        // Race or an unreadable component that is not a link — not this check's concern; the operation that actually touches the
        // filesystem will surface its own error if this path turns out to be unusable.
        return null;
      }
      if (real !== root && !real.startsWith(rootWithSep)) {
        return real;
      }
      // The nearest existing component resolves safely inside root, and anything below it (deeper, not-yet-created path
      // segments) cannot itself be a symlink since it doesn't exist yet.
      return null;
    }
    if (current === root) return null; // walked to root — nothing on disk yet
    current = dirname(current);
  }
  return null;
}

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

  const escapedReal = findSymlinkEscape(root, resolved);
  if (escapedReal) {
    return {
      ok: false,
      reason: `path "${relPath}" resolves to "${resolved}" lexically, but a symlink along that path actually points to "${escapedReal}", which is outside the target directory "${root}" — refusing to read or write through a symlink escape`,
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