// packages/core/src/platform/toolchain_tmp.ts
//
// Single rule, everywhere: no language provider ever writes a venv, package
// cache, or build/target directory directly into baseDir. Everything a
// toolchain generates on its own (not authored by a human) goes under
// baseDir/.purix-tmp/<lang>/ instead — one predictable, git-ignored folder
// name, namespaced per language so a project using Python + Go + Rust
// doesn't collide.
//
// baseDir here follows the same convention state/config.ts already uses for
// .purix/ (join(baseDir, ".purix", ...), no upward directory search) — for
// a real end-user project baseDir IS the project root, so this already
// produces a single tmp folder at project root, which is exactly the
// existing model. For Purix's own conformance fixtures, each scenario
// subdirectory (fixtures/go/passing/, fixtures/go/broken_compile/, ...) is
// legitimately its own tiny isolated project — it has its own go.mod /
// Cargo.toml / Gemfile — so getting one .purix-tmp per scenario there is
// correct, not a violation of "one tmp folder per project."
//
// Language-specific wiring still needs doing at each call site (setting
// RUFF_CACHE_DIR, GOCACHE/GOPATH, CARGO_TARGET_DIR, BUNDLE_PATH/GEM_HOME,
// and pointing venv creation + compiled-test-binary output here) — this
// file only defines and creates the shared destination.

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

export type ToolchainLang = "python" | "go" | "rust" | "ruby";

const TOOLCHAIN_TMP_DIRNAME = ".purix-tmp";

/**
 * Returns baseDir/.purix-tmp/<lang>, creating it (and any missing parent
 * segments) if it doesn't exist yet. Callers pass this as the venv location,
 * or use it to build a cache/target/bundle subpath.
 */
export function resolveToolchainTmp(baseDir: string, lang: ToolchainLang): string {
  const dir = join(baseDir, TOOLCHAIN_TMP_DIRNAME, lang);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/**
 * Convenience for the common "give me a named subfolder under this
 * language's tmp dir" case — e.g. toolchainSubdir(baseDir, "python", "venv"),
 * toolchainSubdir(baseDir, "rust", "target").
 */
export function toolchainSubdir(baseDir: string, lang: ToolchainLang, name: string): string {
  return join(resolveToolchainTmp(baseDir, lang), name);
}
