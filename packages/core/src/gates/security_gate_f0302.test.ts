// src/gates/security_gate_f0302.test.ts
//
// F03-02 (research 03, task 3.4): the vulnerability scan was not part of the change pipeline, so a change that adds a vulnerable
// dependency passed with no word about dependencies at all. The check must look at what the change ADDED or RAISED (not the whole
// old tree), say "not checked" when no advisory source answered, and report advisory ids for exact versions when one did.
// A version range (^1.2.0) is resolved at install time, so the manifest alone cannot name a version: that is "not checked" too.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { manifestDelta } from "../security/dep_delta";

const pkg = (deps: Record<string, string>, extra: Record<string, unknown> = {}) => JSON.stringify({ name: "x", dependencies: deps, ...extra }, null, 2);

describe("manifestDelta: what a change added or raised", () => {
  it("package.json: a new name and a changed spec count, an unchanged one does not, a removal does not", () => {
    const d = manifestDelta("package.json", pkg({ a: "1.0.0", b: "2.0.0", c: "3.0.0" }), pkg({ a: "1.0.0", b: "2.1.0", d: "4.0.0" }));
    expect(d.pairs.map((p) => `${p.name}@${p.spec}`).sort()).toEqual(["b@2.1.0", "d@4.0.0"]);
  });
  it("a new file (no base) treats every dependency as added", () => {
    const d = manifestDelta("package.json", undefined, pkg({ a: "1.0.0" }));
    expect(d.pairs).toHaveLength(1);
  });
  it("an exact version has a version; a range does not", () => {
    const d = manifestDelta("package.json", undefined, pkg({ exact: "4.17.15", caret: "^4.17.15", tilde: "~1.2.3", star: "*", latest: "latest" }));
    const by = Object.fromEntries(d.pairs.map((p) => [p.name, p.version]));
    expect(by).toEqual({ exact: "4.17.15", caret: undefined, tilde: undefined, star: undefined, latest: undefined });
  });
  it("a git, URL, path or workspace source is not a registry version and is never looked up as one", () => {
    const d = manifestDelta("package.json", undefined, pkg({ g: "github:o/r", u: "https://x.test/a.tgz", f: "file:../a", w: "workspace:*" }));
    expect(d.pairs.every((p) => p.version === undefined)).toBe(true);
  });
  it("devDependencies and optionalDependencies are read too", () => {
    const text = JSON.stringify({ devDependencies: { dev: "1.0.0" }, optionalDependencies: { opt: "2.0.0" } });
    expect(manifestDelta("package.json", undefined, text).pairs.map((p) => p.name).sort()).toEqual(["dev", "opt"]);
  });
  it("package-lock.json: entries added or whose version changed, with exact versions, scoped names kept whole", () => {
    const lock = (e: Record<string, string>) => JSON.stringify({ lockfileVersion: 3, packages: { "": { name: "x" }, ...Object.fromEntries(Object.entries(e).map(([k, v]) => [k, { version: v }])) } });
    const d = manifestDelta(
      "package-lock.json",
      lock({ "node_modules/a": "1.0.0", "node_modules/b": "1.0.0" }),
      lock({ "node_modules/a": "1.0.0", "node_modules/b": "1.0.1", "node_modules/@s/c": "3.0.0", "node_modules/a/node_modules/lodash": "4.17.15" }),
    );
    expect(d.pairs.map((p) => `${p.name}@${p.version}`).sort()).toEqual(["@s/c@3.0.0", "b@1.0.1", "lodash@4.17.15"]);
  });
  it("requirements.txt: pinned names have a version, unpinned ones do not, comments and extras are handled", () => {
    const d = manifestDelta("requirements.txt", "flask==2.0.0\n", "flask==2.0.0\n# note\nRequests[security]==2.19.0 ; python_version > '3'\nnumpy>=1.20\n");
    const by = Object.fromEntries(d.pairs.map((p) => [p.name, p.version]));
    expect(by).toEqual({ requests: "2.19.0", numpy: undefined });
    expect(d.pairs.every((p) => p.ecosystem === "PyPI")).toBe(true);
  });
  it("a file that cannot be read says so instead of returning an empty, clean-looking list", () => {
    const d = manifestDelta("package.json", undefined, "{ not json");
    expect(d.unreadable).toBe(true);
    expect(d.pairs).toEqual([]);
  });
  it("a path that is not a manifest has no delta", () => {
    expect(manifestDelta("src/a.ts", undefined, "x").pairs).toEqual([]);
  });
});

describe("runSecurityGate: dependency check", () => {
  it("adding lodash@4.17.15 is named, and says no advisory lookup ran (not checked, not clean)", () => {
    const r = runSecurityGate([{ path: "package.json", content: pkg({ lodash: "4.17.15" }), base: pkg({}) }]);
    const f = r.advisories.filter((a) => a.category === "Dependency Check");
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("lodash@4.17.15");
    expect(f[0]?.message).toContain("not checked");
    expect(r.blocked).toBe(false);
  });
  it("a range is listed as not checkable from the manifest", () => {
    const r = runSecurityGate([{ path: "package.json", content: pkg({ lodash: "^4.17.15" }), base: pkg({}) }]);
    const f = r.advisories.find((a) => a.category === "Dependency Check");
    expect(f?.message).toContain("lodash");
    expect(f?.message).toContain("range");
  });
  it("only the change is looked at: an old dependency that the change leaves alone is not reported", () => {
    const r = runSecurityGate([{ path: "package.json", content: pkg({ lodash: "4.17.15", extra: "1.0.0" }), base: pkg({ lodash: "4.17.15" }) }]);
    const msg = r.advisories.find((a) => a.category === "Dependency Check")?.message ?? "";
    expect(msg).toContain("extra@1.0.0");
    expect(msg).not.toContain("lodash");
  });
  it("a change that touches no dependency says nothing about dependencies", () => {
    const text = pkg({ lodash: "4.17.15" }, { description: "a" });
    const r = runSecurityGate([{ path: "package.json", content: text, base: pkg({ lodash: "4.17.15" }) }]);
    expect(r.advisories.filter((a) => a.category === "Dependency Check" || a.category === "Known Vulnerability")).toEqual([]);
  });
  it("an advisory source that answers: the exact pair is reported with its ids, and the change is not blocked", () => {
    const r = runSecurityGate(
      [{ path: "package.json", content: pkg({ lodash: "4.17.15" }), base: pkg({}) }],
      undefined,
      { advisoryLookup: (pairs) => pairs.map((p) => ({ ecosystem: p.ecosystem, name: p.name, version: p.version ?? "", ids: ["GHSA-test-0001", "GHSA-test-0002"] })) },
    );
    const k = r.advisories.find((a) => a.category === "Known Vulnerability");
    expect(k?.message).toContain("lodash@4.17.15");
    expect(k?.message).toContain("GHSA-test-0001");
    expect(r.advisories.some((a) => a.category === "Dependency Check" && a.message.includes("lodash@4.17.15"))).toBe(false);
    expect(r.blocked).toBe(false);
  });
  it("an advisory source that answers with nothing for a pair says it was checked and found none; a range is still not checked", () => {
    const r = runSecurityGate(
      [{ path: "package.json", content: pkg({ a: "1.0.0", b: "^2.0.0" }), base: pkg({}) }],
      undefined,
      { advisoryLookup: () => [] },
    );
    expect(r.advisories.some((x) => x.category === "Known Vulnerability")).toBe(false);
    const msg = r.advisories.find((x) => x.category === "Dependency Check")?.message ?? "";
    expect(msg).toContain("b");
    expect(msg).not.toContain("a@1.0.0");
  });
  it("an advisory source that fails (returns undefined or throws) is not checked, never clean", () => {
    for (const lookup of [() => undefined, () => { throw new Error("offline"); }]) {
      const r = runSecurityGate([{ path: "package.json", content: pkg({ a: "1.0.0" }), base: pkg({}) }], undefined, { advisoryLookup: lookup });
      const f = r.advisories.find((x) => x.category === "Dependency Check");
      expect(f?.message).toContain("a@1.0.0");
      expect(f?.message).toContain("not checked");
    }
  });
  it("an unreadable manifest in a requirements or lock file is reported as not checked", () => {
    const r = runSecurityGate([{ path: "package-lock.json", content: "{ broken", base: undefined }]);
    expect(r.advisories.some((x) => x.category === "Dependency Check" && x.message.includes("could not be read"))).toBe(true);
  });
  it("the dependency finding is never forgiven as pre-existing", () => {
    const base = pkg({ a: "1.0.0" });
    const r = runSecurityGate([{ path: "package.json", content: pkg({ a: "1.0.0", b: "1.0.0" }), base }]);
    expect(r.advisories.find((x) => x.category === "Dependency Check")?.severity).toBe("Medium");
  });
});
