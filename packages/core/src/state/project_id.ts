// packages/core/src/state/project_id.ts
//
// Part 5: getProjectId(). Reads .git/config directly rather than shelling
// out to `git remote -v` or depending on simple-git — avoids both a PATH
// dependency (git may not be installed / on PATH in every environment
// Purix runs in) and an unnecessary execSync surface. If there's no
// .git/config or no remote in it, a UUID is generated once and persisted.
// Computed once, cached from then on — renaming a remote or re-cloning
// must not fragment a project's savings/sync history.
//
// ADR-041 correction (2026-08-30 fix): the no-remote UUID fallback used to
// be cached in <baseDir>/.purix/config.json — a per-worktree path. Two
// worktrees of the SAME repository (ADR-041's whole subject) would each
// mint and cache their OWN random UUID, silently giving them separate
// repo_id values in the shared budget/manifest DB — meaning the atomic
// ceiling check in llm/budget.ts, however correct in isolation, was
// checking two different rows and never actually contending. Confirmed
// via a real two-worktree, two-process test (budget_worktree.test.ts)
// before this fix: both processes reported "success" against a ceiling
// sized for only one. Caching the fallback UUID in the git-common-dir-
// resolved shared state directory instead (same location the
// budget/manifest DB already uses, per git_common_dir.ts) fixes this: two
// worktrees of one repository now read/write the same cached id, exactly
// like two worktrees with a real remote URL already did via the hash
// path. Two UNRELATED clones with no remote still each resolve to a
// different git-common-dir and so still correctly mint their own UUID —
// nothing about the "unrelated clone" case changes.
//
// FIX PROVENANCE: this correct logic previously existed in this same repo
// under state/machine_id.ts (wrong filename — its own header comment even
// said "project_id.ts") while THIS file (project_id.ts) held the stale,
// pre-fix, per-worktree-caching version, and llm/budget.ts imported from
// THIS file — meaning the fix was written but never actually wired to its
// consumer. Confirmed broken via a direct run of budget_worktree.test.ts
// (2 of 3 subtests failed) before this correction; confirmed fixed via
// the same test after (see SESSION_LOG.md for raw before/after output).
// state/machine_id.ts has been rewritten to hold a genuine, distinct
// per-machine identity — see that file's own header comment.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createConfigStore } from "./config.js";
import { resolveSharedStateDir } from "./git_common_dir.js";

const PROJECT_ID_CONFIG_KEY = "project-id";

/**
 * Pulls the first `url = ...` line out of any `[remote "..."]` section in
 * .git/config. Deliberately simple line-based parsing rather than a full
 * INI parser — .git/config's remote-url lines are a well-known, stable
 * format, and a full parser is more surface area than this needs.
 */
function readGitRemoteUrl(baseDir: string): string | null {
  const gitConfigPath = join(baseDir, ".git", "config");
  if (!existsSync(gitConfigPath)) return null;

  let content: string;
  try {
    content = readFileSync(gitConfigPath, "utf8");
  } catch {
    return null;
  }

  const lines = content.split("\n");
  let inRemoteSection = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (line.startsWith("[remote ")) {
      inRemoteSection = true;
      continue;
    }
    if (line.startsWith("[")) {
      inRemoteSection = false;
      continue;
    }
    if (inRemoteSection && line.startsWith("url")) {
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const url = line.slice(eq + 1).trim();
      if (url) return url;
    }
  }
  return null;
}

/**
 * Stable per-project identifier used to key savings_history on the server
 * (paired with machine_id — see state/machine_id.ts and Part 3's schema).
 * Computed once, never recomputed: a remote URL gets hashed directly
 * (deterministic — the same remote always yields the same id, so a
 * re-clone doesn't fragment history, and every worktree of that repo
 * already resolves the same remote URL so they naturally share this id
 * too). No remote falls back to a random UUID cached in the repository's
 * shared state directory (git-common-dir-resolved — see
 * git_common_dir.ts), so it's stable across runs AND shared across every
 * worktree of the SAME repository, while an unrelated re-clone (different
 * git-common-dir) still mints its own.
 */
export function getProjectId(baseDir: string = process.cwd()): string {
  // Cache lookups/writes for the no-remote fallback path live in the
  // repo-shared state dir, not baseDir itself — baseDir may be one
  // worktree of several. Falls back to <baseDir>/.purix when baseDir
  // isn't inside a git repo at all (resolveSharedStateDir's own
  // documented fallback), matching prior behavior for non-repo usage.
  const store = createConfigStore(resolveSharedStateDir(baseDir));
  const cached = store.get(PROJECT_ID_CONFIG_KEY);
  if (typeof cached === "string" && cached.length > 0) return cached;

  // Clones are isolated by default unless explicitly opted in via purix.shareProjectId = true
  const shareIdentity = store.get("purix.shareProjectId") === true || store.get("isolateBudget") === false;
  const remoteUrl = shareIdentity ? readGitRemoteUrl(baseDir) : null;
  const id = remoteUrl
    ? createHash("sha256").update(remoteUrl).digest("hex")
    : randomUUID();

  store.set(PROJECT_ID_CONFIG_KEY, id);
  return id;
}
