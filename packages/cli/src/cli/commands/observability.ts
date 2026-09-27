// src/cli/commands/observability.ts
import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { getRecentLogs, redactLogContent } from "../../telemetry/log.js";

export function registerObservabilityCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // status / library / stats / audit / audit-trail
  // ---------------------------------------------------------------------------
  program
    .command("status")
    .description("List all manifest components")
    .action(async () => {
      const { listManifest } = await import("@purix/core/manifest/store");
      const all = listManifest();
      if (all.length === 0) {
        console.log("No components registered yet. Run \"purix create <name>\".");
        return;
      }
      for (const e of all) {
        const fileCount = e.files?.length ?? 0;
        console.log(`${e.component_id}  v${e.current_version}  [${e.verification_status}]  (${fileCount} file(s))`);
      }
    });

  program
    .command("library")
    .description("Show the self-extending local operation library")
    .action(async () => {
      const { listLibrary } = await import("@purix/core/manifest/library");
      const entries = listLibrary();
      if (entries.length === 0) {
        console.log("Library is empty — nothing has been promoted from escalation yet.");
        return;
      }
      for (const e of entries) {
        console.log(`${e.component_id}  ${e.operation}  used ${e.usage_count}x  — ${e.description}`);
      }
    });

  program
    .command("stats")
    .description("§10 Observability: measured metrics (escalation rate, confidence trend, failure clustering, test-integrity/coverage flag rates, approval fatigue, library growth)")
    .action(async () => {
      const { buildObservabilityReport, formatObservabilityReport } = await import("@purix/core/manifest/observability");
      const report = buildObservabilityReport();
      console.log(formatObservabilityReport(report));
    });

  program
    .command("audit")
    .description("Dependency pinning + vuln scan + idiom check")
    .action(async () => {
      try {
        // DUPLICATION FIX (audit finding 2.3, finalized here — the
        // duplication-finder pass had extracted resolveVerification()/
        // requireGatedApproval() but left this one as "not done"): the
        // whole version-pinning + vuln-scan + idiom-check sequence, not
        // just the idiom part, was duplicated verbatim against
        // mcp-server/server.ts's purix_audit tool. Both now call the same
        // runFullAudit()/formatFullAuditLines() — only the sink differs
        // (console.log per line here; a joined string over there).
        const { runFullAudit, formatFullAuditLines } = await import("@purix/core/security/full_audit");
        const result = await runFullAudit(process.cwd());
        for (const line of formatFullAuditLines(result)) console.log(line);
      } catch (err) {
        console.error(`\n🛑 Audit failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): the old
  // "audit-trail" and "audit-verify" genuinely shared one resource (the
  // compliance audit log/chain) and are grouped here as verbs on it.
  // Deliberately named "audit-log", NOT "audit" — "audit" already exists
  // above as a flat command, and it's a different concept entirely (a
  // dependency-pinning/vuln/idiom scan, closer to `npm audit` than to a
  // compliance log). Reusing "audit" as this group's noun too would
  // recreate the exact "don't have ambiguous or similarly-named commands"
  // problem clig.dev warns about — confirmed directly from these two
  // commands' own descriptions before deciding this, not assumed from the
  // shared word. See security.ts's matching comment for the standard and
  // why this rename is safe pre-release.
  const auditLogCmd = program.command("audit-log").description("Compliance audit-trail export and tamper-evidence verification");

  auditLogCmd
    .command("trail")
    .description("Compliance audit-trail export — one row per landed commit, joined with gate evidence")
    .option("-c, --component <componentId>", "filter to one component")
    .option("-s, --since <isoTimestamp>", "only include commits at or after this ISO timestamp")
    .option("-f, --format <format>", "output format: markdown or json", "markdown")
    .option("-o, --out <file>", "write to a file instead of stdout")
    .action(async (opts: { component?: string; since?: string; format?: string; out?: string }) => {
      try {
        const { requireEntitlement } = await import("@purix/core/licensing/tier");
        const { buildAuditTrail, formatAuditTrailJson, formatAuditTrailMarkdown } = await import("@purix/core/manifest/audit_export");
        requireEntitlement("auditExport");
        // TEST-REPORT F12: unknown formats fell back to markdown, and an unparseable --since silently matched nothing.
        if (opts.format !== undefined && opts.format !== "json" && opts.format !== "markdown") {
          throw new Error(`Unknown --format "${opts.format}". Use "markdown" or "json".`);
        }
        if (opts.since !== undefined && Number.isNaN(Date.parse(opts.since))) {
          throw new Error(`--since "${opts.since}" is not a valid ISO timestamp (e.g. 2026-09-01 or 2026-09-01T12:00:00Z).`);
        }
        if (opts.component) {
          const { readManifest } = await import("@purix/core/manifest/store");
          if (!readManifest(opts.component)) throw new Error(`No manifest entry for "${opts.component}". Run "purix status" to see what's tracked.`);
        }
        const format = opts.format === "json" ? "json" : "markdown";
        const report = buildAuditTrail({ componentId: opts.component, since: opts.since });
        const output = format === "json" ? formatAuditTrailJson(report) : formatAuditTrailMarkdown(report);
        if (opts.out) {
          await writeFile(opts.out, output, "utf-8");
          console.log(`✅ Wrote ${report.entries.length} entr${report.entries.length === 1 ? "y" : "ies"} to ${opts.out} (${format}).`);
        } else {
          console.log(output);
        }
      } catch (err) {
        console.error(`\n🛑 Failed to export audit-trail: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });

  auditLogCmd
    .command("verify")
    .description("Verify local tamper-evident audit chain integrity")
    .action(async () => {
      const { verifyAuditChain } = await import("@purix/core/security/audit_tamper_evidence");
      const result = verifyAuditChain();
      if (!result.valid) {
        console.error(`🛑 Audit chain verification failed at record index ${result.compromisedIndex ?? "unknown"}: ${result.reason}`);
        process.exitCode = 1;
        return;
      }
      // TEST-REPORT F16: success used to print nothing at all, so "verified"
      // and "did nothing" looked identical (and the MCP tool already said "passed").
      console.log(
        result.recordCount === 0
          ? "Audit chain is empty (0 records) — nothing to verify yet."
          : `Audit chain verification passed — ${result.recordCount ?? "all"} record(s), no tampering detected.`
      );
    });

  program
    .command("diagnostics")
    .description("Review recent local diagnostics/error logs with automatic path/secret redaction")
    .action(() => {
      const logs = getRecentLogs(30);
      if (logs.length === 0) {
        console.log("No recent diagnostic logs found in ~/.purix/logs/.");
        return;
      }
      console.log("Recent diagnostic logs (redacted for privacy):");
      for (const line of logs) {
        console.log(redactLogContent(line));
      }
    });
}