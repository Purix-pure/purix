// F01-06: the verification copy must leave out files that hold credentials, wherever they sit in the project, and say which.
// Research 01, section 5.2: a name list, with the excluded paths named in the run's result.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFileReason } from "./copy_exclusions.js";
import { populateVerificationCopy, verifyInSandbox } from "./sandbox.js";
import { registerLanguageProvider } from "../language/registry.js";
import type { LanguageProvider } from "../language/provider.js";
import { closeDb } from "../manifest/store.js";
import { safeRmSync } from "../platform/fs_retry.js";

describe("credentialFileReason", () => {
  const hit = [
    ".npmrc", "packages/a/.npmrc", ".pypirc", ".netrc", "certs/server.pem", "tls/key.PEM", "deploy/signing.key", "a/b.p12", "a/b.pfx",
    "id_rsa", "home/id_rsa.bak", "id_ed25519", "id_ecdsa", "id_dsa", ".aws/credentials", "x/.ssh/config", ".docker/config.json",
    "infra/prod.tfvars", "credentials.json", "gcp/credentials-prod.json", ".env", "packages/web/.env", "packages/web/.env.local",
  ];
  const keep = [
    "app.ts", "package.json", ".npmrc.example", "src/keyboard.ts", "src/monkey.ts", "docs/pem.md", "src/credentials.ts",
    "src/credentials_test.json.md", ".envrc.md", "environment.ts", ".docker/compose.yml",
  ];
  for (const p of hit) it(`leaves out ${p}`, () => expect(credentialFileReason(p)).toEqual(expect.any(String)));
  for (const p of keep) it(`keeps ${p}`, () => expect(credentialFileReason(p)).toBeUndefined());
  it("reads Windows separators", () => expect(credentialFileReason("a\\.ssh\\config")).toEqual(expect.any(String)));
});

let cwd: string, dir: string, copy: string;
beforeEach(() => {
  cwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-credcopy-"));
  copy = mkdtempSync(join(tmpdir(), "purix-credcopy-out-"));
  process.chdir(dir);
});
afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); safeRmSync(copy); });

describe("populateVerificationCopy and credential files (F01-06)", () => {
  it("leaves planted credential files out of the copy, keeps source, and returns the excluded paths", () => {
    const put = (rel: string, body = "x") => { mkdirSync(join(dir, rel, ".."), { recursive: true }); writeFileSync(join(dir, rel), body); };
    put("app.ts", "export const a = 1;\n");
    put("package.json", "{}");
    put(".npmrc", "//registry.npmjs.org/:_authToken=abc");
    put("id_rsa", "-----BEGIN OPENSSH PRIVATE KEY-----");
    put("certs/server.pem");
    put("packages/web/.env", "A=1");
    put(".ssh/config");
    put("infra/prod.tfvars");
    put(".npmrc.example", "registry=https://example.invalid");

    const excluded = populateVerificationCopy(dir, copy);

    for (const gone of [".npmrc", "id_rsa", "certs/server.pem", "packages/web/.env", ".ssh/config", "infra/prod.tfvars"]) {
      expect(existsSync(join(copy, gone))).toBe(false);
    }
    for (const kept of ["app.ts", "package.json", ".npmrc.example"]) expect(existsSync(join(copy, kept))).toBe(true);
    expect([...excluded].sort()).toEqual([".npmrc", "certs/server.pem", "id_rsa", "infra/prod.tfvars", "packages/web/.env"].concat([".ssh"]).sort());
  });
});

describe("verifyInSandbox names what was left out (F01-06)", () => {
  const provider = (verifyStatus: "pass" | "fail"): LanguageProvider => ({
    id: `credscope-${verifyStatus}`, minSupportedVersion: "1.0.0", detect: () => false,
    verify: () => (verifyStatus === "pass" ? { status: "pass", isolation: "none" } : { status: "fail", reason: "Cannot find .npmrc" }),
    runTests: () => ({ status: "pass", quarantinedFailures: [] }),
    checkIdiom: () => ({ ran: true, findings: [] }),
    auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
    getFingerprint: async () => ({}),
  });

  it("a failure says which credential-looking files were left out, in the reason and as a field", () => {
    writeFileSync(join(dir, ".npmrc"), "x");
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    registerLanguageProvider(provider("fail"));
    const r = verifyInSandbox("c", [{ path: "component.credscope", new_content: "x" }], dir, "credscope-fail");
    expect(r.status).toBe("fail");
    if (r.status !== "fail") return;
    expect(r.reason).toContain("Cannot find .npmrc");
    expect(r.reason).toContain("left out of the verification copy for safety: .npmrc");
    expect(r.excludedForSafety).toEqual([".npmrc"]);
  });

  it("a pass carries the list too, and a project with no such file carries nothing", () => {
    writeFileSync(join(dir, "app.ts"), "export const a = 1;\n");
    registerLanguageProvider(provider("pass"));
    const clean = verifyInSandbox("c", [{ path: "component.credscope", new_content: "x" }], dir, "credscope-pass");
    expect(clean.status === "fail" ? clean.reason : clean.status).toBe("pass");
    expect("excludedForSafety" in clean).toBe(false);
    writeFileSync(join(dir, "server.pem"), "x");
    const withPem = verifyInSandbox("c", [{ path: "component.credscope", new_content: "x" }], dir, "credscope-pass");
    expect(withPem.status).toBe("pass");
    if (withPem.status === "pass") expect(withPem.excludedForSafety).toEqual(["server.pem"]);
  });
});

describe("verifyInSandbox carries what the security gate saw and did not block (C4)", () => {
  const prov: LanguageProvider = {
    id: "c4scope", minSupportedVersion: "1.0.0", detect: () => false,
    verify: () => ({ status: "pass", isolation: "none" }),
    runTests: () => ({ status: "pass", quarantinedFailures: [] }),
    checkIdiom: () => ({ ran: true, findings: [] }),
    auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
    getFingerprint: async () => ({}),
  };
  it("a pass lists the data file the code rules did not read and the unreadable manifest as an advisory", () => {
    registerLanguageProvider(prov);
    const r = verifyInSandbox("c", [
      { path: "component.c4scope", new_content: "x" },
      { path: "config.yml", new_content: "a: 1\n" },
      { path: "package.json", new_content: "{bad" },
    ], dir, "c4scope");
    expect(r.status).toBe("pass");
    if (r.status !== "pass") return;
    expect(r.securityNotRead?.map((n) => n.path)).toEqual(["config.yml"]);
    expect(r.securityAdvisories?.map((a) => a.category)).toEqual(["Scan Limit"]);
  });
  it("a pass with nothing to say carries neither field", () => {
    registerLanguageProvider(prov);
    const r = verifyInSandbox("c", [{ path: "component.c4scope", new_content: "x" }], dir, "c4scope");
    expect(r.status).toBe("pass");
    expect("securityNotRead" in r).toBe(false);
    expect("securityAdvisories" in r).toBe(false);
  });
});
