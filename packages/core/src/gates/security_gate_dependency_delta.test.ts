// src/gates/security_gate_dependency_delta.test.ts
//
// F03-02 / F03-03 first part (research 03, tasks 3.1, 3.3, 3.4): a change that adds or raises a dependency, points one at something other than the
// registry, or edits an install-time script is judged by what it CHANGED, using what package.json held before (`base`).
//  - Not on the registry (git, GitHub shorthand, tarball URL): blocks (High). A path or link dependency: advisory (Medium), it is common in monorepos.
//  - preinstall / install / postinstall added or changed: blocks (High). The same script left as it was: no finding.
//  - A dependency added or raised: advisory (Medium) that says plainly it was NOT looked up for known vulnerabilities (built in dep_delta.ts,
//    asserted here through the whole gate). No lookup is made by default:
//    the gate is synchronous and ADR-009 keeps the network out of its path; the note is what stops the silence (ADR-062: could not check never reads as clean).
//  - A registry line changed in .npmrc: blocks (High).
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

const pkg = (o: Record<string, unknown>) => JSON.stringify(o, null, 2);
const run = (content: string, base?: string) =>
  runSecurityGate([{ path: "package.json", content, ...(base !== undefined ? { base } : {}) }]);
const cat = (r: ReturnType<typeof run>, category: string) => r.findings.filter((f) => f.category === category);

describe("dependencies that do not come from the registry", () => {
  for (const spec of ["git+https://github.com/evil/x.git", "github:evil/x", "evil/x", "evil/x#main", "https://evil.example/x.tgz", "git://evil.example/x.git", "gitlab:evil/x", "bitbucket:evil/x"]) {
    it(`blocks a newly added ${spec}`, () => {
      const r = run(pkg({ dependencies: { "left-padd": spec } }), pkg({ dependencies: {} }));
      expect(r.blocked).toBe(true);
      expect(cat(r, "Dependency Source")[0]?.severity).toBe("High");
    });
  }
  it("blocks a registry dependency changed to a git source", () => {
    const r = run(pkg({ dependencies: { zod: "github:evil/zod" } }), pkg({ dependencies: { zod: "^3.0.0" } }));
    expect(r.blocked).toBe(true);
  });
  it("leaves a git dependency the file already had alone", () => {
    const same = pkg({ dependencies: { zod: "github:me/zod" } });
    expect(cat(run(same, same), "Dependency Source")).toEqual([]);
  });
  it("blocks it in a devDependency, an optionalDependency and an override too", () => {
    for (const section of ["devDependencies", "optionalDependencies", "overrides"]) {
      const r = run(pkg({ [section]: { x: "github:evil/x" } }), pkg({}));
      expect(r.blocked).toBe(true);
    }
  });
  it("a path or link dependency is an advisory, not a block", () => {
    const r = run(pkg({ dependencies: { local: "file:../local" } }), pkg({}));
    expect(r.blocked).toBe(false);
    expect(cat(r, "Dependency Source")[0]?.severity).toBe("Medium");
  });
  it("workspace:, npm: alias and ordinary ranges are registry dependencies", () => {
    const r = run(pkg({ dependencies: { a: "workspace:*", b: "npm:left-pad@1.3.0", c: "^1.2.3", d: "1.x", e: ">=1 <3", f: "latest" } }), pkg({}));
    expect(cat(r, "Dependency Source")).toEqual([]);
  });
  it("a new package.json (no base) is judged whole", () => {
    expect(run(pkg({ dependencies: { x: "github:evil/x" } })).blocked).toBe(true);
  });
});

describe("install-time scripts", () => {
  for (const hook of ["preinstall", "install", "postinstall"]) {
    it(`blocks a ${hook} script that is added`, () => {
      const r = run(pkg({ scripts: { [hook]: "node steal.js" } }), pkg({ scripts: { test: "node --test" } }));
      expect(r.blocked).toBe(true);
      expect(cat(r, "Install Script")[0]?.severity).toBe("High");
    });
  }
  it("blocks a postinstall script that is changed", () => {
    const r = run(pkg({ scripts: { postinstall: "node steal.js" } }), pkg({ scripts: { postinstall: "node setup.js" } }));
    expect(r.blocked).toBe(true);
  });
  it("leaves a postinstall script that was already there and did not change", () => {
    const same = pkg({ scripts: { postinstall: "node setup.js" } });
    expect(cat(run(same, same), "Install Script")).toEqual([]);
  });
  it("an ordinary script change is not an install script", () => {
    const r = run(pkg({ scripts: { test: "node --test", build: "tsc" } }), pkg({ scripts: { test: "node --test" } }));
    expect(cat(r, "Install Script")).toEqual([]);
  });
});

describe("a dependency added or raised is named as not looked up (the note itself comes from dep_delta.ts)", () => {
  it("an added dependency is an advisory that says no vulnerability lookup was made", () => {
    const r = run(pkg({ dependencies: { lodash: "4.17.15" } }), pkg({ dependencies: {} }));
    expect(r.blocked).toBe(false);
    const f = cat(r, "Dependency Check");
    expect(f).toHaveLength(1);
    expect(f[0]?.severity).toBe("Medium");
    expect(f[0]?.message).toContain("lodash@4.17.15");
    expect(f[0]?.message).toMatch(/not checked for known vulnerabilities/i);
    expect(r.advisories.some((a) => a.category === "Dependency Check")).toBe(true);
  });
  it("a raised version counts, an unchanged one does not", () => {
    const raised = run(pkg({ dependencies: { zod: "3.23.0", chalk: "5.0.0" } }), pkg({ dependencies: { zod: "3.22.0", chalk: "5.0.0" } }));
    const f = cat(raised, "Dependency Check");
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("zod@3.23.0");
    expect(f[0]?.message).not.toContain("chalk");
  });
  it("a file with no dependency change has no such note", () => {
    const same = pkg({ name: "x", dependencies: { zod: "3.22.0" } });
    expect(cat(run(same, same), "Dependency Check")).toEqual([]);
  });
  it("many additions are one finding that names them (and says how many)", () => {
    const deps: Record<string, string> = {};
    for (let i = 0; i < 12; i++) deps[`pkg-number-${i}`] = "1.0.0";
    const f = cat(run(pkg({ dependencies: deps }), pkg({})), "Dependency Check");
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("12");
  });
  it("is never forgiven as pre-existing: it is about this change", () => {
    const r = run(pkg({ dependencies: { lodash: "4.17.15" } }), pkg({}));
    expect(cat(r, "Dependency Check")[0]?.message.startsWith("Pre-existing")).toBe(false);
  });
  it("a version override that is added or raised is named once, and is not forgiven as old", () => {
    const r = run(pkg({ overrides: { semver: "7.5.4" } }), pkg({}));
    const f = cat(r, "Override Added");
    expect(f).toHaveLength(1);
    expect(f[0]?.message).toContain("semver@7.5.4");
    expect(f[0]?.message.startsWith("Pre-existing")).toBe(false);
    expect(r.blocked).toBe(false);
  });
  it("the same dependency is never reported twice (one note, not one from each check)", () => {
    const r = run(pkg({ dependencies: { lodash: "4.17.15" } }), pkg({}));
    expect(r.findings.filter((f) => /lodash/.test(f.message) && f.severity === "Medium")).toHaveLength(1);
  });
});

describe("a registry line changed in .npmrc", () => {
  const rc = (content: string, base?: string) => runSecurityGate([{ path: ".npmrc", content, ...(base !== undefined ? { base } : {}) }]);
  it("blocks a new registry address", () => {
    const r = rc("registry=https://evil.example/npm/\n", "registry=https://registry.npmjs.org/\n");
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === "Registry Change" && f.severity === "High")).toBe(true);
  });
  it("blocks a scoped registry that is added", () => {
    expect(rc("@acme:registry=https://evil.example/npm/\n", "").blocked).toBe(true);
  });
  it("leaves the same registry line alone and ignores unrelated lines", () => {
    const same = "registry=https://registry.npmjs.org/\n";
    expect(rc(same, same).blocked).toBe(false);
    expect(rc(same + "save-exact=true\n", same).blocked).toBe(false);
  });
});
