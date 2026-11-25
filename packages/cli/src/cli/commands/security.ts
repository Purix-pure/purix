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
  // real resource with a few real verbs, so this was the exact case
  // the standard describes, not a stylistic preference. Purix has not yet
  // had its first public/npm release, so this rename carries no breaking-
  // change cost for real users.
  //
  // KEY STORE FIX (2026-11-21): credentials are stored once per person, not once per folder. They go in the OS keyring when
  // there is one and in an encrypted file in the user folder when there is not (security/user_secrets.ts). The old per-folder
  // store is still read as a last resort and `purix secret migrate` moves it out.
  const secretCmd = program.command("secret").description("Manage stored credentials. One store per user (OS keyring when available, else an encrypted file in your user folder), not one per folder");

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
  const where = (backend: "keyring" | "file") => (backend === "keyring" ? "your OS keyring" : "an encrypted file in your user folder (the OS keyring was not used; see the notice above)");
  const loadStore = async () => {
    const { createUserSecrets } = await import("@purix/core/security/user_secrets");
    return createUserSecrets();
  };

  secretCmd.command("set <name> [value]").description("Store a credential for your user account. Leave [value] out to be asked, or pipe it on stdin; a value on the command line is kept in shell history. Refuses a name Purix does not read, a credential that is already stored (use rotate), and a key that conflicts with the environment").action(async (name: string, value: string | undefined) => {
    const { checkSecretSet, defaultGuardContext } = await import("@purix/core/security/credential_guard");
    const store = await loadStore();
    // Name and stored-state checks first, so a person is not asked to type a key that would be refused anyway. The value is checked again once it is in hand.
    const early = checkSecretSet(name, "x", defaultGuardContext(process.cwd(), store));
    if (!early.ok && !/^The value /.test(early.reason)) { console.error(`🛑 ${early.reason}`); process.exitCode = 1; return; }
    const v = await obtainValue("set", name, value);
    if (v === undefined) return;
    const verdict = checkSecretSet(name, v, defaultGuardContext(process.cwd(), store));
    if (!verdict.ok) { console.error(`🛑 ${verdict.reason}`); process.exitCode = 1; return; }
    try {
      const { backend } = store.set(name, v);
      console.log(`✅ Stored "${name}" (${v.length} characters) in ${where(backend)}. It is found from any folder.`);
    } catch (e) {
      console.error(`🛑 ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    for (const note of verdict.notes) console.log(`   ${note}`);
  });

  secretCmd.command("rotate <name> [newValue]").description("Replace a stored credential with a new key. Leave [newValue] out to be asked, or pipe it on stdin").action(async (name: string, newValue: string | undefined) => {
    const { checkSecretRotate, defaultGuardContext } = await import("@purix/core/security/credential_guard");
    const store = await loadStore();
    // TEST-REPORT F12: rotating a name that was never stored used to print "✅ Rotated" while silently creating it.
    const early = checkSecretRotate(name, "x", defaultGuardContext(process.cwd(), store));
    if (!early.ok && !/^The value /.test(early.reason)) { console.error(`🛑 ${early.reason}`); process.exitCode = 1; return; }
    const v = await obtainValue("rotate", name, newValue);
    if (v === undefined) return;
    const verdict = checkSecretRotate(name, v, defaultGuardContext(process.cwd(), store));
    if (!verdict.ok) { console.error(`🛑 ${verdict.reason}`); process.exitCode = 1; return; }
    try {
      const { backend } = store.set(name, v);
      console.log(`✅ Rotated "${name}" (${v.length} characters), now in ${where(backend)}. Purix does not check the key with the provider; the first model call will.`);
    } catch (e) {
      console.error(`🛑 ${(e as Error).message}`);
      process.exitCode = 1;
    }
  });

  secretCmd.command("remove <name>").description("Delete a stored credential (from your user-level store and from the old per-folder store)").action(async (name: string) => {
    const { deleteSecret } = await import("@purix/core/security/secrets_manager");
    const store = await loadStore();
    let removedUser = false;
    try {
      removedUser = store.remove(name);
    } catch (e) {
      console.error(`🛑 ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    let removedOld = false;
    try {
      removedOld = deleteSecret(name);
    } catch { /* an unreadable old store is left alone; status says so */ }
    if (!removedUser && !removedOld) { console.log(`No secret stored as "${name}".`); return; }
    console.log(`✅ Removed "${name}"${removedUser ? " from your user-level store" : ""}${removedUser && removedOld ? " and" : ""}${removedOld ? " from the old per-folder store" : ""}.`);
  });

  secretCmd.command("status").description("Show where credentials are kept, their age and size, and any problem (an entry Purix never reads, or a stored key that differs from the environment)").action(async () => {
    const { listSecretStatus: listOld } = await import("@purix/core/security/secrets_manager");
    const { auditStoredSecrets, defaultGuardContext } = await import("@purix/core/security/credential_guard");
    const { legacyStoreFile } = await import("@purix/core/security/secrets_manager");
    const store = await loadStore();
    const info = store.describe();
    console.log(`Credentials are kept in: ${info.detail}`);
    console.log(`Lookup order: the environment (including .env), then your user-level store, then an old per-folder store (this folder or one above it).`);

    let statuses: ReturnType<typeof store.list> = [];
    try { statuses = store.list(); } catch (e) { console.error(`🛑 ${(e as Error).message}`); process.exitCode = 1; return; }
    if (statuses.length === 0) console.log("Nothing stored in your user-level store yet.");
    const audit = new Map(auditStoredSecrets(defaultGuardContext(process.cwd(), store)).map((a) => [a.name, a]));
    for (const s of statuses) {
      const age = s.ageDays === 0 ? "set today" : `set ${s.ageDays}d ago`;
      const rotated = s.rotationCount === 0 ? "never rotated" : `rotated ${s.rotationCount} time${s.rotationCount === 1 ? "" : "s"}`;
      const a = audit.get(s.name);
      const size = a?.length != null ? `, ${a.length} characters` : "";
      console.log(`${s.name}  ${age}${s.rotationDue ? "  ⚠ ROTATION DUE" : ""}  (${rotated}${size}; ${s.backend === "keyring" ? "OS keyring" : "encrypted file"})`);
      if (a?.unused) console.log(`   ⚠ Purix never reads an entry named "${s.name}"${a.meant ? `; the key for it is stored as ${a.meant}` : ""}. Remove it: purix secret remove ${s.name}`);
      if (a?.differsFromEnvironment) console.log(`   ⚠ Differs from the ${s.name} environment variable. The environment one is used and this one is ignored while it is set.`);
    }

    let old: ReturnType<typeof listOld> = [];
    try { old = listOld(); } catch { old = []; }
    if (old.length > 0) {
      console.log(`\nOld per-folder store (read from that folder and the folders below it): ${legacyStoreFile()}`);
      const knownNames = new Set(defaultGuardContext(process.cwd(), store).known.map((k) => k.name));
      for (const o of old) {
        console.log(knownNames.has(o.name)
          ? `  ${o.name}  (visible only from that folder and below; move it with: purix secret migrate)`
          : `  ${o.name}  (Purix never reads an entry with this name, and migrate will not move it; delete it with: purix secret remove ${o.name})`);
      }
    }
  });

  secretCmd.command("migrate").description("Move credentials from the old per-folder key store (this folder or one above it) into your user-level store. Asks before moving anything and before removing an old copy; never overwrites a different key").action(async () => {
    const { planMigration, applyMigration } = await import("@purix/core/security/secret_migration");
    const { defaultGuardContext } = await import("@purix/core/security/credential_guard");
    const { listSecretStatus: listOld, getSecret: getOld, deleteSecret: deleteOld } = await import("@purix/core/security/secrets_manager");
    const { confirm } = await import("@purix/core/cli-io/confirm");

    // Moving a credential changes which key is sent to your model provider, so it is a person's decision at a terminal: no pipe, no script.
    if (!(process.stdin.isTTY && process.stdout.isTTY)) {
      console.error("🛑 `purix secret migrate` needs a person at a terminal, because it changes which key Purix sends to your model provider. Nothing was changed. Run it yourself in a terminal window.");
      process.exitCode = 1;
      return;
    }

    const store = await loadStore();
    const source = { names: () => listOld().map((s) => s.name), value: (n: string) => getOld(n), remove: (n: string) => deleteOld(n) };
    let items;
    try {
      items = planMigration(source, store, defaultGuardContext(process.cwd(), store).known);
    } catch (e) {
      console.error(`🛑 ${(e as Error).message}`);
      process.exitCode = 1;
      return;
    }
    if (items.length === 0) { console.log("Nothing to migrate: this folder has no old key store entries."); return; }

    for (const i of items) {
      const label = i.action === "import" ? "will be copied to your user-level store" : i.action === "already_there" ? "already in your user-level store" : i.action === "conflict" ? "NOT moved" : "NOT moved";
      console.log(`  ${i.name}: ${label}${i.note ? ` — ${i.note}` : ""}`);
    }
    const toImport = items.filter((i) => i.action === "import");
    const dupes = items.filter((i) => i.action === "already_there");
    if (toImport.length === 0 && dupes.length === 0) return;

    if (toImport.length > 0 && !(await confirm(`\nCopy ${toImport.length} key${toImport.length === 1 ? "" : "s"} to your user-level store?`))) {
      console.log("Cancelled. Nothing was changed.");
      return;
    }
    const removeOld = await confirm(`Then remove the old copy from the old per-folder store once the new copy reads back correctly? (No keeps both; the new one is used first.)`);
    const result = applyMigration(items, source, store, removeOld);
    for (const m of result.imported) console.log(`✅ ${m.name} copied to ${where(m.backend)}.`);
    for (const n of result.removedOld) console.log(`✅ Old copy of ${n} removed.`);
    for (const f of result.failed) { console.error(`🛑 ${f.name}: ${f.reason}`); process.exitCode = 1; }
  });
}
