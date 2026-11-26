import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDb } from "../manifest/store.js";
import { storeDirectory } from "../manifest/store.js";
import { recordEvent } from "../manifest/events.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { openLedger } from "./ledger_reader.js";
import { filePattern, policyStopOf, tallyRiskyFiles, MAX_PATTERNS } from "./risky_files.js";

describe("filePattern", () => {
  it("groups credential-style names, and otherwise goes by extension; directories never matter", () => {
    expect(filePattern("config/.env")).toBe(".env*");
    expect(filePattern(".env.production")).toBe(".env*");
    expect(filePattern("a\\b\\.npmrc")).toBe("credential dotfile");
    expect(filePattern("home/.ssh/id_rsa")).toBe("ssh key");
    expect(filePattern("deploy/Dockerfile")).toBe("Docker files");
    expect(filePattern("docker-compose.prod.yml")).toBe("Docker files");
    expect(filePattern("src/billing/keys.PEM")).toBe("*.pem");
    expect(filePattern("src/app.ts")).toBe("*.ts");
    expect(filePattern("Makefile")).toBe("(no extension)");
    expect(filePattern("a/b/")).toBe("(unnamed)");
    expect(filePattern("weird.thisextensionistoolong")).toBe("(other)");
  });
  it("never lets a file or folder name into the pattern", () => {
    for (const p of ["src/secret-customer-acme/prod.json", "a/b/acme-keys.pem", "acme_notes.txt"]) expect(filePattern(p)).toMatch(/^\*\.[a-z]+$/);
  });
});

describe("tallyRiskyFiles", () => {
  it("counts a stop once per pattern even when it names several files of that pattern", () => {
    const r = tallyRiskyFiles([{ files: ["a.ts", "b.ts", ".env"], categories: { "AWS access key": 2 } }]);
    expect(r.stopsWithFiles).toBe(1);
    expect(r.patterns.find((p) => p.pattern === "*.ts")).toMatchObject({ stops: 1, categories: { "AWS access key": 1 } });
    expect(r.patterns.find((p) => p.pattern === ".env*")?.stops).toBe(1);
  });
  it("counts stops with no file separately instead of hiding them", () => {
    const r = tallyRiskyFiles([{ files: [], categories: {} }, { files: ["x.py"], categories: { sql: 1 } }]);
    expect(r).toMatchObject({ stopsWithFiles: 1, stopsWithoutFiles: 1 });
  });
  it("orders by stops then name, and caps the list", () => {
    const stops = Array.from({ length: 30 }, (_, i) => ({ files: [`f.e${i}`], categories: {} }));
    expect(tallyRiskyFiles(stops).patterns).toHaveLength(MAX_PATTERNS);
    const r = tallyRiskyFiles([{ files: ["a.b1"], categories: {} }, { files: ["a.a1"], categories: {} }, { files: ["z.a1"], categories: {} }]);
    expect(r.patterns.map((p) => p.pattern)).toEqual(["*.a1", "*.b1"]);
  });
  it("an empty record is an empty answer", () => {
    expect(tallyRiskyFiles([])).toEqual({ stopsWithFiles: 0, stopsWithoutFiles: 0, patterns: [] });
  });
});

describe("policyStopOf", () => {
  it("reads the documented detail and ignores anything else", () => {
    expect(policyStopOf({ files: ["a.ts", 3, null], categories: { x: 2, y: "no", z: Infinity } })).toEqual({ files: ["a.ts"], categories: { x: 2 } });
    expect(policyStopOf({})).toEqual({ files: [], categories: {} });
    expect(policyStopOf({ files: "a.ts", categories: [1] })).toEqual({ files: [], categories: {} });
  });
});

describe("riskyFiles in the ledger summary", () => {
  let cwd: string, dir: string;
  beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-risky-")); process.chdir(dir); getDb(); });
  afterEach(() => { closeDb(); process.chdir(cwd); safeRmSync(dir); });

  it("groups the files of policy_block events by pattern and carries no file name", () => {
    recordEvent("policy_block", { component_id: "c", detail: { source: "secret_scan", findings: 2, categories: { "AWS access key": 2 }, files: ["infra/prod.env", "src/keys.pem"] } });
    recordEvent("policy_block", { component_id: "c", detail: { source: "security_gate", findings: 1, categories: { "sql-injection": 1 }, files: ["src/db.ts"] } });
    recordEvent("policy_block", { component_id: "c", detail: { source: "security_gate", findings: 1, categories: { "sql-injection": 1 }, files: ["src/other.ts"] } });
    const ledger = openLedger(storeDirectory())!;
    try {
      const r = ledger.summary().riskyFiles;
      expect(r.stopsWithFiles).toBe(3);
      expect(r.patterns[0]).toMatchObject({ pattern: "*.ts", stops: 2, categories: { "sql-injection": 2 } });
      expect(JSON.stringify(r)).not.toMatch(/prod\.env|keys\.pem|db\.ts|infra|src\//);
    } finally { ledger.close(); }
  });

  it("is empty when nothing was stopped", () => {
    const ledger = openLedger(storeDirectory())!;
    try { expect(ledger.summary().riskyFiles).toEqual({ stopsWithFiles: 0, stopsWithoutFiles: 0, patterns: [] }); } finally { ledger.close(); }
  });
});
