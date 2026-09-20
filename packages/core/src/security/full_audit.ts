// src/security/full_audit.ts
//
// Extracted to close audit finding 2.3 ("idiom-check logic still
// duplicated between cli/commands/observability.ts and mcp-server/
// server.ts" — left open by the duplication-finder pass, see CHANGES.md's
// "Not done" section). On inspection the duplication wasn't actually
// scoped to just the idiom check: `purix audit` (CLI) and `purix_audit`
// (MCP tool) ran the identical three-step sequence — version pinning,
// vuln scan, idiom check, including the exact same "no local ESLint
// binary" / "no manifest-tracked files yet" messages and the same
// Python-vs-TypeScript language-provider dispatch — they only differed in
// where the lines went (console.log directly vs a `lines: string[]`
// buffer joined at the end). That's a formatting difference, not a
// different algorithm, so the whole sequence moves here; only the sink
// (console.log vs push-to-array) stays at each call site.
import { join } from "node:path";
import { checkVersionPinning, runVulnScan, formatVulnScan, type PinningFinding } from "./deps_audit.js";
import { checkIdioms, type IdiomCheckResult } from "../verify/idiom.js";
import { getLanguageProvider } from "../language/registry.js";
import { listManifest } from "../manifest/store.js";

export interface FullAuditResult {
  pinning: PinningFinding[];
  vulnScanFormatted: string;
  trackedFileCount: number;
  idiom: IdiomCheckResult | null; // null when there are no manifest-tracked files to check
}

/**
 * Runs the full `purix audit`/`purix_audit` sequence and returns
 * structured results — no console.log/lines.push here, callers format.
 */
export async function runFullAudit(targetDir: string = process.cwd()): Promise<FullAuditResult> {
  const pinning = await checkVersionPinning(targetDir);
  const vulnScanFormatted = formatVulnScan(runVulnScan(targetDir));

  const trackedPaths = Array.from(new Set(listManifest().flatMap((e) => e.files))).map((f) => join(targetDir, f));
  if (trackedPaths.length === 0) {
    return { pinning, vulnScanFormatted, trackedFileCount: 0, idiom: null };
  }

  const lang = trackedPaths[0]!.endsWith(".py") ? "python" : "typescript";
  const provider = getLanguageProvider(lang);
  const idiom = provider ? provider.checkIdiom(trackedPaths, targetDir) : checkIdioms(trackedPaths, targetDir);
  return { pinning, vulnScanFormatted, trackedFileCount: trackedPaths.length, idiom };
}

/**
 * Renders a FullAuditResult as the exact line sequence both call sites
 * printed before this extraction (verified character-for-character
 * against both originals). Callers join with "\n" (server.ts's textContent
 * style) or console.log each line (observability.ts's style) — both are
 * equivalent given LF joins, so this returns lines rather than picking one.
 */
export function formatFullAuditLines(result: FullAuditResult): string[] {
  const lines: string[] = [];

  lines.push(`Version pinning:`);
  if (result.pinning.length === 0) lines.push("  all dependencies exactly pinned.");
  for (const f of result.pinning) lines.push(`  ${f.section}: ${f.name}@${f.declaredRange} — ${f.reason}`);

  lines.push(``, `Vuln scan:`);
  lines.push(result.vulnScanFormatted);

  lines.push(``, `Idiom check (soft-fail — flags for cleanup, never blocks):`);
  if (result.idiom === null) {
    lines.push("  no manifest-tracked files yet.");
  } else if (!result.idiom.ran) {
    lines.push("  skipped — no local ESLint binary + config found in this project.");
  } else if (result.idiom.findings.length === 0) {
    lines.push("  clean — no idiom findings across all tracked components.");
  } else {
    for (const f of result.idiom.findings) lines.push(`  ${f.path}:${f.line} [${f.rule}] ${f.message}`);
  }

  return lines;
}
