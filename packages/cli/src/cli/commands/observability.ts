// src/cli/commands/observability.ts
import type { Command } from "commander";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
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
        console.log("No components registered yet. Run \"purix create <n>\".");
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
        const { checkVersionPinning, runVulnScan, formatVulnScan } = await import("@purix/core/security/deps_audit");
        const { listManifest } = await import("@purix/core/manifest/store");
        const { getLanguageProvider } = await import("@purix/core/language/registry");
        const { checkIdioms } = await import("@purix/core/verify/idiom");

        const pinning = await checkVersionPinning(process.cwd());
        console.log(`Version pinning:`);
        if (pinning.length === 0) console.log("  all dependencies exactly pinned.");
        for (const f of pinning) console.log(`  ${f.section}: ${f.name}@${f.declaredRange} — ${f.reason}`);

        console.log(`\nVuln scan:`);
        console.log(formatVulnScan(runVulnScan(process.cwd())));

        console.log(`\nIdiom check (soft-fail — flags for cleanup, never blocks):`);
        const trackedPaths = Array.from(new Set(listManifest().flatMap((e) => e.files))).map((f) => join(process.cwd(), f));
        if (trackedPaths.length === 0) {
          console.log("  no manifest-tracked files yet.");
        } else {
          const lang = trackedPaths.length > 0 && trackedPaths[0]!.endsWith(".py") ? "python" : "typescript";
          const provider = getLanguageProvider(lang);
          const idiom = provider ? provider.checkIdiom(trackedPaths, process.cwd()) : checkIdioms(trackedPaths, process.cwd());
          if (!idiom.ran) {
            console.log("  skipped — no local ESLint binary + config found in this project.");
          } else if (idiom.findings.length === 0) {
            console.log("  clean — no idiom findings across all tracked components.");
          } else {
            for (const f of idiom.findings) console.log(`  ${f.path}:${f.line} [${f.rule}] ${f.message}`);
          }
        }
      } catch (err) {
        console.error(`\n🛑 Audit failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("audit-trail")
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
        console.error(`\n🛑 Failed to export audit-trail: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });

  program
    .command("audit-verify")
    .description("Verify local tamper-evident audit chain integrity")
    .action(async () => {
      const { verifyAuditChain } = await import("@purix/core/security/audit_tamper_evidence");
      const result = verifyAuditChain();
      if (!result.valid) {
        console.error(`🛑 Audit chain verification failed at record index ${result.compromisedIndex ?? "unknown"}: ${result.reason}`);
        process.exitCode = 1;
      }
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