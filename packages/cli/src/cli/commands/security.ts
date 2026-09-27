// src/cli/commands/security.ts
import type { Command } from "commander";

export function registerSecurityCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // Secrets Manager
  // ---------------------------------------------------------------------------
  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): grouped
  // from four flat, hyphenated top-level commands (secret-set, secret-rotate,
  // secret-remove, secrets-status) into a proper noun-then-verb subcommand
  // group, per clig.dev's own guidance ("if a complex piece of software has
  // lots of objects and operations that can be performed on those objects,
  // it is a common pattern to use two levels of subcommand... where one is a
  // noun and one is a verb" — e.g. docker container create). "secret" is a
  // real resource with four real verbs already, so this was the exact case
  // the standard describes, not a stylistic preference. Purix has not yet
  // had its first public/npm release, so this rename carries no breaking-
  // change cost for real users.
  const secretCmd = program.command("secret").description("Manage stored credentials (encrypted at rest)");

  secretCmd.command("set <name> <value>").description("Store a credential, encrypted at rest").action(async (name: string, value: string) => {
    const { setSecret } = await import("@purix/core/security/secrets_manager");
    setSecret(name, value);
    console.log(`✅ Stored "${name}" encrypted. Remove it from any .env once you've confirmed this works.`);
  });

  secretCmd.command("rotate <name> <newValue>").description("Rotate a stored credential").action(async (name: string, newValue: string) => {
    const { setSecret, listSecretStatus } = await import("@purix/core/security/secrets_manager");
    // TEST-REPORT F12: rotating a name that was never stored used to print
    // "✅ Rotated" while silently creating it.
    if (!listSecretStatus().some((s) => s.name === name)) {
      console.error(`No secret stored as "${name}" — nothing to rotate. Use "purix secret set ${name} <value>" to create it.`);
      process.exitCode = 1;
      return;
    }
    setSecret(name, newValue);
    console.log(`✅ Rotated "${name}".`);
  });

  secretCmd.command("remove <name>").description("Delete a stored credential").action(async (name: string) => {
    const { deleteSecret } = await import("@purix/core/security/secrets_manager");
    console.log(deleteSecret(name) ? `✅ Removed "${name}".` : `No secret stored as "${name}".`);
  });

  secretCmd.command("status").description("Show credential age / rotation status").action(async () => {
    const { listSecretStatus } = await import("@purix/core/security/secrets_manager");
    const statuses = listSecretStatus();
    if (statuses.length === 0) { console.log("No secrets stored yet."); return; }
    for (const s of statuses) {
      const age = s.ageDays === 0 ? "set today" : `set ${s.ageDays}d ago`;
      const rotated = s.rotationCount === 0 ? "never rotated" : `rotated ${s.rotationCount} time${s.rotationCount === 1 ? "" : "s"}`;
      console.log(`${s.name}  ${age}${s.rotationDue ? "  ⚠ ROTATION DUE" : ""}  (${rotated})`);
    }
  });
}