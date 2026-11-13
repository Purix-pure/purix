// packages/core/src/state/git_common_dir.ts
//
// ADR-042: genuinely shared state (Operation Library, manifest store,
// burn-guard ledger) must live in one repository-scoped location — the
// common git directory every worktree of a repository resolves back to —
// not a path under any single worktree's own working directory. A linked
// worktree's `.git` is a *file* containing `gitdir: <path>/.git/worktrees/<name>`,
// not a directory; that path's parent's parent is the common `.git` dir
// shared by every worktree. The main worktree's `.git` is already the
// common dir, so it resolves to itself.
//
// Deliberately mirrors project_id.ts's approach: direct filesystem reads,
// no shelling out to `git rev-parse --git-common-dir`, so this works in
// environments where git may not be on PATH. Falls back to a plain
// `<baseDir>/.purix` path (old behavior) when no `.git` is found at all —
// e.g. a directory that isn't a git repo yet — so this never blocks a
// command that ADR-042 doesn't apply to.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { purixDir } from "../platform/layout.js";

/**
 * Walks up from startDir looking for a `.git` entry (directory or file),
 * the same way git itself resolves the repository root. Returns null if
 * none is found before hitting the filesystem root.
 */
function findDotGit(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    const candidate = join(dir, ".git");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached filesystem root
    dir = parent;
  }
}

/**
 * Resolves `.git` (directory or file) to the common git directory shared
 * by every worktree of that repository.
 */
function resolveCommonDir(dotGitPath: string): string {
  const stats = statSync(dotGitPath);

  if (stats.isDirectory()) {
    // Either the main worktree (this IS the common dir) or a bare repo.
    // A linked worktree's own `.git/worktrees/<name>/gitdir` never
    // matters here — we only ever start from a *working tree*'s `.git`.
    return dotGitPath;
  }

  // Linked worktree: `.git` is a file containing `gitdir: <path>`.
  let content: string;
  try {
    content = readFileSync(dotGitPath, "utf8");
  } catch {
    return dirname(dotGitPath); // best effort — treat as if it were the dir
  }

  const match = content.match(/^gitdir:\s*(.+)\s*$/m);
  if (!match || !match[1]) return dirname(dotGitPath);

  const gitDirRaw = match[1].trim();
  const gitDir = isAbsolute(gitDirRaw) ? gitDirRaw : resolve(dirname(dotGitPath), gitDirRaw);

  // gitDir is ".../.git/worktrees/<name>" — the common dir is two levels up.
  const worktreesDir = dirname(gitDir); // ".../.git/worktrees"
  const commonDir = dirname(worktreesDir); // ".../.git"
  return existsSync(commonDir) ? commonDir : dirname(gitDir);
}

/**
 * Returns the directory Purix should store repository-shared state in
 * (Operation Library, manifest DB, burn-guard ledger) for the given
 * working directory. Two worktrees of the same repository resolve to the
 * SAME path here — that's the entire point (ADR-042). A directory with no
 * `.git` anywhere in its ancestry falls back to `<baseDir>/.purix`,
 * matching pre-ADR-042 behavior, so non-repo usage (e.g. tests, scratch
 * directories) is unaffected.
 */
export function resolveSharedStateDir(baseDir: string = process.cwd()): string {
  const local = purixDir(resolve(baseDir));
  const dotGit = findDotGit(baseDir);
  if (!dotGit) return local;

  const shared = join(resolveCommonDir(dotGit), "purix-state");
  // A project that began before `git init` (or was copied in from a folder that was not a repository) keeps its
  // store where it is. Without this, running `git init` silently moved the store's address: `purix status`
  // showed nothing governed and `purix check` exited 0 over the same project. The legacy store is used only while
  // the shared one does not exist yet, so a worktree setup that already has a shared store is unaffected.
  if (!existsSync(join(shared, "manifest.db")) && existsSync(join(local, "manifest.db"))) return local;
  return shared;
}