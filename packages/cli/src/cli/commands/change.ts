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
import { addOverrideOptions, resolveGateOverrides, type OverrideFlagOptions } from "../override_flags.js";

export function registerChangeCommands(program: Command): void {
  addOverrideOptions(
    program
      .command("change <intent>")
      .description("Describe a change in plain words; Purix finds the component and applies it (or proposes a new one)")
      .option("--component <id>", "Skip matching and change this exact component")
  )
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
    .action(async (intent: string, opts: OverrideFlagOptions & { component?: string; dryRun?: boolean }) => {
      // F03-09: refuse the retired --override (and an empty reason) before the model-assisted matching below costs anything.
      try {
        resolveGateOverrides(opts);
      } catch (err) {
        console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }
      if (intent.trim().length === 0) {
        console.error('Describe the change, e.g. purix change "add retry to the api client".');
        process.exitCode = 1;
        return;
      }
      try {
        const [{ listManifest, storeExists }, { resolveChangeTarget }, { describeMatch }, { extractMentionCandidates }, { deriveComponentName }, { promptLine }] =
          await Promise.all([
            import("@purix/core/manifest/store"),
            import("@purix/core/manifest/change_target"),
            import("@purix/core/manifest/resolver"),
            import("@purix/core/llm/classify"),
            import("@purix/core/manifest/mentions"),
            import("@purix/core/cli-io/confirm"),
          ]);

        // Pass 1 is fully deterministic (zero LLM cost). The LLM-assisted
        // spelling extractor only runs if nothing matched AND nothing in the
        // intent names an indexed-but-unowned file we could offer to adopt.
        const { lookupAdoptable } = await import("@purix/core/manifest/adopt");
        const { extractMentions } = await import("@purix/core/manifest/mentions");
        // Nothing tracked yet (a new folder): there is nothing to match, so do not open a store just to read it and
        // do not pay for the model-assisted matching below. The request goes straight to the new-component path.
        const manifest = storeExists() ? listManifest() : [];
        let result = await resolveChangeTarget({ intent, manifest, componentId: opts.component });
        let adoptable: ReturnType<typeof lookupAdoptable> | undefined;
        if (result.outcome === "none") {
          adoptable = extractMentions(intent)
            .map((m) => lookupAdoptable(m, manifest, process.cwd()))
            .find((r) => r.outcome === "adoptable");
          if (!adoptable && manifest.length > 0) {
            result = await resolveChangeTarget({ intent, manifest, extractWithLlm: extractMentionCandidates });
          }
        }

        if (result.outcome === "single") {
          const why = result.source === "override" ? "via --component" : describeMatch(result.target);
          console.log(`Target: ${result.target.componentId} (${why})`);
          await runModify(result.target.componentId, intent, { overrideBudget: opts.overrideBudget, overrideSecurity: opts.overrideSecurity, overrideTrust: opts.overrideTrust, dryRun: opts.dryRun });
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
          await runModify(chosen.componentId, intent, { overrideBudget: opts.overrideBudget, overrideSecurity: opts.overrideSecurity, overrideTrust: opts.overrideTrust, dryRun: opts.dryRun });
          return;
        }

        // Nothing owns a mentioned file yet — but it is indexed. Offer to adopt
        // it rather than proposing a duplicate new component.
        if (adoptable && adoptable.outcome === "adoptable") {
          console.log(`"${adoptable.file}" is indexed but not yet a component, so it can't be changed directly.`);
          if (opts.dryRun) {
            console.log(`Dry run — a real run would offer to adopt it first (purix adopt ${adoptable.file}).`);
            return;
          }
          const answer = await promptLine(`Register it as a component now and continue? [y/N] `);
          if (answer === null || !/^y(es)?$/i.test(answer.trim())) {
            console.log(`Nothing changed. To do it yourself: purix adopt ${adoptable.file}`);
            return;
          }
          const { runAdopt } = await import("./adopt.js");
          const adopted = await runAdopt(adoptable.file);
          if (!adopted.ok || !adopted.componentId) {
            console.error(`\n🛑 ${adopted.message}`);
            process.exitCode = 1;
            return;
          }
          console.log(`Target: ${adopted.componentId} (adopted ${adoptable.file})`);
          await runModify(adopted.componentId, intent, { overrideBudget: opts.overrideBudget, overrideSecurity: opts.overrideSecurity, overrideTrust: opts.overrideTrust, dryRun: opts.dryRun });
          return;
        }

        console.log(
          manifest.length === 0
            ? "Nothing is tracked here yet — starting a new component from this request."
            : "No existing component matches this — proposing a new one instead.",
        );
        await runCreate(deriveComponentName(intent), { intent, dryRun: opts.dryRun });
      } catch (err) {
        console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}