// src/cli/commands/tools.ts
import type { Command } from "commander";
import { suggestTools, formatSuggestions } from "@purix/core/tools/matchmaker";

export function registerToolsCommands(program: Command) {
  program
    .command("tools <purpose>")
    .description("Tool Matchmaker: suggest vetted npm packages for a purpose (advisory only, never installs)")
    .action(async (purpose: string) => {
      try {
        console.log(`Searching npm for vetted packages: "${purpose}"...`);
        const suggestions = await suggestTools(purpose);
        console.log(formatSuggestions(suggestions));
      } catch (err) {
        console.error(`\n🛑 Tool search failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
      }
    });
}
