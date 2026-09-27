// src/version.ts
//
// REAL FIX (2026-09-19): each of @purix/core, @purix/cli, and @purix/mcp-server
// publishes and versions independently (see publish.yml's lockstep-tag-check
// comment), so each package reads its own package.json as the single source
// of truth for its version string rather than sharing a constant that could
// drift from any one of them. See packages/core/src/version.ts and
// packages/mcp-server/src/version.ts for the identical per-package pattern.
//
// RECOVERED 2026-09-25: this file's content had been overwritten by the
// packages/mcp-server/src/server.ts delta during the IDEA-078 handoff's zip
// assembly (a path mix-up — see the 2026-09-25 session handoff). Restored
// from the identical pattern shared by the two sibling packages; no other
// symbol was ever exported from this file (confirmed against every
// `from "./version"` / `from "../version"` import in packages/cli/src).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as { version: string };

export const PURIX_VERSION: string = pkg.version;