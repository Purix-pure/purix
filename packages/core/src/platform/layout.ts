// packages/core/src/platform/layout.ts
//
// Where Purix is allowed to put things on disk. One module, so the rule is written
// once and tests/CI can check it.
//
// THE RULE: inside a project, Purix writes only under <project>/.purix/. Anything
// that is disposable (language toolchains, virtualenvs, caches, conformance
// workspaces) goes under <project>/.purix/tmp/ and nowhere else. A user can delete
// .purix/tmp at any time and lose nothing but a re-download.
//
// Why a single folder rather than .purix + .purix-tmp side by side (the old layout):
//  - Coding agents scope file access to the directory they were started in and
//    prompt the user for anything else (OpenCode: the `external_directory`
//    permission, default "ask"). One owned folder is one thing to explain, allow
//    or deny; two siblings were two.
//  - Tools that generate disposable data conventionally make that folder
//    self-ignoring rather than editing the user's .gitignore: pytest, ruff and
//    mypy each drop a `.gitignore` containing `*` into their own cache dir, and
//    the Cache Directory Tagging Specification (CACHEDIR.TAG) tells backup tools
//    to skip it. Both are done here, so a user never has to add an ignore rule.
//  - `.purix-tmp` was NOT skipped by the indexer or the sandbox copy (only
//    `.purix` was), so in a non-git project a Python venv could be indexed as
//    source. Everything under `.purix` is skipped by both.
//
// Not covered here, on purpose: machine-global files (~/.purix: session, machine
// id, logs) follow the user, not a project; and ADR-042's shared state, which lives
// in the git common dir so clones never carry it (state/git_common_dir.ts).
import { existsSync, mkdirSync } from "node:fs";
import { createFileExclusive } from "./atomic_write.js";
import { join, sep } from "node:path";

export const PURIX_DIRNAME = ".purix";
/** Pre-2026-10 name of the disposable folder. Still recognised so it can be reported/cleaned. */
export const LEGACY_TMP_DIRNAME = ".purix-tmp";

/**
 * A path in the one form Purix stores and compares: forward slashes on every OS. Windows APIs hand back backslashes; an index
 * written with them could never match a path typed or computed with slashes (`purix adopt src/a.ts` said "not in the index").
 */
export function toPosixPath(p: string): string {
  return p.split(sep).join("/");
}

/** Reads a stored path of any vintage (older Windows indexes stored backslashes) as the POSIX form. For comparing, never for building paths. */
export function storedPosixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

export function purixDir(baseDir: string): string {
  return join(baseDir, PURIX_DIRNAME);
}

/** <baseDir>/.purix/tmp — disposable, self-ignoring, created on first use. */
export function purixTmpRoot(baseDir: string): string {
  const dir = join(purixDir(baseDir), "tmp");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeIfMissing(join(dir, ".gitignore"), "# Purix disposable data: safe to delete at any time.\n*\n");
  writeIfMissing(
    join(dir, "CACHEDIR.TAG"),
    "Signature: 8a477f597d28d172789f06886806bc55\n# This file is a cache directory tag created by Purix.\n# For information about cache directory tags see https://bford.info/cachedir/\n"
  );
  return dir;
}

function writeIfMissing(path: string, content: string): void {
  try {
    // Create-if-absent: two processes initialising the same folder cannot overwrite each other.
    createFileExclusive(path, content);
  } catch {
    // Read-only checkout or similar: the folder still works, it is just not self-describing.
  }
}
