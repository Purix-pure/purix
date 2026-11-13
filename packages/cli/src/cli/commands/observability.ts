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
      const { listManifest, storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
      const { splitIndexRow, indexedFilesLine } = await import("./status_index_line.js");
      // D-b: the aggregate index row is shown as one "indexed files" line, not as a component.
      const { components: all, indexRow } = splitIndexRow(listManifest());
      const indexedLine = indexedFilesLine(indexRow);
      if (all.length === 0) {
        console.log("No components registered yet. Run \"purix create <name>\".");
        if (indexedLine) console.log(indexedLine);
        return;
      }
      const { storedStatusLabel, notTestedBadge } = await import("@purix/core/verify/outcome");
      const { latestNotTestedByComponent, latestSearchCutFilesByComponent } = await import("@purix/core/manifest/not_tested");
      const notTested = latestNotTestedByComponent();
      const searchCut = latestSearchCutFilesByComponent();
      // F04-04: a row whose latest pass followed an edit that kept the rest of a line says so, like a not-tested gap does.
      const { latestPartialLineByComponent } = await import("@purix/core/manifest/not_tested");
      const { partialLineBadge } = await import("@purix/core/verify/partial_line_record");
      const partialLine = latestPartialLineByComponent();
      for (const e of all) {
        const fileCount = e.files?.length ?? 0;
        const gap = notTested.get(e.component_id);
        const gapNote = gap ? `  ⚠ ${notTestedBadge(gap, { searchCut: searchCut.has(e.component_id), ...(searchCut.get(e.component_id) ? { cutFiles: searchCut.get(e.component_id)! } : {}) })}` : "";
        const partial = partialLine.get(e.component_id);
        const partialNote = partial && e.verification_status === "pass" ? `  ⚠ ${partialLineBadge(partial)}` : "";
        console.log(`${e.component_id}  v${e.current_version}  [${storedStatusLabel(e.verification_status)}]  (${fileCount} file(s))${gapNote}${partialNote}`);
      }
      if (indexedLine) console.log(indexedLine);
    });

  program
    .command("library")
    .description("Show the self-extending local operation library")
    .action(async () => {
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
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
    .option("--calls", "per call type and per model: count, median tokens, estimate-to-actual ratio, retry and format-error share, plus repair rounds to a fix (sizes only, never prompt text)")
    .action(async (opts: { calls?: boolean }) => {
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      const { usageSummaryLines } = await import("@purix/core/usage/summary");
      if (opts.calls) {
        if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
        const { buildCallReport, formatCallReport } = await import("@purix/core/llm/call_log");
        const callReport = buildCallReport();
        console.log(formatCallReport(callReport));
        // AI-16: the repair success-by-round curve, from the events table, with the recorded spend of the repair call type.
        const { listEvents } = await import("@purix/core/manifest/events");
        const { buildRepairCurve, formatRepairCurve } = await import("@purix/core/manifest/repair_curve");
        const repairRow = callReport.byType.find((t) => t.callType === "repair");
        console.log(formatRepairCurve(buildRepairCurve(listEvents()), repairRow ? { calls: repairRow.count, costUsd: repairRow.costUsd } : undefined));
        return;
      }
      if (!storeExists()) {
        console.log(NO_STATE_MESSAGE);
      } else {
        const { buildObservabilityReport, formatObservabilityReport } = await import("@purix/core/manifest/observability");
        const report = buildObservabilityReport();
        console.log(formatObservabilityReport(report));
      }
      // The local usage ledger (closed schema, this machine only) feeds the stats view.
      const usage = usageSummaryLines();
      if (usage.length > 0) console.log(`\n${usage.join("\n")}`);
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
          const { readManifest, storeExists: hasStore } = await import("@purix/core/manifest/store");
          if (!hasStore()) throw new Error(`No manifest entry for "${opts.component}" (no Purix state here yet).`);
          if (!readManifest(opts.component)) throw new Error(`No manifest entry for "${opts.component}". Run "purix status" to see what's tracked.`);
        }
        const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
        if (!storeExists()) { console.error(NO_STATE_MESSAGE); return; }
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
    .description("Verify the local tamper-evident audit chain, and check it against the head recorded in a git commit")
    .option("--commit <ref>", "check against the Purix-Evidence trailer of this commit (default: the newest commit that has one)")
    .option("--expect-head <hash>", "check against this chain head (sha256:<hex>) instead of reading git")
    .option("--require-anchor", "exit with an error when nothing anchors the end of the chain (for CI)")
    .action(async (opts: { commit?: string; expectHead?: string; requireAnchor?: boolean }) => {
      const { inspectStore, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      const inspected = inspectStore();
      if (inspected.state === "absent") { console.log(NO_STATE_MESSAGE); return; }
      if (inspected.state === "damaged") {
        // A tamper-evidence check must never rebuild the store it is checking.
        const { describeStoreProblem } = await import("@purix/core/platform/disk_full");
        const { storeDirectory } = await import("@purix/core/manifest/store");
        console.error(`🛑 Audit chain cannot be verified: ${describeStoreProblem(inspected.detail, storeDirectory())} Nothing was changed or rebuilt.`);
        process.exitCode = 1;
        return;
      }
      const { readAuditChain } = await import("@purix/core/security/audit_tamper_evidence");
      const { findAnchorInGit, judgeChain, describeVerdict, parseSuppliedHead } = await import("@purix/core/evidence/anchor");
      let lookup: import("@purix/core/evidence/anchor").AnchorLookup;
      if (opts.expectHead !== undefined) {
        const head = parseSuppliedHead(opts.expectHead);
        if (!head) {
          console.error(`🛑 --expect-head must be sha256:<64 hex characters> (the Purix-Evidence value from a commit).`);
          process.exitCode = 1;
          return;
        }
        lookup = { found: true, anchor: { head, source: "supplied" } };
      } else {
        lookup = findAnchorInGit(process.cwd(), { ref: opts.commit, exact: opts.commit !== undefined });
      }
      const { rows, checkpoint } = readAuditChain();
      const verdict = judgeChain(rows, checkpoint, lookup);
      const text = describeVerdict(verdict);
      if (verdict.state === "failed") {
        console.error(`🛑 Audit chain ${text}`);
        process.exitCode = 1;
        return;
      }
      if (verdict.state === "not_anchored") {
        if (verdict.recordCount === 0) {
          console.log("Audit chain is empty (0 records) — nothing to verify yet.");
          return;
        }
        // An explicitly requested anchor that cannot be read is an error, not a shrug.
        const mustFail = opts.requireAnchor === true || opts.commit !== undefined;
        (mustFail ? console.error : console.warn)(`${mustFail ? "🛑" : "⚠"} Audit chain ${text}`);
        if (mustFail) process.exitCode = 1;
        return;
      }
      console.log(`✅ Audit chain ${text}`);
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