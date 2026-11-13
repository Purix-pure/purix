// packages/core/src/platform/project_root.ts
//
// N-3: which folder is "the project" when a command runs in a subfolder. One rule, one place.
//
// Rule (decided 2026-10-14, see PURIX-38):
//   1. The nearest folder at or above `start` that already holds a `.purix` folder wins. Existing
//      Purix state is the strongest sign of where the project is, so a command run from src/components
//      uses the project's state instead of silently creating a second, empty one beside the code.
//   2. Otherwise the nearest folder at or above `start` that holds `.git` (a folder, or a file, which is
//      what a worktree or submodule has). A nested repository is its own project: its history, hooks
//      and lock are its own.
//   3. Otherwise null, and the caller keeps the folder it was given.
// The user's home folder and everything above it never counts: `~/.purix` is the machine-wide store
// (login, secrets), not a project, and a dotfiles repository in the home folder is not a project either.
import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve, relative, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { PURIX_DIRNAME } from "./layout.js";

function isHomeOrAbove(dir: string, home: string): boolean {
  const rel = relative(dir, home);
  // dir is home itself, or an ancestor of home (home is inside dir)
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function isDir(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

export interface ProjectRoot {
  root: string;
  /** Which marker decided it. */
  by: "purix" | "git";
}

export function findProjectRoot(start: string, home: string = homedir()): ProjectRoot | null {
  const begin = resolve(start);
  const homeAbs = resolve(home);
  let firstGit: string | null = null;
  let dir = begin;
  for (let i = 0; i < 128; i++) {
    if (isHomeOrAbove(dir, homeAbs)) break;
    if (isDir(join(dir, PURIX_DIRNAME))) return { root: dir, by: "purix" };
    if (firstGit === null && existsSync(join(dir, ".git"))) firstGit = dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return firstGit ? { root: firstGit, by: "git" } : null;
}
