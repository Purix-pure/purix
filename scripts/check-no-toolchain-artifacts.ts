// scripts/check-no-toolchain-artifacts.ts
//
// Companion to scripts/check-core-boundary.ts, same shape. That one keeps
// packages/core from importing packages/cli or packages/api; this one keeps
// toolchain-generated artifacts (venvs, package caches, compiled binaries,
// build output) out of the source tree entirely.
//
// The sanctioned location for that kind of thing is baseDir/.purix-tmp/<lang>/
// (see packages/core/src/platform/toolchain_tmp.ts). Anything matching the
// denylist below found ANYWHERE under packages/ EXCEPT inside a .purix-tmp/
// directory fails the check — that's a provider writing to the wrong place,
// or someone's local toolchain run leaking a file into source that never
// got cleaned up before committing.
//
// Run via: node --import tsx scripts/check-no-toolchain-artifacts.ts
// Wire into package.json as its own script (e.g. "artifact-check") and run
// it alongside boundary-check in CI, not as a replacement for either.

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const PACKAGES_ROOT = join(import.meta.dirname, "..", "packages");

// Directory names that should never exist inside source, anywhere, under
// any language — these are always toolchain-generated, never hand-authored.
const FORBIDDEN_DIR_NAMES = new Set([
  ".venv",
  "venv",
  ".ruff_cache",
  "__pycache__",
  ".pytest_cache",
  "target",       // cargo build output
  ".cargo",
  "vendor",       // bundler's default gem vendor dir when BUNDLE_PATH unset
  ".bundle",
  "Python",       // portable interpreter installs — belongs in .purix-tmp/python/, never packages/core/Python
]);

// File extensions that are always build output, never source.
const FORBIDDEN_EXTENSIONS = [".exe", ".pyc", ".pyd", ".dll", ".so"];

// Never descend into these — not because they're allowed to hold junk, but
// because they're either the sanctioned tmp location or already handled by
// a different check (node_modules is gitignored + irrelevant here).
const SKIP_DIR_NAMES = new Set([".purix-tmp", "node_modules", ".turbo", ".git"]);

interface Violation {
  path: string;
  reason: string;
}

function walk(dir: string, violations: Violation[]): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }

  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }

    if (st.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry)) continue;
      if (FORBIDDEN_DIR_NAMES.has(entry)) {
        violations.push({
          path: relative(PACKAGES_ROOT, full),
          reason: `toolchain-generated directory "${entry}" found outside .purix-tmp/`,
        });
        continue; // don't descend into it — one violation for the whole dir is enough
      }
      walk(full, violations);
    } else {
      const match = FORBIDDEN_EXTENSIONS.find((ext) => entry.endsWith(ext));
      if (match) {
        violations.push({
          path: relative(PACKAGES_ROOT, full),
          reason: `build artifact (${match}) found outside .purix-tmp/`,
        });
      }
    }
  }
}

const violations: Violation[] = [];
walk(PACKAGES_ROOT, violations);

if (violations.length > 0) {
  console.error(`Found ${violations.length} toolchain artifact(s) inside packages/ source tree:\n`);
  for (const v of violations) {
    console.error(`  packages/${v.path}  —  ${v.reason}`);
  }
  console.error(
    `\nThese belong under <baseDir>/.purix-tmp/<lang>/ instead (see platform/toolchain_tmp.ts).` +
    ` If a provider wrote one of these directly, fix the provider's call site rather than deleting` +
    ` the file and moving on — the same run will just recreate it.`
  );
  process.exit(1);
} else {
  console.log("No toolchain artifacts found outside .purix-tmp/.");
}
