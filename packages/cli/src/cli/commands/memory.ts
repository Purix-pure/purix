// src/cli/commands/memory.ts
import type { Command } from "commander";

export function registerMemoryCommands(program: Command) {
  program
    .command("remember <note>")
    .description("Record a convention or decision into Repository Memory")
    .option("-c, --component <componentId>", "scope this note to one component instead of the whole repo")
    .action(async (note: string, opts: { component?: string }) => {
      const { recordMemory, GLOBAL_SCOPE } = await import("@purix/core/manifest/memory");
      // TEST-REPORT F12: an empty note and a nonexistent component id both used to be recorded with a success message.
      if (note.trim() === "") {
        console.error("The note is empty — nothing was recorded.");
        process.exitCode = 1;
        return;
      }
      if (opts.component) {
        const { readManifest } = await import("@purix/core/manifest/store");
        if (!readManifest(opts.component)) {
          console.error(`No manifest entry for "${opts.component}". Run "purix status" to see what's tracked.`);
          process.exitCode = 1;
          return;
        }
      }
      recordMemory({ component_id: opts.component ?? GLOBAL_SCOPE, kind: "decision", summary: note });
      console.log(opts.component ? `✅ Recorded under "${opts.component}".` : `✅ Recorded as a repo-wide convention.`);
    });
}