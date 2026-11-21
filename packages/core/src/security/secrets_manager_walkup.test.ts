// The old per-folder store is found from the folder it was saved in AND from every folder below it. Before, only the exact folder
// Purix was run in was looked at, so a key saved in a project root was "not found" from any of its subfolders.
import { afterEach, beforeEach, describe, test } from "node:test";
import { expect } from "expect";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretsStore, findFolderStoreDir, getSecret, legacyStoreFile } from "./secrets_manager";
import { createUserSecrets, resolveCredential } from "./user_secrets";

let root: string;
let cwd0: string;
let saved: string | undefined;

beforeEach(() => {
  cwd0 = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "purix-walkup-")));
  saved = process.env.GEMINI_API_KEY;
  delete process.env.GEMINI_API_KEY;
});
afterEach(() => {
  process.chdir(cwd0);
  if (saved === undefined) delete process.env.GEMINI_API_KEY;
  else process.env.GEMINI_API_KEY = saved;
  rmSync(root, { recursive: true, force: true });
});

const mk = (...parts: string[]) => {
  const d = join(root, ...parts);
  mkdirSync(d, { recursive: true });
  return d;
};

describe("findFolderStoreDir", () => {
  test("finds the store in the folder itself and in every folder below it", () => {
    const proj = mk("proj");
    createSecretsStore(join(proj, ".purix")).setSecret("GEMINI_API_KEY", "old-key");
    const deep = mk("proj", "src", "deep");
    expect(findFolderStoreDir(proj)).toBe(join(proj, ".purix"));
    expect(findFolderStoreDir(deep)).toBe(join(proj, ".purix"));
    expect(legacyStoreFile(deep)).toBe(join(proj, ".purix", "secrets.enc.json"));
  });

  test("the nearest store wins", () => {
    const proj = mk("proj");
    const sub = mk("proj", "sub");
    createSecretsStore(join(proj, ".purix")).setSecret("GEMINI_API_KEY", "outer");
    createSecretsStore(join(sub, ".purix")).setSecret("GEMINI_API_KEY", "inner");
    expect(findFolderStoreDir(mk("proj", "sub", "x"))).toBe(join(sub, ".purix"));
  });

  test("a folder next to the store, not under it, does not see it", () => {
    createSecretsStore(join(mk("a"), ".purix")).setSecret("GEMINI_API_KEY", "a-key");
    expect(findFolderStoreDir(mk("b", "nested"))).toBeNull();
  });

  test("the user-level store's own files are not an old per-folder store", () => {
    const home = mk("home", ".purix");
    writeFileSync(join(home, "user-secrets.enc.json"), "{}");
    writeFileSync(join(home, "user-secrets.index.json"), "{}");
    expect(findFolderStoreDir(mk("home", "work"))).toBeNull();
  });

  test("with no old store, legacyStoreFile names where one would be made, in the folder itself", () => {
    const here = mk("fresh");
    expect(legacyStoreFile(here)).toBe(join(here, ".purix", "secrets.enc.json"));
  });
});

describe("the old store is read from a subfolder", () => {
  test("getSecret from a subfolder returns the key saved in the project root", () => {
    const proj = mk("proj");
    createSecretsStore(join(proj, ".purix")).setSecret("GEMINI_API_KEY", "old-key");
    process.chdir(mk("proj", "packages", "x"));
    expect(getSecret("GEMINI_API_KEY")).toBe("old-key");
  });

  test("resolveCredential from a subfolder uses it last, names its real location, and the user store still beats it", () => {
    const proj = mk("proj");
    createSecretsStore(join(proj, ".purix")).setSecret("GEMINI_API_KEY", "old-key");
    process.chdir(mk("proj", "sub"));
    const user = createUserSecrets({ dir: mk("userdir"), keyring: null, platform: "darwin", warn: () => {} });
    const warnings: string[] = [];
    expect(resolveCredential("GEMINI_API_KEY", { userSecrets: user, warn: (m) => warnings.push(m) })).toEqual({ value: "old-key", source: "project_store" });
    expect(warnings.join("\n")).toContain(join(proj, ".purix", "secrets.enc.json"));
    expect(warnings.join("\n")).toContain("purix secret migrate");
    user.set("GEMINI_API_KEY", "new-key");
    expect(resolveCredential("GEMINI_API_KEY", { userSecrets: user, warn: () => {} })).toEqual({ value: "new-key", source: "user_store" });
  });
});
