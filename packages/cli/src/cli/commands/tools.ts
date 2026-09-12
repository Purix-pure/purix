// src/cli/commands/tools.ts
import type { Command } from "commander";

export function registerToolsCommands(program: Command) {
  program
    .command("tools <purpose>")
    .description("Tool Matchmaker: suggest vetted npm packages for a purpose (advisory only, never installs)")
    .action(async (purpose: string) => {
      try {
        const { suggestTools, formatSuggestions } = await import("@purix/core/tools/matchmaker");
        console.log(`Searching npm for vetted packages: "${purpose}"...`);
        const suggestions = await suggestTools(purpose);
        console.log(formatSuggestions(suggestions));
      } catch (err) {
        console.error(`\n🛑 Tool search failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}
