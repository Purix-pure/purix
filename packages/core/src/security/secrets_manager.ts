// packages/core/src/security/secrets_manager.ts
//
// Part 4: this module used to hardcode both its store path and its
// master-key path as module-level constants, and never exported the
// encryption primitives — so there was no way to point a second store at
// a different directory. Refactored into a factory, createSecretsStore,
// so packages/core/src/security/session.ts can build a machine-global
// store at ~/.purix for the session token, with its OWN independent
// master key, while providers.ts and cli/commands/security.ts keep
// working completely unchanged against the project-local store.
//
// Two independent master keys (one per baseDir) matters beyond code
// cleanliness: if the session literally reused loadMasterKey() unmodified,
// the key encrypting it would come from whichever repo happened to be cwd
// the first time `purix login` ran — silently contradicting "session
// identity is machine-scoped." Two stores, two keys, closes that. 
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, renameSync, unlinkSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";

const ROTATION_WARN_DAYS = 90;

interface SecretRecord {
  ciphertext: string; // base64
  iv: string; // base64
  auth_tag: string; // base64
  set_at: string;
  rotated_at: string[]; // history of prior set_at timestamps — old ciphertext isn't kept
}

interface StoreFile {
  secrets: Record<string, SecretRecord>;
}

export interface SecretStatus {
  name: string;
  set_at: string;
  ageDays: number;
  rotationDue: boolean;
  rotationCount: number;
}

export interface SecretsStore {
  setSecret(this: void, name: string, value: string): void;
  getSecret(this: void, name: string): string | null;
  deleteSecret(this: void, name: string): boolean;
  listSecretStatus(this: void): SecretStatus[];
}

function encrypt(plaintext: string, key: Buffer) {
  const iv = randomBytes(12); // GCM standard nonce size
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  return { ciphertext: encrypted.toString("base64"), iv: iv.toString("base64"), authTag: cipher.getAuthTag().toString("base64") };
}

function decrypt(record: SecretRecord, key: Buffer): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAuthTag(Buffer.from(record.auth_tag, "base64"));
  const decrypted = Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]);
  return decrypted.toString("utf-8");
}

/**
 * TEST-REPORT F2: the master key that decrypts every stored secret is written
 * right next to the ciphertext, inside the project, and nothing ever stopped
 * `git add -A` from staging both. If the store's parent directory is a git
 * repository, make sure the two secret files are listed in its .gitignore.
 * Idempotent (safe to call on every write, so existing installs are fixed on
 * their next `secret set`), preserves the file's line endings, and never
 * throws — a read-only checkout must not break secret storage.
 * Returns the entries it added.
 */
export function ensureSecretFilesGitignored(baseDir: string, filenames: string[]): string[] {
  try {
    const projectRoot = dirname(baseDir);
    if (!existsSync(join(projectRoot, ".git"))) return [];
    const gitignorePath = join(projectRoot, ".gitignore");
    const existing = existsSync(gitignorePath) ? readFileSync(gitignorePath, "utf-8") : "";
    const eol = existing.includes("\r\n") ? "\r\n" : "\n";
    const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
    const dirName = basename(baseDir);
    const missing = filenames
      .map((f) => `${dirName}/${f}`)
      .filter((entry) => !present.has(entry) && !present.has(`/${entry}`) && !present.has(`${dirName}/`) && !present.has(`/${dirName}/`) && !present.has(dirName));
    if (missing.length === 0) return [];
    const prefix = existing.length > 0 && !existing.endsWith("\n") ? eol : "";
    const header = present.has("# Purix secrets — never commit") ? "" : `# Purix secrets — never commit${eol}`;
    writeFileSync(gitignorePath, `${existing}${prefix}${header}${missing.join(eol)}${eol}`, "utf-8");
    console.warn(`  [secrets] added ${missing.join(", ")} to ${gitignorePath} so they can't be committed by accident.`);
    return missing;
  } catch {
    return [];
  }
}

/**
 * Section 17 Must-have: "stored in a dedicated secrets manager, never in
 * the manifest or in plaintext config." Honest about what this is: AES-
 * 256-GCM at rest, keyed by a locally-generated master key file. Not a
 * real vault (no HSM, no network ACL) — that tradeoff is a v1 CLI
 * reality, not something hidden from you.
 *
 * `baseDir` is the directory the store's two files live directly inside
 * (e.g. "<project>/.purix" for the project-local store, "~/.purix" for
 * the machine-global session store) — NOT the project root, so callers
 * don't get a doubled ".purix/.purix". `storeFilename` defaults to the
 * provider-key store's name; the session store passes "session.enc" to
 * match the name used in the architecture diagram.
 */
export function createSecretsStore(baseDir: string, storeFilename = "secrets.enc.json"): SecretsStore {
  const storePath = join(baseDir, storeFilename);
  const masterKeyPath = join(baseDir, "secrets.master.key");

  function loadMasterKey(): Buffer {
    if (existsSync(masterKeyPath)) {
      return Buffer.from(readFileSync(masterKeyPath, "utf-8").trim(), "base64");
    }
    mkdirSync(dirname(masterKeyPath), { recursive: true });
    const key = randomBytes(32);
    writeFileSync(masterKeyPath, key.toString("base64"), "utf-8");
    try {
      chmodSync(masterKeyPath, 0o600);
    } catch {
      // best-effort — not every filesystem honors this (notably Windows)
    }
    console.warn(
      `  [secrets] generated a new master key at ${masterKeyPath}. This file decrypts every ` +
        `secret Purix stores here — back it up somewhere safe and NEVER commit it.`
    );
    return key;
  }

  function loadStore(): StoreFile {
    if (!existsSync(storePath)) return { secrets: {} };
    try {
      return JSON.parse(readFileSync(storePath, "utf-8"));
    } catch (err) {
      // TEST-REPORT F2b: this used to `return { secrets: {} }`, so the next
      // write silently replaced a damaged store with a near-empty one — and
      // reported success — permanently destroying every other stored secret.
      // Fail loudly instead and leave the file alone.
      throw new Error(
        `The secrets store at ${storePath} could not be read (${err instanceof Error ? err.message : String(err)}). ` +
          `Nothing was changed. Restore it from a backup, or delete the file if you intend to start over.`,
        { cause: err }
      );
    }
  }

  function saveStore(store: StoreFile): void {
    ensureSecretFilesGitignored(baseDir, [basename(masterKeyPath), basename(storePath)]);
    mkdirSync(dirname(storePath), { recursive: true });
    const tmpPath = `${storePath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
try {
  writeFileSync(tmpPath, JSON.stringify(store, null, 2), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, storePath);
} catch (err) {
  try { unlinkSync(tmpPath); } catch { /* temp file may not exist */ }
  throw err;
}
    try {
      chmodSync(storePath, 0o600);
    } catch { /* chmod best-effort — not all filesystems support it */ }
  }

  return {
    setSecret(name, value) {
      const key = loadMasterKey();
      const store = loadStore();
      const existing = store.secrets[name];
      const { ciphertext, iv, authTag } = encrypt(value, key);
      store.secrets[name] = {
        ciphertext,
        iv,
        auth_tag: authTag,
        set_at: new Date().toISOString(),
        rotated_at: existing ? [...existing.rotated_at, existing.set_at] : [],
      };
      saveStore(store);
    },

    getSecret(name) {
      const store = loadStore();
      const record = store.secrets[name];
      if (!record) return null;
      return decrypt(record, loadMasterKey());
    },

    deleteSecret(name) {
      const store = loadStore();
      if (!(name in store.secrets)) return false;
      delete store.secrets[name];
      saveStore(store);
      return true;
    },

    /** Section 17's "defined rotation policy" — a real, checkable 90-day threshold instead of an assumed practice. */
    listSecretStatus() {
      const store = loadStore();
      const now = Date.now();
      return Object.entries(store.secrets).map(([name, r]) => {
        const ageDays = Math.floor((now - new Date(r.set_at).getTime()) / 86_400_000);
        return { name, set_at: r.set_at, ageDays, rotationDue: ageDays >= ROTATION_WARN_DAYS, rotationCount: r.rotated_at.length };
      });
    },
  };
}

// Default project-local instance — same directory, same behavior as
// before this refactor. providers.ts and cli/commands/security.ts import
// these three names exactly as they always have; nothing at those call
// sites changes.
function projectStore(): SecretsStore {
  return createSecretsStore(join(process.cwd(), ".purix"));
}

export const setSecret: SecretsStore["setSecret"] = (...args) => projectStore().setSecret(...args);
export const getSecret: SecretsStore["getSecret"] = (...args) => projectStore().getSecret(...args);
export const deleteSecret: SecretsStore["deleteSecret"] = (...args) => projectStore().deleteSecret(...args);
export const listSecretStatus: SecretsStore["listSecretStatus"] = (...args) => projectStore().listSecretStatus(...args);