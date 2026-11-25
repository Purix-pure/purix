// packages/core/src/security/secret_migration.ts
//
// `purix secret migrate`: move credentials from the old per-folder store into the user-level store.
//
// This module decides and does; the CLI asks the person. Nothing here prompts, and nothing here runs without being handed the
// person's answer, because moving a credential changes which key Purix sends to a model provider and an agent must not be able
// to do it for them (the hook rule in hooks/decide.ts denies `purix secret migrate` to agents; this is the second lock).
//
// Rules, each from a way this could lose or replace a key:
//   - Nothing is overwritten. A name the user-level store already holds with a DIFFERENT value is reported as a conflict and left alone.
//   - The old copy is removed only after the new copy has been read back and matches, and only when the caller says to.
//   - A name Purix never reads (a stray entry) is reported, not moved: it would be dead weight in the new store.
//   - Values are compared in memory and never returned or printed.
import { nameMeant, type KnownCredentialName } from "./credential_guard.js";
import type { UserSecrets } from "./user_secrets.js";

export type MigrationAction = "import" | "already_there" | "conflict" | "unused";

export interface MigrationItem {
  name: string;
  action: MigrationAction;
  /** For "unused": the known name this was probably meant to be. */
  meant?: string;
  /** For "conflict" and "import" problems: a sentence for the person. */
  note?: string;
}

export interface MigrationSource {
  names(): string[];
  value(name: string): string | null;
  remove(name: string): boolean;
}

export function planMigration(source: MigrationSource, user: UserSecrets, known: KnownCredentialName[]): MigrationItem[] {
  const items: MigrationItem[] = [];
  for (const name of source.names()) {
    if (!known.some((k) => k.name === name)) {
      const meant = nameMeant(name, known)?.name;
      items.push({ name, action: "unused", meant, note: `Purix never reads an entry named "${name}"${meant ? `; the key for it is stored as ${meant}` : ""}. Not moved.` });
      continue;
    }
    let old: string | null;
    try {
      old = source.value(name);
    } catch (e) {
      items.push({ name, action: "conflict", note: `The old value could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was changed for it.` });
      continue;
    }
    if (old === null || old === "") continue;
    let current: string | null = null;
    if (user.has(name)) {
      try {
        current = user.get(name);
      } catch (e) {
        items.push({ name, action: "conflict", note: `The user-level store holds ${name} but it could not be read (${e instanceof Error ? e.message : String(e)}). Nothing was changed.` });
        continue;
      }
    }
    if (current === null) items.push({ name, action: "import" });
    else if (current === old) items.push({ name, action: "already_there", note: "The same key is already in your user-level store." });
    else items.push({ name, action: "conflict", note: `Your user-level store already holds a different ${name}. Not overwritten. To replace it with the old one, run "purix secret rotate ${name}" and type the old key, or remove the old copy with "purix secret remove ${name}" first.` });
  }
  return items;
}

export interface MigrationResult {
  imported: { name: string; backend: "keyring" | "file"; fellBack: boolean }[];
  failed: { name: string; reason: string }[];
  /** Old copies removed (only when `removeOld` was true and the new copy read back equal). */
  removedOld: string[];
}

/** Imports the "import" items. `removeOld` is the person's answer to "remove the old copies?" and is never assumed. */
export function applyMigration(items: MigrationItem[], source: MigrationSource, user: UserSecrets, removeOld: boolean): MigrationResult {
  const result: MigrationResult = { imported: [], failed: [], removedOld: [] };
  for (const item of items) {
    if (item.action !== "import" && !(item.action === "already_there" && removeOld)) continue;
    const old = source.value(item.name);
    if (old === null || old === "") continue;
    if (item.action === "import") {
      try {
        const { backend, fellBack } = user.set(item.name, old);
        result.imported.push({ name: item.name, backend, fellBack });
      } catch (e) {
        result.failed.push({ name: item.name, reason: e instanceof Error ? e.message : String(e) });
        continue;
      }
    }
    if (!removeOld) continue;
    let back: string | null = null;
    try {
      back = user.get(item.name);
    } catch {
      back = null;
    }
    if (back === old) {
      if (source.remove(item.name)) result.removedOld.push(item.name);
    } else {
      result.failed.push({ name: item.name, reason: "The new copy did not read back the same, so the old copy was kept." });
    }
  }
  return result;
}
