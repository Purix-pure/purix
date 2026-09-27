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

export function registerIndexCommands(program: Command) {
  program
    .command("index [path]")
    .description("Index codebase components, verify in sandbox, and sync manifest/components.json")
    .option("--full", "perform a full re-index with tier gating confirmation")
    .option("--incremental", "perform incremental indexing of modified files")
    // Only "typescript" and "python" are supported in this beta (see
    // BETA_SCOPE.md); advertising go/rust/ruby here would silently match
    // zero components rather than erroring, since the indexer's own
    // language detection never produces those values anymore.
    .option("--languages <langs>", "comma-separated list of languages to index (e.g. typescript,python)")
    .action(async (pathArg: string | undefined, opts: { full?: boolean; incremental?: boolean; languages?: string }) => {
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
          const approved = await runtime.confirmGated(
            `Perform full re-index of "${baseDir}"?`,
            "purix_index_full",
            null
          );
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
          console.log(`✅ Successfully indexed ${result.componentCount} components across ${result.fileCount} files. Components synced to .purix/components.json`);
        }
      } catch (err) {
        console.error(`\n🛑 Indexing failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
