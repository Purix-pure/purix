// src/cli/commands/security.ts
import type { Command } from "commander";
import { setSecret, deleteSecret, listSecretStatus } from "@purix/core/security/secrets_manager";

export function registerSecurityCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // Secrets Manager
  // ---------------------------------------------------------------------------
  program.command("secret-set <n> <value>").description("Store a credential, encrypted at rest").action((name: string, value: string) => {
    setSecret(name, value);
    console.log(`✅ Stored "${name}" encrypted. Remove it from any .env once you've confirmed this works.`);
  });

  program.command("secret-rotate <n> <newValue>").description("Rotate a stored credential").action((name: string, newValue: string) => {
    setSecret(name, newValue);
    console.log(`✅ Rotated "${name}".`);
  });

  program.command("secret-remove <n>").description("Delete a stored credential").action((name: string) => {
    console.log(deleteSecret(name) ? `✅ Removed "${name}".` : `No secret stored as "${name}".`);
  });

  program.command("secrets-status").description("Show credential age / rotation status").action(() => {
    const statuses = listSecretStatus();
    if (statuses.length === 0) { console.log("No secrets stored yet."); return; }
    for (const s of statuses) console.log(`${s.name}  set ${s.ageDays}d ago${s.rotationDue ? "  ⚠ ROTATION DUE" : ""}  (rotated ${s.rotationCount}x before)`);
  });
}