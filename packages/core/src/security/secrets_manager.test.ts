// packages/core/src/security/secrets_manager.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretsStore } from "./secrets_manager";

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
});
