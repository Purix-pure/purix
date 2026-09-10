// packages/cli/src/cli/commands/config.ts
//
// Part 2: `purix config set/get/delete`, backed by the new generic
// project-local key-value store in packages/core/src/state/config.ts.
import type { Command } from "commander";
import { config } from "@purix/core/state/config";

export function registerConfigCommands(program: Command) {
  const configCmd = program.command("config").description("Read or change local Purix configuration for this project");

  configCmd
    .command("set <key> <value>")
    .description("Set a config value (e.g. `purix config set show-savings off`)")
    .action((key: string, value: string) => {
      // Coerce obviously-numeric/boolean-looking values so, e.g.,
      // `purix config set milestone-threshold 100` is stored as a number,
      // not the literal string "100" — matters for the milestone-upsell
      // comparison in lifecycle.ts.
      let coerced: string | number | boolean = value;
      if (value === "true" || value === "false") coerced = value === "true";
      else if (value !== "" && !Number.isNaN(Number(value))) coerced = Number(value);

      config.set(key, coerced);
      console.log(`✅ ${key} = ${coerced}`);
    });

  configCmd
    .command("get <key>")
    .description("Show a config value")
    .action((key: string) => {
      const value = config.get(key);
      console.log(value === undefined ? `(not set)` : String(value));
    });

  configCmd
    .command("delete <key>")
    .description("Remove a config override, reverting to the default")
    .action((key: string) => {
      config.delete(key);
      console.log(`✅ ${key} reset to default.`);
    });
}
