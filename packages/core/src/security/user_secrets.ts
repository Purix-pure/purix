// packages/core/src/security/user_secrets.ts
//
// The user-level credential store: one place per person, found from their home folder, never from the folder a command runs in.
//
// WHY THIS EXISTS. The old store (secrets_manager.ts, `projectStore()`) lives at `<cwd>/.purix`. A key saved in one folder was
// invisible from another, including a subfolder of the same project, and the master key that decrypts it sat next to the
// ciphertext. Every other CLI that keeps a login (gh, glab) keeps it per user, not per folder.
//
// WHERE A KEY IS KEPT, in this order:
//   1. The OS keyring (Windows Credential Manager, macOS Keychain, Linux Secret Service) through the optional package
//      @napi-rs/keyring, loaded only when needed. The key is not in a file Purix owns.
//   2. An encrypted file in the user folder (`~/.purix/user-secrets.enc.json`) with its own master key file beside it. This is the
//      same weak design as before (the key is next to the ciphertext), so it is used only when the keyring cannot be, and Purix
//      says so out loud whenever it falls back.
//
// WHAT THE KEYRING DOES NOT DO. Another program running as the same person can ask the keyring for the entry too, a coding agent
// included. What keeps an agent away from it is the hook rule in hooks/decide.ts, which is a text check and not a wall.
//
// THE LINUX CASE, tested on a headless machine (2026-11-21): without a Secret Service session, @napi-rs/keyring falls back to the
// kernel keyutils store. There, `setPassword` succeeded for one entry and failed with "AccessDenied" for another in the same
// container, and left half-created keys behind. A write that sometimes works and does not persist is worse than a clear fallback, so:
//   - on Linux the keyring is used in "auto" mode only when a desktop session bus is present (DBUS_SESSION_BUS_ADDRESS);
//   - every keyring write is read back before it counts as stored; a write that does not read back falls through to the file.
//
// Names of stored credentials are kept in a plain index file (`user-secrets.index.json`: names, dates, which backend holds each).
// It holds no values. A keyring cannot be listed, so the index is how `purix secret status` knows what exists.
import { createRequire } from "node:module";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { ambientEnv, dataDrivenEnv, purixEnv } from "../platform/env.js";
import { userDir } from "../platform/user_dir.js";
import { createSecretsStore, getSecret as getProjectSecret, legacyStoreFile, type SecretStatus } from "./secrets_manager.js";

const SERVICE = "purix";
const INDEX_FILENAME = "user-secrets.index.json";
const FILE_STORE_FILENAME = "user-secrets.enc.json";
const FILE_MASTER_KEY_FILENAME = "user-secrets.master.key";
const ROTATION_WARN_DAYS = 90;

export type BackendKind = "keyring" | "file";
export type BackendMode = "auto" | "file" | "keyring";

/** The part of an @napi-rs/keyring Entry that Purix uses. A test passes a fake. */
export interface KeyringEntryLike {
  getPassword(): string | null;
  setPassword(value: string): void;
  deletePassword(): boolean | void;
}
export interface KeyringModuleLike {
  Entry: new (service: string, user: string) => KeyringEntryLike;
}

interface IndexEntry {
  backend: BackendKind;
  set_at: string;
  rotated_at: string[];
}
interface IndexFile {
  schema: 1;
  entries: Record<string, IndexEntry>;
}

export interface UserSecretStatus extends SecretStatus {
  backend: BackendKind;
}

export interface BackendDescription {
  /** Where the next credential would be written. */
  kind: BackendKind;
  /** One sentence for a person: why this backend, and what that means for safety. */
  detail: string;
  /** The folder holding the index (and the encrypted file, when that backend is in use). */
  directory: string;
}

export interface UserSecretsOptions {
  /** Folder for the index and the file backend. Default: the user folder (`~/.purix`, or PURIX_USER_DIR). */
  dir?: string;
  /** "auto" (default): keyring when it works, else file. "file" never touches the keyring. "keyring" never falls back. */
  mode?: BackendMode;
  /** A keyring module to use instead of loading the real one; `null` means "none installed". For tests. */
  keyring?: KeyringModuleLike | null;
  /** Platform name, for tests. Default: process.platform. */
  platform?: NodeJS.Platform;
  /** DBUS_SESSION_BUS_ADDRESS, for tests. Default: the environment's. */
  dbusAddress?: string | undefined;
  /** Where fallback warnings go. Default: stderr, once per process per reason. */
  warn?: (message: string) => void;
}

export interface UserSecrets {
  get(this: void, name: string): string | null;
  set(this: void, name: string, value: string): { backend: BackendKind; fellBack: boolean };
  remove(this: void, name: string): boolean;
  has(this: void, name: string): boolean;
  list(this: void): UserSecretStatus[];
  describe(this: void): BackendDescription;
}

// Core returns data; the CLI prints (scripts/check-single-point.ts, rule R1). So a notice ("not using the OS keyring", "using a key from the
// old store") is handed to a sink the front door installs; until one is installed it waits here, so no notice is lost and none is printed
// from inside core. Each distinct notice is passed on once per process.
export type CredentialNoticeSink = (message: string) => void;
const warned = new Set<string>();
const pendingNotices: string[] = [];
let noticeSink: CredentialNoticeSink | null = null;
const MAX_PENDING_NOTICES = 50;

/** Installs the function that shows notices (the CLI prints them to stderr) and hands it any that arrived before it was installed. Null removes it. */
export function setCredentialNoticeSink(sink: CredentialNoticeSink | null): void {
  noticeSink = sink;
  if (sink !== null) for (const m of pendingNotices.splice(0)) sink(m);
}

function defaultWarn(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  if (noticeSink !== null) noticeSink(message);
  else if (pendingNotices.length < MAX_PENDING_NOTICES) pendingNotices.push(message);
}
/** For tests only: let a warning be shown again, and forget any sink and queued notices. */
export function resetUserSecretsWarningsForTests(): void {
  warned.clear();
  pendingNotices.length = 0;
  noticeSink = null;
}

function parseMode(raw: string | undefined, warn: (m: string) => void): BackendMode {
  const v = raw?.trim().toLowerCase();
  if (v === undefined || v === "" || v === "auto") return "auto";
  if (v === "file" || v === "keyring") return v;
  warn(`PURIX_SECRET_BACKEND="${raw}" is not one of auto, file, keyring. Using auto.`);
  return "auto";
}

function loadRealKeyring(): KeyringModuleLike | null {
  try {
    // Loaded here, synchronously, and only when a credential is read or written: the package is optional, and a plain
    // `import` would make every Purix command pay for it (and fail where its prebuilt binary does not exist).
    const req = createRequire(import.meta.url);
    return req("@napi-rs/keyring") as KeyringModuleLike;
  } catch {
    return null;
  }
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function createUserSecrets(opts: UserSecretsOptions = {}): UserSecrets {
  const dir = opts.dir ?? userDir();
  const warn = opts.warn ?? defaultWarn;
  const platform = opts.platform ?? process.platform;
  const dbus = "dbusAddress" in opts ? opts.dbusAddress : dataDrivenEnv("DBUS_SESSION_BUS_ADDRESS");
  const mode = opts.mode ?? parseMode(purixEnv("PURIX_SECRET_BACKEND"), warn);
  const indexPath = join(dir, INDEX_FILENAME);

  const fileStore = createSecretsStore(dir, FILE_STORE_FILENAME, { masterKeyFilename: FILE_MASTER_KEY_FILENAME });
  let keyringMod: KeyringModuleLike | null | undefined;
  const keyring = (): KeyringModuleLike | null => {
    if (keyringMod === undefined) keyringMod = opts.keyring !== undefined ? opts.keyring : loadRealKeyring();
    return keyringMod;
  };

  /**
   * In "auto" mode the REAL keyring is not used where a write into it would be wrong: a test run (NODE_ENV=test), a CI runner (no persistent
   * credential store), or a Purix pointed at a specific folder with PURIX_USER_DIR (everything must stay inside it, and a keyring entry is not
   * in that folder). Without this, a test on a developer's Windows or macOS machine would write into their real Credential Manager or Keychain.
   * An injected keyring (tests) and PURIX_SECRET_BACKEND=keyring (explicitly asked for) are not affected. Taken from the second of the two
   * parallel key-store changes.
   */
  function realKeyringHeldBack(): string | null {
    if (mode !== "auto" || opts.keyring !== undefined) return null;
    if (ambientEnv("NODE_ENV") === "test") return "NODE_ENV=test (a test run never writes into a real credential store)";
    const ci = ambientEnv("CI");
    if (ci !== undefined && ci.trim() !== "" && !["false", "0", "no", "off"].includes(ci.trim().toLowerCase())) return "CI is set (a CI runner has no persistent credential store)";
    if (opts.dir === undefined && purixEnv("PURIX_USER_DIR") !== undefined) return "PURIX_USER_DIR is set (everything stays inside that folder, and a keyring entry is not in it)";
    return null;
  }

  /** Why the keyring cannot be used right now, or null when it can be tried. */
  function keyringUnavailableReason(): string | null {
    if (mode === "file") return "PURIX_SECRET_BACKEND=file";
    const held = realKeyringHeldBack();
    if (held !== null) return held;
    if (keyring() === null) return "the optional package @napi-rs/keyring is not installed or could not be loaded on this machine";
    if (mode === "auto" && platform === "linux" && !dbus) return "no desktop session (Secret Service) was found; DBUS_SESSION_BUS_ADDRESS is not set";
    return null;
  }

  function readIndex(): IndexFile {
    const read = readJsonFile<IndexFile>(indexPath);
    if (read.kind === "missing") return { schema: 1, entries: {} };
    if (read.kind === "ok" && read.value && read.value.schema === 1 && typeof read.value.entries === "object" && read.value.entries !== null) return read.value;
    // Same rule as the secrets store: a damaged index is never replaced by an empty one on the next write.
    throw new Error(
      `The credential index at ${indexPath} could not be read (${read.kind === "corrupt" ? read.error : "unexpected contents"}). ` +
        `Nothing was changed. Restore it from a backup, or delete the file to rebuild it (stored keys in the OS keyring stay where they are; ` +
        `you would need to run "purix secret set" again for them).`
    );
  }
  function writeIndex(index: IndexFile): void {
    writeJsonAtomic(indexPath, index, { mode: 0o600 });
  }

  function keyringEntry(name: string): KeyringEntryLike {
    const mod = keyring();
    if (mod === null) throw new Error(`${name} is stored in the OS keyring, but the keyring package cannot be loaded on this machine.`);
    return new mod.Entry(SERVICE, name);
  }

  /** Writes to the keyring and reads it back. Throws when the write failed or did not read back (the Linux keyutils case). */
  function writeKeyring(name: string, value: string): void {
    const entry = keyringEntry(name);
    entry.setPassword(value);
    const back = keyringEntry(name).getPassword();
    if (back !== value) throw new Error("the keyring accepted the write but did not return the same value when read back");
  }

  return {
    get(name) {
      const rec = readIndex().entries[name];
      if (rec?.backend === "keyring") {
        try {
          return keyringEntry(name).getPassword();
        } catch (e) {
          throw new Error(`${name} is stored in the OS keyring, which could not be read now (${errText(e)}). Nothing was changed.`, { cause: e });
        }
      }
      return fileStore.getSecret(name);
    },

    set(name, value) {
      const index = readIndex();
      const existing = index.entries[name];
      let backend: BackendKind = "file";
      let fellBack = false;

      const unavailable = keyringUnavailableReason();
      if (unavailable === null) {
        try {
          writeKeyring(name, value);
          backend = "keyring";
        } catch (e) {
          if (mode === "keyring") throw new Error(`Could not store ${name} in the OS keyring (${errText(e)}). PURIX_SECRET_BACKEND=keyring does not fall back to a file.`, { cause: e });
          warn(`The OS keyring did not accept ${name} (${errText(e)}). Stored in the encrypted file ${join(dir, FILE_STORE_FILENAME)} instead; its master key is beside it, so this keeps the key out of git but not away from other programs on this account.`);
          fellBack = true;
        }
      } else {
        if (mode === "keyring") throw new Error(`PURIX_SECRET_BACKEND=keyring was asked for, but ${unavailable}.`);
        if (mode === "auto") {
          warn(`Not using the OS keyring: ${unavailable}. Credentials go in the encrypted file ${join(dir, FILE_STORE_FILENAME)}; its master key is beside it, so this keeps keys out of git but not away from other programs on this account.`);
          fellBack = true;
        }
      }

      if (backend === "file") {
        fileStore.setSecret(name, value);
        // A value that moved from the keyring to the file must not stay behind in the keyring.
        if (existing?.backend === "keyring") {
          try {
            keyringEntry(name).deletePassword();
          } catch {
            /* the new value is stored; a stale keyring copy is reported by `purix secret status` only if it can be read */
          }
        }
      } else if (existing?.backend === "file") {
        fileStore.deleteSecret(name);
      }

      index.entries[name] = {
        backend,
        set_at: new Date().toISOString(),
        rotated_at: existing ? [...existing.rotated_at, existing.set_at] : [],
      };
      writeIndex(index);
      return { backend, fellBack };
    },

    remove(name) {
      const index = readIndex();
      const rec = index.entries[name];
      let removed = false;
      if (rec?.backend === "keyring") {
        try {
          keyringEntry(name).deletePassword();
          removed = true;
        } catch (e) {
          throw new Error(`${name} is stored in the OS keyring, which could not be changed now (${errText(e)}). Nothing was removed.`, { cause: e });
        }
      }
      if (fileStore.deleteSecret(name)) removed = true;
      if (rec) {
        delete index.entries[name];
        writeIndex(index);
        removed = true;
      }
      return removed;
    },

    has(name) {
      const rec = readIndex().entries[name];
      if (rec) return true;
      try {
        return fileStore.getSecret(name) !== null;
      } catch {
        return false;
      }
    },

    list() {
      const index = readIndex();
      const now = Date.now();
      const out: UserSecretStatus[] = Object.entries(index.entries).map(([name, r]) => {
        const ageDays = Math.floor((now - new Date(r.set_at).getTime()) / 86_400_000);
        return { name, set_at: r.set_at, ageDays, rotationDue: ageDays >= ROTATION_WARN_DAYS, rotationCount: r.rotated_at.length, backend: r.backend };
      });
      return out;
    },

    describe() {
      const unavailable = keyringUnavailableReason();
      if (unavailable === null) {
        return { kind: "keyring", detail: "OS keyring (Windows Credential Manager, macOS Keychain or Linux Secret Service). Not a file Purix owns.", directory: dir };
      }
      return {
        kind: "file",
        detail:
          `Encrypted file ${join(dir, FILE_STORE_FILENAME)}, because ${unavailable}. Its master key is beside it, so this keeps keys out of git ` +
          `but not away from other programs running as you.`,
        directory: dir,
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Lookup: where does a credential come from?
//
//   1. the environment (the shell's variables, and the project `.env` the CLI loads without overriding the shell)
//   2. the user-level store (keyring or its file fallback)
//   3. the old per-folder store, so a key saved before this change keeps working, with a notice to move it
//
// The environment comes first because that is how gh and glab order it, and because the old order (stored first) let a stale
// stored key silently beat a good environment key, after which the provider answered only "API key not valid".
// ---------------------------------------------------------------------------------------------------------------------
export type CredentialSource = "environment" | "user_store" | "project_store";
export interface ResolvedCredential {
  value: string;
  source: CredentialSource;
}

export const MIGRATE_COMMAND = "purix secret migrate";

/** Reads one credential. Never prints the value. Throws only when a store that holds the entry cannot be read. */
export function resolveCredential(name: string, opts: { userSecrets?: UserSecrets; projectLookup?: (name: string) => string | null; warn?: (m: string) => void } = {}): ResolvedCredential | null {
  const env = dataDrivenEnv(name);
  if (env !== undefined && env !== "") return { value: env, source: "environment" };

  const user = (opts.userSecrets ?? createUserSecrets()).get(name);
  if (user !== null && user !== "") return { value: user, source: "user_store" };

  let legacy: string | null = null;
  try {
    legacy = (opts.projectLookup ?? getProjectSecret)(name);
  } catch {
    legacy = null; // an unreadable old store must not hide a missing key behind a different error; the caller reports "not found"
  }
  if (legacy !== null && legacy !== "") {
    (opts.warn ?? defaultWarn)(`Using ${name} from an old per-folder key store (${legacyStoreFile()}). It is visible only from that folder and the folders below it. Move it to your user-level store with: ${MIGRATE_COMMAND}`);
    return { value: legacy, source: "project_store" };
  }
  return null;
}

/** Every place a credential is held, for status output. Values are compared in memory and never returned. */
export interface CredentialLocations {
  environment: boolean;
  userStore: boolean;
  projectStore: boolean;
  /** The source Purix will use, or null when none holds it. */
  uses: CredentialSource | null;
  /** More than one place holds it and the values differ. The one in `uses` is sent; the others are ignored. */
  conflict: boolean;
}

export function credentialLocations(name: string, opts: { userSecrets?: UserSecrets; projectLookup?: (name: string) => string | null } = {}): CredentialLocations {
  const env = dataDrivenEnv(name);
  const envValue = env !== undefined && env !== "" ? env : null;
  let userValue: string | null = null;
  try {
    userValue = (opts.userSecrets ?? createUserSecrets()).get(name);
  } catch {
    userValue = null;
  }
  let legacyValue: string | null = null;
  try {
    legacyValue = (opts.projectLookup ?? getProjectSecret)(name);
  } catch {
    legacyValue = null;
  }
  const values = [envValue, userValue, legacyValue].filter((v): v is string => v !== null && v !== "");
  return {
    environment: envValue !== null,
    userStore: userValue !== null && userValue !== "",
    projectStore: legacyValue !== null && legacyValue !== "",
    uses: envValue !== null ? "environment" : userValue ? "user_store" : legacyValue ? "project_store" : null,
    conflict: new Set(values).size > 1,
  };
}
