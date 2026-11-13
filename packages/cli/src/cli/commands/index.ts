// src/cli/commands/index.ts
import type { Command } from "commander";
import { resolve } from "node:path";
import { existsSync, statSync } from "node:fs";

// Only these are indexable in this beta (see BETA_SCOPE.md and the --languages help text).
const INDEXABLE_LANGUAGES = ["typescript", "python"];

async function loadIndexRuntime() {
  const [indexerModule, gatedConfirmModule] = await Promise.all([
    import("@purix/core/manifest/indexer"),
    import("@purix/core/cli-io/gated-confirm"),
  ]);

  return {
    runIndex: indexerModule.runIndex,
    confirmGated: gatedConfirmModule.confirmGated,
  };
}

/**
 * What `purix index` tells the person when it finishes. Indexing lists files and records their symbols; it compiles and tests
 * nothing, so it must never read as a verification result. A file is verified the first time it is changed through Purix.
 */
export function indexSummaryLines(result: { componentCount: number; fileCount: number; unsupportedFileCount: number; fileListSource?: "git" | "walk" }): string[] {
  const lines = [
    `✅ Indexed ${result.componentCount} components across ${result.fileCount} files. Components synced to .purix/components.json`,
    `   Indexed, not verified: nothing was compiled or tested. Purix verifies a file the first time you change it (purix modify or purix change).`,
  ];
  if (result.fileListSource === "walk") {
    lines.push(`   File list: a folder walk, because this is not inside a git repository (or git could not run). It skips folders named build and dist, and reads .gitignore only as literal paths. Inside a git repository the list is git's own.`);
  }
  if (result.unsupportedFileCount > 0) {
    lines.push(`   ${result.unsupportedFileCount} file(s) in languages Purix has no verifier for were left out of the index.`);
  }
  return lines;
}

export function registerIndexCommands(program: Command) {
  program
    .command("index [path]")
    .description("Index codebase components (symbols only: nothing is compiled or tested) and sync manifest/components.json")
    .option("--full", "perform a full re-index with tier gating confirmation")
    .option("-y, --yes", "pre-answer this command's advisory prompt (also PURIX_YES=1); never affects diff approval on create/modify/change")
    .option("--incremental", "accepted for compatibility; has no effect, because every run re-reads all files (it no longer compiles anything, so a full run is fast)")
    // Only "typescript" and "python" are supported in this beta (see
    // BETA_SCOPE.md); advertising go/rust/ruby here would silently match
    // zero components rather than erroring, since the indexer's own
    // language detection never produces those values anymore.
    .option("--languages <langs>", "comma-separated list of languages to index (e.g. typescript,python)")
    .action(async (pathArg: string | undefined, opts: { full?: boolean; incremental?: boolean; languages?: string; yes?: boolean }) => {
      try {
        const runtime = await loadIndexRuntime();
        const baseDir = pathArg ? resolve(process.cwd(), pathArg) : process.cwd();
        // TEST-REPORT F12: a nonexistent path or an unknown language used to
        // "succeed" with "Successfully indexed 0 components".
        if (!existsSync(baseDir) || !statSync(baseDir).isDirectory()) {
          console.error(`\n🛑 "${baseDir}" is not an existing directory — nothing was indexed.`);
          process.exitCode = 1;
          return;
        }
        if (opts.languages) {
          const requested = opts.languages.split(",").map((l) => l.trim()).filter(Boolean);
          const unknown = requested.filter((l) => !INDEXABLE_LANGUAGES.includes(l));
          if (requested.length === 0 || unknown.length > 0) {
            console.error(
              `\n🛑 Unknown language${unknown.length === 1 ? "" : "s"} for --languages: ${unknown.join(", ") || "(none given)"}. ` +
                `Supported: ${INDEXABLE_LANGUAGES.join(", ")}.`
            );
            process.exitCode = 1;
            return;
          }
        }
        if (opts.full) {
          // --yes / PURIX_YES=1 pre-answers THIS advisory prompt only (the
          // full re-index heads-up). It is recorded in the audit trail as
          // pre-approved, and is deliberately not wired into any
          // create/modify/change approval gate.
          const preApproved = opts.yes === true || process.env.PURIX_YES === "1";
          if (preApproved) {
            const { recordEvent } = await import("@purix/core/manifest/events");
            recordEvent("confirm_response", { component_id: null, detail: { checkpoint_kind: "purix_index_full", approved: true, pre_approved: true } });
          }
          const approved = preApproved
            ? true
            : await runtime.confirmGated(`Perform full re-index of "${baseDir}"?`, "purix_index_full", null);
          if (!approved) {
            console.log("Cancelled.");
            return;
          }
        }
        console.log(`Indexing codebase at "${baseDir}"...`);
        const result = await runtime.runIndex(baseDir, {
          full: opts.full,
          incremental: opts.incremental,
          languages: opts.languages ? opts.languages.split(",").map((l) => l.trim()).filter(Boolean) : undefined,
        });
        if (result.fileCount === 0) {
          console.warn(`⚠ No indexable files were found under "${baseDir}" (check .gitignore/.purixignore and --languages) — 0 components indexed.`);
        } else {
          for (const line of indexSummaryLines(result)) console.log(line);
        }
      } catch (err) {
        console.error(`\n🛑 Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
