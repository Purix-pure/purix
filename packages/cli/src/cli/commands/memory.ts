// src/cli/commands/memory.ts
import type { Command } from "commander";

export function registerMemoryCommands(program: Command) {
  program
    .command("remember <note>")
    .description("Record a convention or decision into Repository Memory")
    .option("-c, --component <componentId>", "scope this note to one component instead of the whole repo")
    .action(async (note: string, opts: { component?: string }) => {
      const { recordMemory, GLOBAL_SCOPE } = await import("@purix/core/manifest/memory");
      recordMemory({ component_id: opts.component ?? GLOBAL_SCOPE, kind: "decision", summary: note });
      console.log(opts.component ? `✅ Recorded under "${opts.component}".` : `✅ Recorded as a repo-wide convention.`);
    });
}