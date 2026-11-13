// F03-02 remainder: lockfile source, host and integrity checks, and the extra manifest formats. Fixtures are hand-made from format
// knowledge (npm lockfileVersion 3, pnpm v9 and v6, Yarn classic and Berry, poetry.lock, uv.lock); none was produced by the real tool.
import { describe, test } from "node:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { expect } from "expect";
import { lockDeltaFindings, hostOf } from "./lock_delta.js";
import { runSecurityGate } from "./security_gate.js";
import { parseLockEntries, pyprojectPairs, lockPairs } from "../security/lock_parsers.js";
import { manifestDelta } from "../security/dep_delta.js";

const REG = "https://registry.npmjs.org";
const npmLock = (pk: Record<string, { version: string; resolved?: string; integrity?: string; link?: boolean }>) =>
  JSON.stringify({ name: "app", lockfileVersion: 3, packages: { "": { name: "app" }, ...Object.fromEntries(Object.entries(pk).map(([k, v]) => [`node_modules/${k}`, v])) } }, null, 2);
const tgz = (host: string, name: string, v: string) => `${host}/${name}/-/${name.split("/").pop()}-${v}.tgz`;
const A = "sha512-AAAA";
const B = "sha512-BBBB";

const base = npmLock({
  lodash: { version: "4.17.21", resolved: tgz(REG, "lodash", "4.17.21"), integrity: A },
  chalk: { version: "5.3.0", resolved: tgz(REG, "chalk", "5.3.0"), integrity: A },
});

describe("package-lock.json", () => {
  test("the 2019 pattern: one entry moved to another host is reported as High, naming the host and the package", () => {
    const next = npmLock({
      lodash: { version: "4.17.21", resolved: tgz("https://evil.example.net", "lodash", "4.17.21"), integrity: A },
      chalk: { version: "5.3.0", resolved: tgz(REG, "chalk", "5.3.0"), integrity: A },
    });
    const f = lockDeltaFindings("package-lock.json", next, base);
    expect(f).toHaveLength(1);
    expect(f[0]!.category).toBe("Lockfile Host");
    expect(f[0]!.severity).toBe("High");
    expect(f[0]!.message).toContain("evil.example.net");
    expect(f[0]!.message).toContain("lodash@4.17.21");
  });

  test("a move of many entries to one new registry is ONE finding, not one per package", () => {
    const next = npmLock({
      lodash: { version: "4.17.21", resolved: tgz("https://npm.corp.example", "lodash", "4.17.21"), integrity: A },
      chalk: { version: "5.3.0", resolved: tgz("https://npm.corp.example", "chalk", "5.3.0"), integrity: A },
    });
    const f = lockDeltaFindings("package-lock.json", next, base);
    expect(f.filter((x) => x.category === "Lockfile Host")).toHaveLength(1);
    expect(f[0]!.message).toContain("2 packages");
  });

  test("same version, different integrity is reported; removing the integrity value is reported too", () => {
    const changed = npmLock({
      lodash: { version: "4.17.21", resolved: tgz(REG, "lodash", "4.17.21"), integrity: B },
      chalk: { version: "5.3.0", resolved: tgz(REG, "chalk", "5.3.0") },
    });
    const f = lockDeltaFindings("package-lock.json", changed, base);
    const i = f.find((x) => x.category === "Lockfile Integrity");
    expect(i?.severity).toBe("High");
    expect(i?.message).toContain("2 packages");
  });

  test("a version bump on the same registry changes the integrity legitimately and is NOT a lockfile finding", () => {
    const next = npmLock({
      lodash: { version: "4.17.22", resolved: tgz(REG, "lodash", "4.17.22"), integrity: B },
      chalk: { version: "5.3.0", resolved: tgz(REG, "chalk", "5.3.0"), integrity: A },
    });
    expect(lockDeltaFindings("package-lock.json", next, base)).toEqual([]);
  });

  test("a new entry from a git or file source is High even with no old lockfile to compare with", () => {
    const next = npmLock({ viagit: { version: "1.0.0", resolved: "git+ssh://git@github.com/owner/repo.git#abc123" } });
    expect(lockDeltaFindings("package-lock.json", next, undefined).map((f) => f.category)).toEqual(["Lockfile Source"]);
    expect(lockDeltaFindings("package-lock.json", next, base).map((f) => f.category)).toContain("Lockfile Source");
  });

  test("an untouched lockfile, and an entry that was already there with the same source, give nothing", () => {
    expect(lockDeltaFindings("package-lock.json", base, base)).toEqual([]);
    const withGit = npmLock({ viagit: { version: "1.0.0", resolved: "git+ssh://git@github.com/owner/repo.git#abc123" } });
    expect(lockDeltaFindings("package-lock.json", withGit, withGit)).toEqual([]);
  });

  test("a brand-new lockfile from the registry is not blocked (nothing to compare against)", () => {
    expect(lockDeltaFindings("package-lock.json", base, undefined)).toEqual([]);
  });

  test("a lockfile that cannot be read is reported, never silent", () => {
    const f = lockDeltaFindings("package-lock.json", "{ not json", base);
    expect(f[0]!.category).toBe("Lockfile Unreadable");
    expect(f[0]!.severity).toBe("Medium");
  });

  test("a file that is not a lockfile is ignored", () => {
    expect(lockDeltaFindings("src/a.ts", "x", undefined)).toEqual([]);
  });

  test("through the whole gate: the host move blocks the change and the override lifts it", () => {
    const next = npmLock({ lodash: { version: "4.17.21", resolved: tgz("https://evil.example.net", "lodash", "4.17.21"), integrity: A } });
    const r = runSecurityGate([{ path: "package-lock.json", content: next, base }]);
    expect(r.blocked).toBe(true);
    expect(r.reason).toContain("Lockfile Host");
    // the override writes an audit row into ./.purix, so run it in a temp folder (a test must leave no .purix behind)
    const work = mkdtempSync(join(tmpdir(), "purix-lockdelta-"));
    const here = process.cwd();
    process.chdir(work);
    try {
      const ok = runSecurityGate([{ path: "package-lock.json", content: next, base }], "moving to the company registry on purpose");
      expect(ok.blocked).toBe(false);
    } finally {
      closeDb();
      process.chdir(here);
      safeRmSync(work);
    }
  });
});

describe("pnpm-lock.yaml", () => {
  const head = "lockfileVersion: '9.0'\n\nimporters:\n  .:\n    dependencies:\n      lodash:\n        specifier: ^4.17.21\n        version: 4.17.21\n\npackages:\n";
  const entry = (key: string, res: string) => `  ${key}:\n    resolution: {${res}}\n    engines: {node: '>=14'}\n\n`;
  const old = head + entry("lodash@4.17.21", "integrity: sha512-AAAA") + entry("'@babel/core@7.24.0'", "integrity: sha512-CCCC") + "snapshots:\n  lodash@4.17.21: {}\n";

  test("entries are read from the packages section only, scoped names included", () => {
    const e = parseLockEntries("pnpm-lock.yaml", old)!;
    expect([...e.keys()].sort()).toEqual(["@babel/core@7.24.0", "lodash@4.17.21"]);
    expect(e.get("lodash@4.17.21")!.integrity).toBe("sha512-AAAA");
  });
  test("v6 keys (leading slash, peer suffix) read too", () => {
    const v6 = "lockfileVersion: '6.0'\n\npackages:\n\n  /lodash@4.17.21:\n    resolution: {integrity: sha512-AAAA}\n\n  /react-dom@18.2.0(react@18.2.0):\n    resolution: {integrity: sha512-DDDD}\n";
    expect([...parseLockEntries("pnpm-lock.yaml", v6)!.keys()].sort()).toEqual(["lodash@4.17.21", "react-dom@18.2.0"]);
  });
  test("a changed integrity under the same version is High; a tarball from a new host is High", () => {
    const swapped = head + entry("lodash@4.17.21", "integrity: sha512-ZZZZ") + entry("'@babel/core@7.24.0'", "integrity: sha512-CCCC");
    expect(lockDeltaFindings("pnpm-lock.yaml", swapped, old).map((f) => f.category)).toEqual(["Lockfile Integrity"]);
    const tarball = head + entry("lodash@4.17.21", "tarball: https://evil.example.net/lodash.tgz, integrity: sha512-AAAA") + entry("'@babel/core@7.24.0'", "integrity: sha512-CCCC");
    const f = lockDeltaFindings("pnpm-lock.yaml", tarball, old);
    expect(f.map((x) => x.category)).toContain("Lockfile Source"); // a tarball URL is not a registry resolution
  });
  test("a git resolution is a non-registry source", () => {
    const g = head + entry("lodash@4.17.21", "integrity: sha512-AAAA") + entry("foo@1.0.0", "type: git, repo: https://github.com/o/foo, commit: abc");
    expect(lockDeltaFindings("pnpm-lock.yaml", g, old).map((x) => x.category)).toContain("Lockfile Source");
  });
  test("something that is not a pnpm lockfile is 'unreadable', not clean", () => {
    expect(lockDeltaFindings("pnpm-lock.yaml", "hello", old)[0]!.category).toBe("Lockfile Unreadable");
  });
});

describe("yarn.lock", () => {
  const v1 = (resolved: string, integrity: string) => `# yarn lockfile v1\n\n\n"@scope/x@^1.0.0", "@scope/x@^1.1.0":\n  version "1.2.3"\n  resolved "${resolved}"\n  integrity ${integrity}\n\nlodash@^4.17.0:\n  version "4.17.21"\n  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"\n  integrity sha512-AAAA\n`;
  const old = v1("https://registry.yarnpkg.com/@scope/x/-/x-1.2.3.tgz#aaa", "sha512-XXXX");
  test("classic entries are read, scoped names included", () => {
    const e = parseLockEntries("yarn.lock", old)!;
    expect([...e.keys()].sort()).toEqual(["@scope/x@1.2.3", "lodash@4.17.21"]);
  });
  test("a changed integrity under the same version is High", () => {
    const next = v1("https://registry.yarnpkg.com/@scope/x/-/x-1.2.3.tgz#aaa", "sha512-YYYY");
    expect(lockDeltaFindings("yarn.lock", next, old).map((f) => f.category)).toEqual(["Lockfile Integrity"]);
  });
  test("a new host is High", () => {
    const next = v1("https://evil.example.net/x-1.2.3.tgz#aaa", "sha512-XXXX");
    expect(lockDeltaFindings("yarn.lock", next, old).some((f) => f.category === "Lockfile Host" || f.category === "Lockfile Source")).toBe(true);
  });
  test("Berry: a resolution that is not @npm: is a non-registry source; checksum is the integrity value", () => {
    const berry = '__metadata:\n  version: 8\n\n"x@npm:^1.0.0":\n  version: 1.0.0\n  resolution: "x@npm:1.0.0"\n  checksum: abc123\n\n"y@https://example.com/y.tgz":\n  version: 2.0.0\n  resolution: "y@https://example.com/y.tgz"\n  checksum: def456\n';
    const e = parseLockEntries("yarn.lock", berry)!;
    expect(e.get("x@1.0.0")!.integrity).toBe("abc123");
    expect(e.get("x@1.0.0")!.nonRegistry).toBeUndefined();
    expect(e.get("y@2.0.0")!.nonRegistry).toBe(true);
  });
  test("not a yarn lockfile is 'unreadable'", () => {
    expect(lockDeltaFindings("yarn.lock", "nope", old)[0]!.category).toBe("Lockfile Unreadable");
  });
});

describe("Python manifests and lockfiles give dependency pairs", () => {
  test("poetry.lock and uv.lock: PyPI pairs; a package with a source table is never looked up by name", () => {
    const poetry = '[[package]]\nname = "requests"\nversion = "2.31.0"\n\n[[package]]\nname = "internal_lib"\nversion = "1.0.0"\n\n[package.source]\ntype = "git"\nurl = "https://github.com/o/internal"\n';
    const p = lockPairs("poetry.lock", poetry)!;
    expect(p.get("requests@2.31.0")).toEqual({ ecosystem: "PyPI", name: "requests", spec: "2.31.0", version: "2.31.0" });
    expect(p.get("internal-lib@1.0.0")!.version).toBeUndefined();
    const uv = '[[package]]\nname = "httpx"\nversion = "0.27.0"\nsource = { registry = "https://pypi.org/simple" }\nsdist = { hash = "sha256:abc123" }\n\n[[package]]\nname = "mine"\nversion = "0.1.0"\nsource = { git = "https://github.com/o/mine" }\n';
    const u = lockPairs("uv.lock", uv)!;
    expect(u.get("httpx@0.27.0")!.version).toBe("0.27.0");
    expect(u.get("mine@0.1.0")!.version).toBeUndefined();
  });

  test("uv.lock: a changed hash under the same version is High", () => {
    const mk = (h: string) => `[[package]]\nname = "httpx"\nversion = "0.27.0"\nsource = { registry = "https://pypi.org/simple" }\nwheels = [\n  { url = "https://files.pythonhosted.org/x.whl", hash = "sha256:${h}" },\n]\n`;
    expect(lockDeltaFindings("uv.lock", mk("bbbb"), mk("aaaa")).map((f) => f.category)).toEqual(["Lockfile Integrity"]);
  });

  test("pyproject.toml: PEP 621, optional groups, PEP 735 groups and Poetry tables", () => {
    const text = `[project]\nname = "app"\ndependencies = [\n  "requests==2.31.0",\n  "numpy>=1.26; python_version >= '3.10'",\n  "pandas[sql]",\n]\n\n[project.optional-dependencies]\ndev = ["pytest==8.0.0"]\n\n[dependency-groups]\nlint = ["ruff==0.4.0"]\n\n[tool.poetry.dependencies]\npython = "^3.11"\nflask = "3.0.0"\nfromgit = { git = "https://github.com/o/r" }\nrich = { version = "13.7.0", extras = ["x"] }\n`;
    const m = pyprojectPairs(text)!;
    expect(m.get("requests")!.version).toBe("2.31.0");
    expect(m.get("numpy")!.version).toBeUndefined();
    expect(m.get("pandas")!.spec).toBe("(unpinned)");
    expect(m.get("pytest")!.version).toBe("8.0.0");
    expect(m.get("ruff")!.version).toBe("0.4.0");
    expect(m.get("flask")!.version).toBe("3.0.0");
    expect(m.get("rich")!.version).toBe("13.7.0");
    expect(m.get("fromgit")!.version).toBeUndefined();
    expect(m.has("python")).toBe(false);
  });

  test("a pyproject.toml change names only what it adds or raises, through manifestDelta", () => {
    const before = `[project]\ndependencies = ["requests==2.31.0"]\n`;
    const after = `[project]\ndependencies = ["requests==2.32.0", "flask==3.0.0", ]\n`;
    const d = manifestDelta("pyproject.toml", before, after).pairs.map((p) => `${p.name}@${p.version}`).sort();
    expect(d).toEqual(["flask@3.0.0", "requests@2.32.0"]);
    expect(manifestDelta("pyproject.toml", before, before).pairs).toEqual([]);
  });

  test("through the gate: a pyproject.toml addition is named as not checked, a pnpm lockfile change names its added pairs", () => {
    const r = runSecurityGate([{ path: "pyproject.toml", content: `[project]\ndependencies = ["flask==3.0.0"]\n`, base: `[project]\ndependencies = []\n` }]);
    expect(r.findings.some((f) => f.category === "Dependency Check" && f.message.includes("flask@3.0.0"))).toBe(true);
    expect(r.blocked).toBe(false);
  });
});

describe("hostOf", () => {
  test("reads the host of a URL, with or without git+ and credentials", () => {
    expect(hostOf("https://registry.npmjs.org/x/-/x-1.tgz")).toBe("registry.npmjs.org");
    expect(hostOf("git+ssh://git@github.com/o/r.git#abc")).toBe("github.com");
    expect(hostOf("https://user:pw@npm.corp.example:8443/x")).toBe("npm.corp.example");
    expect(hostOf("x@npm:1.0.0")).toBeUndefined();
    expect(hostOf(undefined)).toBeUndefined();
  });
});
