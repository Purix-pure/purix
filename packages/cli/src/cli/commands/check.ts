// src/cli/commands/check.ts
//
// `purix check`: the one canonical check for a developer, a git pre-commit hook, CI and agent hook adapters.
// Read-only, no model, no network. All the logic is in @purix/core/entrypoints/check; this file only prints.
//
// Exit codes (stable, documented in docs/CHECK.md):
//   0  nothing wrong found (with --strict: and nothing skipped)
//   1  the check found a problem (with --strict: or something was skipped, i.e. not verified)
//   2  the check could not run at all (a crash, a bad option). A caller that must fail closed treats 2 like 1.
import type { Command } from "commander";
import type { CheckReport } from "@purix/core/entrypoints/check";

const MARK: Record<string, string> = { pass: "✅", fail: "🛑", error: "🛑", skipped: "⚠ ", "not-applicable": "  " };

export function renderCheckReport(report: CheckReport): string {
  const lines: string[] = [];
  for (const s of report.sections) {
    lines.push(`${MARK[s.outcome] ?? "  "} ${s.title}`);
    for (const i of s.items) lines.push(`     ${i.subject}: ${i.message}`);
  }
  lines.push("", report.summary);
  if (report.strict && report.outcome === "skipped") lines.push("--strict: skipped items count as failures, so this exits 1.");
  return lines.join("\n");
}

export function registerCheckCommand(program: Command) {
  program
    .command("check")
    .description("Check that governed files still match what Purix recorded and the audit chain is intact (read-only; no model, no network)")
    .option("--strict", "treat skipped items (nothing governed, never synced, pending, or no related test) as failures; use this in CI")
    .option("--json", "print the report as JSON on stdout (schema version 1)")
    .action(async (opts: { strict?: boolean; json?: boolean }) => {
      try {
        const { runCheck } = await import("@purix/core/entrypoints/check");
        const report = runCheck({ baseDir: process.cwd(), strict: Boolean(opts.strict) });
        if (opts.json) process.stdout.write(JSON.stringify(report, null, 2) + "\n");
        else console.log(renderCheckReport(report));
        process.exitCode = report.exitCode;
      } catch (err) {
        // Could not run at all. Exit 2 so a fail-closed caller (hook adapter, CI) can tell "broken" from "found a problem".
        console.error(`🛑 purix check could not run: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
