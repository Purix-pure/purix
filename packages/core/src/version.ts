// src/version.ts
//
// REAL FIX (2026-09-19): see packages/cli/src/version.ts's header for the
// full reasoning — this is the same fix applied per-package, since each
// of @purix/core, @purix/cli, and @purix/mcp-server publishes and versions
// independently (see publish.yml's lockstep-tag-check comment) and each
// needs its own package.json as its own source of truth, not a shared
// constant that could itself drift from any one of them.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

export const PURIX_VERSION: string = pkg.version;
