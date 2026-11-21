// Core does not print. A notice from the credential store waits for the front door's sink; the CLI installs one that writes to stderr.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUserSecrets, resetUserSecretsWarningsForTests, setCredentialNoticeSink } from "./user_secrets";

let dir: string;
let realWrite: typeof process.stderr.write;
let written: string[];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-notice-"));
  resetUserSecretsWarningsForTests();
  written = [];
  realWrite = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    written.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
});
afterEach(() => {
  process.stderr.write = realWrite;
  resetUserSecretsWarningsForTests();
  rmSync(dir, { recursive: true, force: true });
});

/** A store that has to fall back to the file, which makes a notice. */
const fallingBack = () => createUserSecrets({ dir, keyring: null, platform: "darwin" });

describe("credential notices", () => {
  test("this module itself writes no notice to stderr (the old master-key file notice from secrets_manager is a separate, existing line)", () => {
    fallingBack().set("GEMINI_API_KEY", "some-test-value-123");
    expect(written.join("")).not.toMatch(/keyring|\[purix\]/i);
  });

  test("a notice that arrives before a sink is installed is delivered when one is, once", () => {
    fallingBack().set("GEMINI_API_KEY", "some-test-value-123");
    const got: string[] = [];
    setCredentialNoticeSink((m) => got.push(m));
    expect(got.length).toBeGreaterThan(0);
    expect(got.join("\n")).toMatch(/keyring/i);
    const n = got.length;
    setCredentialNoticeSink((m) => got.push(m));
    expect(got.length).toBe(n); // already delivered, not replayed
  });

  test("with a sink installed a notice goes straight to it, and the same notice is not repeated", () => {
    const got: string[] = [];
    setCredentialNoticeSink((m) => got.push(m));
    const s = fallingBack();
    s.set("GEMINI_API_KEY", "some-test-value-123");
    s.set("OPENAI_API_KEY", "other-test-value-456");
    expect(got.length).toBeGreaterThan(0);
    expect(new Set(got).size).toBe(got.length);
    expect(written.join("")).not.toMatch(/keyring|\[purix\]/i);
  });
});
