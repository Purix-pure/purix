// src/security/session.test.ts
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSessionStore } from "./session";

describe("Session Store", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-session-test-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("saves, loads, and clears session successfully", () => {
    const store = createSessionStore(tmpDir);
    expect(store.isLoggedIn()).toBe(false);
    expect(store.loadSession()).toBeNull();

    store.saveSession("token_123", "operator@example.com");
    expect(store.isLoggedIn()).toBe(true);

    const session = store.loadSession();
    expect(session?.token).toBe("token_123");
    expect(session?.email).toBe("operator@example.com");

    store.clearSession();
    expect(store.isLoggedIn()).toBe(false);
    expect(store.loadSession()).toBeNull();
  });
});
