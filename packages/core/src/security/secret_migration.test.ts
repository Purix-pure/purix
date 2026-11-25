// `purix secret migrate`: copy, never overwrite, remove the old copy only after the new one reads back.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KnownCredentialName } from "./credential_guard";
import { applyMigration, planMigration, type MigrationSource } from "./secret_migration";
import { createUserSecrets, type UserSecrets } from "./user_secrets";

const known: KnownCredentialName[] = [
  { name: "GEMINI_API_KEY", purpose: "Gemini API key", providerId: "gemini" },
  { name: "OPENAI_API_KEY", purpose: "OpenAI API key", providerId: "openai" },
];

let dir: string;
let user: UserSecrets;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-migrate-"));
  user = createUserSecrets({ dir, keyring: null, platform: "darwin", warn: () => {} });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function oldStore(entries: Record<string, string>): MigrationSource & { entries: Record<string, string> } {
  const e = { ...entries };
  return { entries: e, names: () => Object.keys(e), value: (n) => e[n] ?? null, remove: (n) => delete e[n] };
}

describe("planMigration", () => {
  test("sorts every old entry into import, already there, conflict or unused", () => {
    user.set("OPENAI_API_KEY", "same");
    user.set("GEMINI_API_KEY", "different-in-user-store");
    const src = oldStore({ GEMINI_API_KEY: "old-gemini", OPENAI_API_KEY: "same", gemini: "stray", PERPLEXITY_API_KEY: "p" });
    const plan = planMigration(src, user, [...known, { name: "PERPLEXITY_API_KEY", purpose: "Perplexity API key", providerId: "perplexity" }]);
    const byName = Object.fromEntries(plan.map((p) => [p.name, p]));
    expect(byName["PERPLEXITY_API_KEY"]!.action).toBe("import");
    expect(byName["OPENAI_API_KEY"]!.action).toBe("already_there");
    expect(byName["GEMINI_API_KEY"]!.action).toBe("conflict");
    expect(byName["GEMINI_API_KEY"]!.note).toContain("Not overwritten");
    expect(byName["gemini"]).toMatchObject({ action: "unused", meant: "GEMINI_API_KEY" });
  });

  test("an empty old store plans nothing", () => {
    expect(planMigration(oldStore({}), user, known)).toEqual([]);
  });
});

describe("applyMigration", () => {
  test("copies without removing when the person said keep the old copy", () => {
    const src = oldStore({ GEMINI_API_KEY: "old-gemini" });
    const items = planMigration(src, user, known);
    const r = applyMigration(items, src, user, false);
    expect(r.imported).toMatchObject([{ name: "GEMINI_API_KEY", backend: "file" }]);
    expect(r.removedOld).toEqual([]);
    expect(user.get("GEMINI_API_KEY")).toBe("old-gemini");
    expect(src.entries["GEMINI_API_KEY"]).toBe("old-gemini");
  });

  test("removes the old copy only after the new copy reads back the same", () => {
    const src = oldStore({ GEMINI_API_KEY: "old-gemini" });
    const r = applyMigration(planMigration(src, user, known), src, user, true);
    expect(r.removedOld).toEqual(["GEMINI_API_KEY"]);
    expect(src.entries).toEqual({});
    expect(user.get("GEMINI_API_KEY")).toBe("old-gemini");
  });

  test("keeps the old copy when the new one does not read back (a store that loses writes)", () => {
    const src = oldStore({ GEMINI_API_KEY: "old-gemini" });
    const lossy: UserSecrets = { ...user, set: () => ({ backend: "file", fellBack: false }), get: () => null, has: () => false };
    const r = applyMigration(planMigration(src, lossy, known), src, lossy, true);
    expect(r.removedOld).toEqual([]);
    expect(r.failed[0]!.reason).toContain("did not read back the same");
    expect(src.entries["GEMINI_API_KEY"]).toBe("old-gemini");
  });

  test("never overwrites a different key and never moves a stray entry", () => {
    user.set("GEMINI_API_KEY", "keep-me");
    const src = oldStore({ GEMINI_API_KEY: "old-gemini", gemini: "stray" });
    const r = applyMigration(planMigration(src, user, known), src, user, true);
    expect(r.imported).toEqual([]);
    expect(r.removedOld).toEqual([]);
    expect(user.get("GEMINI_API_KEY")).toBe("keep-me");
    expect(src.entries).toEqual({ GEMINI_API_KEY: "old-gemini", gemini: "stray" });
  });

  test("a same-valued old copy can be removed on request", () => {
    user.set("OPENAI_API_KEY", "same");
    const src = oldStore({ OPENAI_API_KEY: "same" });
    const r = applyMigration(planMigration(src, user, known), src, user, true);
    expect(r.removedOld).toEqual(["OPENAI_API_KEY"]);
    expect(user.get("OPENAI_API_KEY")).toBe("same");
  });
});
