// src/cli/commands/index.ts
import type { Command } from "commander";
import { resolve } from "node:path";

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
    .option("--languages <langs>", "comma-separated list of languages to index (e.g. ts,py,go,rust,ruby)")
    .action(async (pathArg: string | undefined, opts: { full?: boolean; incremental?: boolean; languages?: string }) => {
      try {
        const runtime = await loadIndexRuntime();
        const baseDir = pathArg ? resolve(process.cwd(), pathArg) : process.cwd();
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
          languages: opts.languages ? opts.languages.split(",") : undefined,
        });
        console.log(`✅ Successfully indexed ${result.componentCount} components across ${result.fileCount} files. Components synced to .purix/components.json`);
      } catch (err) {
        console.error(`\n🛑 Indexing failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}
