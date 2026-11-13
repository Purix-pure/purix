// packages/core/src/platform/toolchain_tmp.ts
//
// Single rule, everywhere: no language provider ever writes a venv, package
// cache, or build/target directory directly into baseDir. Everything a
// toolchain generates on its own (not authored by a human) goes under
// baseDir/.purix/tmp/<lang>/ — see platform/layout.ts for why that is one folder
// inside .purix rather than a sibling .purix-tmp (the layout before 2026-10).
// Namespaced per language so a project using several doesn't collide.
//
// baseDir follows the same convention state/config.ts uses for .purix/
// (join(baseDir, ".purix", ...), no upward directory search). For Purix's own
// conformance fixtures each scenario directory is legitimately its own tiny
// project, so it gets its own .purix/tmp — correct, not a violation.
//
// Language-specific wiring still happens at each call site (RUFF_CACHE_DIR, ...);
// this file only defines and creates the shared destination. Tools themselves
// (their virtualenvs and node_modules) are NOT here: the tools broker installs
// them under .purix/tools/ (src/tools, ADR-060).
//
// Only "python" is supported in this beta (see BETA_SCOPE.md). If a language is
// reintroduced, add it to this union AND to language/registry.ts together.

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { purixDir, purixTmpRoot } from "./layout.js";

export type ToolchainLang = "python";

/**
 * Where baseDir/.purix/tmp/<lang> is (or would be). Creates NOTHING. Use this for lookups and
 * "is it installed?" checks, so a read-only command never leaves a .purix folder behind.
 * Only install paths should call resolveToolchainTmp(), which creates the folder.
 */
export function toolchainPath(baseDir: string, lang: ToolchainLang): string {
  return join(purixDir(baseDir), "tmp", lang);
}

/**
 * A working directory for probing a bare command name ("python --version", "pytest --version").
 * The rule in this file's header still holds: a probe must never run with cwd inside the project
 * (the Windows py launcher can self-install a runtime into its cwd). When the toolchain folder
 * already exists that is where the probe runs; when it does not, the OS temp dir is used instead of
 * creating the folder just to look around. Creates NOTHING.
 */
export function toolchainProbeCwd(baseDir: string, lang: ToolchainLang): string {
  const dir = toolchainPath(baseDir, lang);
  return existsSync(dir) ? dir : tmpdir();
}

/**
 * Returns baseDir/.purix/tmp/<lang>, creating it (and any missing parent
 * segments) if it doesn't exist yet. Callers pass this as the venv location,
 * or use it to build a cache/target/bundle subpath.
 */
export function resolveToolchainTmp(baseDir: string, lang: ToolchainLang): string {
  const dir = join(purixTmpRoot(baseDir), lang);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Convenience for the common "give me a named subfolder under this
 * language's tmp dir" case — e.g. toolchainSubdir(baseDir, "python", "ruff_cache").
 */
export function toolchainSubdir(baseDir: string, lang: ToolchainLang, name: string): string {
  return join(resolveToolchainTmp(baseDir, lang), name);
}
