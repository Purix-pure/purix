#!/usr/bin/env node
// packages/core/scripts/copy-fixtures.mjs
//
// tsc only emits from .ts sources, so any non-.ts asset a runtime module
// needs to read off disk at its own compiled location never reaches
// dist/ on its own — tsconfig.build.json's `exclude` for these
// directories exists specifically so tsc doesn't try to compile them,
// which is correct, but "excluded from compilation" and "present in the
// published package" are two different things, and only this script
// makes the second one true. Without it, every real (built/published)
// copy of Purix silently has an empty directory where a runtime module
// expected real files — this is exactly the bug that made every
// `purix lang verify <id>` conformance fixture fail with "file does not
// exist" (found and fixed in this session; language manifests hit the
// same gap for the same reason and are copied here too, so it isn't
// rediscovered a third time for a third asset type later).
//
// Each entry below copies one directory verbatim from src/ to the
// matching path under dist/ — add a line here, not a new one-off script,
// the next time a runtime module needs a non-.ts asset shipped alongside
// it.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const packageRoot = resolve(__dirname, "..");

const ASSET_DIRS = [
  ["language", "conformance", "fixtures"],
  ["language", "manifests"],
];

let failed = false;
for (const relParts of ASSET_DIRS) {
  const src = join(packageRoot, "src", ...relParts);
  const dest = join(packageRoot, "dist", ...relParts);
  if (!existsSync(src)) {
    console.error(`copy-fixtures: source directory not found: ${src}`);
    failed = true;
    continue;
  }
  mkdirSync(dest, { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log(`copy-fixtures: copied ${src} -> ${dest}`);
}

if (failed) process.exit(1);
