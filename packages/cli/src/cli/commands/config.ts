// packages/cli/src/cli/commands/config.ts
//
// Part 2: `purix config set/get/delete`, backed by the new generic
// project-local key-value store in packages/core/src/state/config.ts.
import type { Command } from "commander";

async function loadConfigRuntime() {
  const configModule = await import("@purix/core/state/config");
  return { config: configModule.config };
}

export function registerConfigCommands(program: Command) {
  const configCmd = program.command("config").description("Read or change local Purix configuration for this project");

  configCmd
    .command("set <key> <value>")
    .description("Set a config value (e.g. `purix config set show-savings off`)")
    .action(async (key: string, value: string) => {
      const runtime = await loadConfigRuntime();
      // Coerce obviously-numeric/boolean-looking values so, e.g.,
      // `purix config set milestone-threshold 100` is stored as a number,
      // not the literal string "100" — matters for the milestone-upsell
      // comparison in lifecycle.ts.
      let coerced: string | number | boolean = value;
      if (value === "true" || value === "false") coerced = value === "true";
      else if (value !== "" && !Number.isNaN(Number(value))) coerced = Number(value);

      runtime.config.set(key, coerced);
      console.log(`✅ ${key} = ${coerced}`);
    });

  configCmd
    .command("get <key>")
    .description("Show a config value")
    .action(async (key: string) => {
      const runtime = await loadConfigRuntime();
      const value = runtime.config.get(key);
      console.log(value === undefined ? `(not set)` : String(value));
    });

  configCmd
    .command("delete <key>")
    .description("Remove a config override, reverting to the default")
    .action(async (key: string) => {
      const runtime = await loadConfigRuntime();
      runtime.config.delete(key);
      console.log(`✅ ${key} reset to default.`);
    });
}
