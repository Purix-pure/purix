// packages/core/src/security/secrets_manager.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretsStore, ensureSecretFilesGitignored } from "./secrets_manager";

let dirA: string;
let dirB: string;

beforeEach(() => {
  dirA = mkdtempSync(join(tmpdir(), "purix-secrets-a-"));
  dirB = mkdtempSync(join(tmpdir(), "purix-secrets-b-"));
});

afterEach(() => {
  rmSync(dirA, { recursive: true, force: true });
  rmSync(dirB, { recursive: true, force: true });
});

describe("createSecretsStore", () => {
  test("set then get round-trips a value", () => {
    const store = createSecretsStore(dirA);
    store.setSecret("OPENAI_API_KEY", "sk-test-123");
    expect(store.getSecret("OPENAI_API_KEY")).toBe("sk-test-123");
  });

  test("getSecret on an unset name returns null, not throw", () => {
    const store = createSecretsStore(dirA);
    expect(store.getSecret("NEVER_SET")).toBeNull();
  });

  test("two stores in different baseDirs generate independent master keys", () => {
    const storeA = createSecretsStore(dirA);
    const storeB = createSecretsStore(dirB);
    storeA.setSecret("k", "v");
    storeB.setSecret("k", "v");
    const keyA = readFileSync(join(dirA, "secrets.master.key"), "utf-8");
    const keyB = readFileSync(join(dirB, "secrets.master.key"), "utf-8");
    expect(keyA).not.toBe(keyB);
  });

  test("a store instance cannot decrypt another store's ciphertext — this is what makes the two-key design matter, not just a cosmetic separation", () => {
    const storeA = createSecretsStore(dirA);
    createSecretsStore(dirB); // ensures dirB's own key file exists

    storeA.setSecret("session", "jwt-for-A");
    const rawStoreFile = JSON.parse(readFileSync(join(dirA, "secrets.enc.json"), "utf-8"));

    // Simulate dirB's store somehow ending up with dirA's ciphertext (e.g.
    // the bug this refactor exists to prevent — a session encrypted with
    // whatever repo happened to be cwd first). Decrypting it under dirB's
    // independent key must fail, not silently succeed with wrong output.
    writeFileSync(join(dirB, "secrets.enc.json"), JSON.stringify(rawStoreFile));
    const storeB = createSecretsStore(dirB);
    expect(() => storeB.getSecret("session")).toThrow();
  });

  test("custom storeFilename is respected (session store uses session.enc, not secrets.enc.json)", () => {
    const store = createSecretsStore(dirA, "session.enc");
    store.setSecret("session", "jwt-token-value");
    expect(store.getSecret("session")).toBe("jwt-token-value");

    expect(existsSync(join(dirA, "session.enc"))).toBe(true);
    expect(existsSync(join(dirA, "secrets.enc.json"))).toBe(false);
  });

  test("deleteSecret removes a value and reports whether it existed", () => {
    const store = createSecretsStore(dirA);
    store.setSecret("k", "v");
    expect(store.deleteSecret("k")).toBe(true);
    expect(store.getSecret("k")).toBeNull();
    expect(store.deleteSecret("k")).toBe(false);
  });

  test("listSecretStatus reports rotation count after a re-set", () => {
    const store = createSecretsStore(dirA);
    store.setSecret("k", "v1");
    store.setSecret("k", "v2");
    const [status] = store.listSecretStatus();
    expect(status?.name).toBe("k");
    expect(status?.rotationCount).toBe(1);
    expect(status?.rotationDue).toBe(false);
  });

  // --- F2: master key + ciphertext must never be left commit-able -------

  test("F2: adds the master key and store file to the project .gitignore on first write, when baseDir sits next to a .git dir", () => {
    const projectRoot = dirA;
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    store.setSecret("K", "v");

    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".purix/secrets.master.key");
    expect(gitignore).toContain(".purix/secrets.enc.json");
  });

  test("F2: preserves existing .gitignore content and appends rather than overwriting", () => {
    const projectRoot = dirA;
    writeFileSync(join(projectRoot, ".gitignore"), "node_modules/\ndist/\n");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    store.setSecret("K", "v");

    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain("node_modules/");
    expect(gitignore).toContain("dist/");
    expect(gitignore).toContain(".purix/secrets.master.key");
  });

  test("F2: does not touch .gitignore when baseDir has no .git directory next to it (not a project)", () => {
    // dirA itself has no .git alongside it, and dirA is not named ".purix"
    const store = createSecretsStore(dirA);
    store.setSecret("K", "v");
    expect(existsSync(join(dirA, ".gitignore"))).toBe(false);
  });

  test("F2: does not duplicate entries if .purix/ (the whole dir) is already covered", () => {
    const projectRoot = dirA;
    writeFileSync(join(projectRoot, ".gitignore"), ".purix/\n");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    store.setSecret("K", "v");

    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    expect(gitignore).toBe(".purix/\n"); // untouched — already covered by the directory rule
  });

  test("F2: does not duplicate entries if the exact file lines are already present", () => {
    const projectRoot = dirA;
    writeFileSync(
      projectRoot + "/.gitignore",
      ".purix/secrets.master.key\n.purix/secrets.enc.json\n"
    );
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    store.setSecret("K", "v");

    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    const occurrences = gitignore.split("secrets.master.key").length - 1;
    expect(occurrences).toBe(1);
  });

  test("F2: is idempotent — calling ensureSecretFilesGitignored directly twice adds entries once", () => {
    const projectRoot = dirA;
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");
    mkdirSync(purixDir, { recursive: true });

    const first = ensureSecretFilesGitignored(purixDir, ["secrets.master.key", "secrets.enc.json"]);
    const second = ensureSecretFilesGitignored(purixDir, ["secrets.master.key", "secrets.enc.json"]);

    expect(first.length).toBe(2);
    expect(second.length).toBe(0);
  });

  test("F2: preserves CRLF line endings when the existing .gitignore already uses them", () => {
    const projectRoot = dirA;
    writeFileSync(join(projectRoot, ".gitignore"), "node_modules/\r\n");
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    store.setSecret("K", "v");

    const gitignore = readFileSync(join(projectRoot, ".gitignore"), "utf-8");
    expect(gitignore).toContain("\r\n.purix/secrets.master.key\r\n");
  });

  test("F2: never throws even if the .gitignore write fails (best-effort safety net, not a blocker)", () => {
    const projectRoot = dirA;
    mkdirSync(join(projectRoot, ".git"), { recursive: true });
    // Make .gitignore a directory so writing to it as a file throws inside
    // the try/catch — setSecret must still succeed.
    mkdirSync(join(projectRoot, ".gitignore"), { recursive: true });
    const purixDir = join(projectRoot, ".purix");

    const store = createSecretsStore(purixDir);
    expect(() => store.setSecret("K", "v")).not.toThrow();
    expect(store.getSecret("K")).toBe("v");
  });

  // --- F2b: a corrupt store must fail loudly, never silently reset -------

  test("F2b: a corrupt store file throws instead of silently reading as empty", () => {
    const store = createSecretsStore(dirA);
    store.setSecret("existing", "value"); // ensures a master key + valid store exist first
    writeFileSync(join(dirA, "secrets.enc.json"), "{ not valid json");

    expect(() => store.getSecret("existing")).toThrow(/could not be read/);
    expect(() => store.setSecret("new", "v")).toThrow(/could not be read/);
    expect(() => store.deleteSecret("existing")).toThrow(/could not be read/);
    expect(() => store.listSecretStatus()).toThrow(/could not be read/);
  });

  test("F2b: the corrupt store file itself is left untouched (nothing is overwritten)", () => {
    const store = createSecretsStore(dirA);
    store.setSecret("existing", "value");
    const corrupted = "{ not valid json, still corrupted";
    writeFileSync(join(dirA, "secrets.enc.json"), corrupted);

    try {
      store.setSecret("new", "v");
    } catch {
      // expected — see F2b test above
    }

    expect(readFileSync(join(dirA, "secrets.enc.json"), "utf-8")).toBe(corrupted);
  });
});