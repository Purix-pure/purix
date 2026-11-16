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
  const secretCmd = program.command("secret").description("Manage stored credentials (encrypted file; the key sits beside it, so this keeps secrets out of git, not away from other local users)");

  // A value typed on the command line lands in shell history and in `ps`
  // (clig.dev: "Do not read secrets directly from flags"). So the value is
  // optional: leave it out and Purix asks (hidden prompt) or reads stdin. The
  // argument form still works so existing scripts do not break, but it warns.
  const warnArgvSecret = (verb: string, name: string) => {
    console.error(
      `⚠ A value typed on the command line is saved in your shell history and visible to other users in \`ps\`. ` +
      `Next time run "purix secret ${verb} ${name}" with no value (hidden prompt), or pipe it in: printf %s "$KEY" | purix secret ${verb} ${name}`,
    );
  };
  const obtainValue = async (verb: string, name: string, given: string | undefined): Promise<string | undefined> => {
    if (given !== undefined) { warnArgvSecret(verb, name); return given; }
    const { readSecretValue, SecretInputCancelled } = await import("./secret_input.js");
    try {
      return await readSecretValue(name, { stdin: process.stdin, stderr: process.stderr });
    } catch (e) {
      console.error(e instanceof SecretInputCancelled ? "Cancelled; nothing was stored." : (e as Error).message);
      process.exitCode = e instanceof SecretInputCancelled ? 130 : 1;
      return undefined;
    }
  };

  secretCmd.command("set <name> [value]").description("Store a credential in an encrypted file (the key is stored beside it). Leave [value] out to be asked, or pipe it on stdin; a value on the command line is kept in shell history").action(async (name: string, value: string | undefined) => {
    const { setSecret } = await import("@purix/core/security/secrets_manager");
    const v = await obtainValue("set", name, value);
    if (v === undefined) return;
    setSecret(name, v);
    console.log(`✅ Stored "${name}" encrypted. Remove it from any .env once you've confirmed this works.`);
  });

  secretCmd.command("rotate <name> [newValue]").description("Rotate a stored credential. Leave [newValue] out to be asked, or pipe it on stdin").action(async (name: string, newValue: string | undefined) => {
    const { setSecret, listSecretStatus } = await import("@purix/core/security/secrets_manager");
    // TEST-REPORT F12: rotating a name that was never stored used to print
    // "✅ Rotated" while silently creating it.
    if (!listSecretStatus().some((s) => s.name === name)) {
      console.error(`No secret stored as "${name}" — nothing to rotate. Use "purix secret set ${name}" to create it.`);
      process.exitCode = 1;
      return;
    }
    const v = await obtainValue("rotate", name, newValue);
    if (v === undefined) return;
    setSecret(name, v);
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