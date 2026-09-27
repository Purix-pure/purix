// packages/cli/src/cli/commands/change.ts
//
// `purix change "<intent>"` (IDEA-078): say what you want changed in plain
// words; Purix works out which component you mean, then runs the existing
// modify pipeline against it (or, if nothing matches, proposes a new
// component through the existing create pipeline). Resolution is
// deterministic and shared with the MCP `purix_change` tool
// (core/manifest/change_target.ts). Delete is deliberately NOT reachable
// from here — it stays `purix delete <exact-id>` and is never inferred.
import type { Command } from "commander";
import { runCreate, runModify } from "./lifecycle.js";

export function registerChangeCommands(program: Command): void {
  program
    .command("change <intent>")
    .description("Describe a change in plain words; Purix finds the component and applies it (or proposes a new one)")
    .option("--component <id>", "Skip matching and change this exact component")
    .option("--override <reason>", "Override gate stops with a reason (same as `modify --override`)")
    .option("-n, --dry-run", "Resolve the target, run planning and verification, show the diff, then stop (writes nothing)")
    .addHelpText(
      "after",
      `
Examples:
  $ purix change "round invoice totals in billing-service to 2 decimals"
  $ purix change "add retry to src/api/client.ts" --dry-run
  $ purix change "tighten validation" --component signup-form
`
    )
    .action(async (intent: string, opts: { component?: string; override?: string; dryRun?: boolean }) => {
      if (intent.trim().length === 0) {
        console.error('Describe the change, e.g. purix change "add retry to the api client".');
        process.exitCode = 1;
        return;
      }
      try {
        const [{ listManifest }, { resolveChangeTarget }, { describeMatch }, { extractMentionCandidates }, { deriveComponentName }, { promptLine }] =
          await Promise.all([
            import("@purix/core/manifest/store"),
            import("@purix/core/manifest/change_target"),
            import("@purix/core/manifest/resolver"),
            import("@purix/core/llm/classify"),
            import("@purix/core/manifest/mentions"),
            import("@purix/core/cli-io/confirm"),
          ]);

        const result = await resolveChangeTarget({
          intent,
          manifest: listManifest(),
          componentId: opts.component,
          extractWithLlm: extractMentionCandidates,
        });

        if (result.outcome === "single") {
          const why = result.source === "override" ? "via --component" : describeMatch(result.target);
          console.log(`Target: ${result.target.componentId} (${why})`);
          await runModify(result.target.componentId, intent, { override: opts.override, dryRun: opts.dryRun });
          return;
        }

        if (result.outcome === "multiple") {
          console.log("More than one component could be meant:");
          result.candidates.forEach((c, i) => console.log(`  ${i + 1}. ${c.componentId} (${describeMatch(c)})`));
          const answer = await promptLine(`Choose 1-${result.candidates.length} (Enter to cancel): `);
          const picked = answer === null ? NaN : Number.parseInt(answer.trim(), 10);
          const chosen = Number.isInteger(picked) ? result.candidates[picked - 1] : undefined;
          if (!chosen) {
            console.error(
              answer === null || answer.trim() === ""
                ? "No choice made — nothing changed. To skip this question, re-run with --component <id>."
                : `"${answer.trim()}" is not one of 1-${result.candidates.length} — nothing changed.`
            );
            process.exitCode = 1;
            return;
          }
          console.log(`Target: ${chosen.componentId} (chosen from ${result.candidates.length} matches)`);
          await runModify(chosen.componentId, intent, { override: opts.override, dryRun: opts.dryRun });
          return;
        }

        console.log("No existing component matches this — proposing a new one instead.");
        await runCreate(deriveComponentName(intent), { intent, dryRun: opts.dryRun });
      } catch (err) {
        console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}