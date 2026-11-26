// packages/cli/src/cli/commands/lookup.ts
//
// `purix lookup`: the switch for the check of packages a change adds (does the name exist, is there a known advisory). Off until a person
// turns it on, because it sends package names and exact versions off the machine. The answer is kept in the user folder (~/.purix), so
// it is one choice for every project. PURIX_DEP_LOOKUP, when set, overrides it; in CI only the variable counts.
import type { Command } from "commander";

export function registerLookupCommands(program: Command) {
  const cmd = program.command("lookup").description("Turn the check of newly added packages on or off (off by default; it sends package names off this machine)");

  cmd
    .command("status")
    .description("Show whether the package lookup is on, why, and exactly what it sends")
    .action(async () => {
      const { readLookupSetting, LOOKUP_DISCLOSURE } = await import("@purix/core/security/dep_lookup_setting");
      const { depLookupMode } = await import("@purix/core/security/dep_lookup");
      const stored = readLookupSetting();
      const mode = depLookupMode();
      const variable = (process.env["PURIX_DEP_LOOKUP"] ?? "").trim();
      const now = mode.osv || mode.registry;
      const why = variable !== "" ? `PURIX_DEP_LOOKUP=${variable} decides it` : process.env["CI"] && stored.state === "on" ? "your setting is on, but it is ignored in CI (name PURIX_DEP_LOOKUP there on purpose)" : stored.state === "unset" ? "you have not been asked or decided yet" : `your setting (${stored.state}${stored.decidedAt ? `, ${stored.decidedAt.slice(0, 10)}` : ""})`;
      console.log(`Package lookup:   ${now ? `on (${[mode.registry ? "registry" : "", mode.osv ? "OSV" : ""].filter(Boolean).join(" and ")})` : "off"}`);
      console.log(`Because:          ${why}`);
      console.log(`\n${LOOKUP_DISCLOSURE}`);
    });

  cmd
    .command("on")
    .description("Allow the lookup of packages a change adds")
    .action(async () => {
      const { setLookupSetting, LOOKUP_DISCLOSURE } = await import("@purix/core/security/dep_lookup_setting");
      setLookupSetting("on");
      console.log("Package lookup is on for every project on this machine.\n");
      console.log(LOOKUP_DISCLOSURE);
    });

  cmd
    .command("off")
    .description("Never look up packages")
    .action(async () => {
      const { setLookupSetting } = await import("@purix/core/security/dep_lookup_setting");
      setLookupSetting("off");
      console.log("Package lookup is off. Nothing about your packages is sent.");
    });
}
