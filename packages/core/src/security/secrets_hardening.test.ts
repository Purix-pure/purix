// TEST-REPORT F2/F2b: the master key must not be committable by accident, and a damaged store must never be silently overwritten.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSecretsStore, ensureSecretFilesGitignored } from "./secrets_manager";

function tmpProject(withGit: boolean) {
  const root = mkdtempSync(join(tmpdir(), "purix-secrets-"));
  if (withGit) mkdirSync(join(root, ".git"));
  return { root, purix: join(root, ".purix") };
}
const quietly = <T>(fn: () => T): T => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

describe("secrets store gitignore hardening", () => {
  it("adds the key and store files to .gitignore in a git repo, exactly once", () => {
    const { root, purix } = tmpProject(true);
    try {
      const store = createSecretsStore(purix);
      quietly(() => store.setSecret("A", "1"));
      quietly(() => store.setSecret("B", "2"));
      const lines = readFileSync(join(root, ".gitignore"), "utf-8").split(/\r?\n/);
      expect(lines.filter((l) => l === ".purix/secrets.master.key")).toHaveLength(1);
      expect(lines.filter((l) => l === ".purix/secrets.enc.json")).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("preserves an existing .gitignore and its CRLF line endings", () => {
    const { root, purix } = tmpProject(true);
    try {
      writeFileSync(join(root, ".gitignore"), "node_modules\r\ndist");
      quietly(() => createSecretsStore(purix).setSecret("A", "1"));
      const text = readFileSync(join(root, ".gitignore"), "utf-8");
      expect(text.startsWith("node_modules\r\ndist\r\n")).toBe(true);
      expect(text).toContain(".purix/secrets.master.key\r\n");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("does nothing when .purix/ is already ignored, or when there is no git repo", () => {
    const a = tmpProject(true);
    const b = tmpProject(false);
    try {
      writeFileSync(join(a.root, ".gitignore"), ".purix/\n");
      expect(ensureSecretFilesGitignored(a.purix, ["secrets.master.key"])).toEqual([]);
      expect(ensureSecretFilesGitignored(b.purix, ["secrets.master.key"])).toEqual([]);
      expect(existsSync(join(b.root, ".gitignore"))).toBe(false);
    } finally {
      rmSync(a.root, { recursive: true, force: true });
      rmSync(b.root, { recursive: true, force: true });
    }
  });
});

describe("secrets store corruption", () => {
  it("refuses to overwrite an unreadable store and leaves it untouched", () => {
    const { root, purix } = tmpProject(false);
    try {
      const store = createSecretsStore(purix);
      quietly(() => store.setSecret("KEEP_ME", "precious"));
      const storePath = join(purix, "secrets.enc.json");
      writeFileSync(storePath, "{ this is not json");
      expect(() => quietly(() => store.setSecret("OTHER", "x"))).toThrow(/could not be read/);
      expect(readFileSync(storePath, "utf-8")).toBe("{ this is not json");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
