// src/cli/commands/memory.ts
import type { Command } from "commander";

export function registerMemoryCommands(program: Command) {
  program
    .command("remember <note>")
    .description("Record a convention or decision into Repository Memory")
    .option("-c, --component <componentId>", "scope this note to one component instead of the whole repo")
    .action(async (note: string, opts: { component?: string }) => {
      const { rememberNote } = await import("@purix/core/manifest/memory");
      // TEST-REPORT F12: an empty note and a nonexistent component id both used to be recorded with a success message.
      // The checks live in rememberNote now, so a person and an agent are refused for the same reasons.
      const res = rememberNote({ note, ...(opts.component ? { componentId: opts.component } : {}), source: "person" });
      if (!res.ok) {
        console.error(res.message);
        process.exitCode = 1;
        return;
      }
      if (res.scrubbedCount > 0) {
        console.warn(`🔒 Redacted ${res.scrubbedCount} secret-shaped value(s) from the note before saving it. Repository Memory is meant for conventions and decisions, not credentials.`);
      }
      console.log(opts.component ? `✅ Recorded under "${opts.component}".` : `✅ Recorded as a repo-wide convention.`);
    });
}