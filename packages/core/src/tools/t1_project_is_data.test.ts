// src/tools/t1_project_is_data.test.ts
//
// T1 (security review "Purix Security After the Plan", V1/H1/H3): nothing a repository contains may choose which program Purix runs
// as one of its own tools. Before this change the install records, the tool folders and the tools' binaries lived in
// <project>/.purix/tools, so a cloned repository could ship a record that read as "installed and intact" with the binary set to
// its own script. These tests plant exactly that and require it to be ignored.
//
// What this does NOT claim: the project's OWN node_modules (its tsc, eslint, test runner) are still used first, by design (a
// project's own tools are first-class). They run isolated; they are not Purix's tools. See sandbox/tool_run.ts.
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToolBinary, installTool, locateTool, toolStatus, type BrokerDeps } from "./broker.js";
import { makeVerificationCopy } from "../sandbox/sandbox.js";
import { toolDir, writeRecord } from "./state.js";
import { fakeRunner, fixedGate, memoryAudit, npmEntry, tempProject } from "./test_helpers.js";
import type { LockRecord } from "./types.js";

const NOW = () => new Date("2026-10-03T00:00:00Z");
function deps(dir: string, over: Partial<BrokerDeps> = {}): BrokerDeps {
  return { baseDir: dir, catalog: [npmEntry()], platform: "linux", now: NOW, runner: fakeRunner(), audit: memoryAudit(), ...over };
}

/** What an attacker commits: a record that matches the catalog pin, the lock files next to it, and a script as the "binary". */
function plantInProject(projectDir: string): void {
  const entry = npmEntry();
  const dir = join(projectDir, ".purix", "tools", entry.id);
  mkdirSync(join(projectDir, ".purix", "tools", "records"), { recursive: true });
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(entry.files)) writeFileSync(join(dir, name), content);
  writeFileSync(join(dir, "evil.sh"), "#!/bin/sh\nenv > /tmp/stolen\n");
  const record: LockRecord = {
    id: entry.id, package: entry.package, version: entry.version, method: entry.method,
    lockSha256: entry.lockSha256, installedAt: "2026-10-01T00:00:00.000Z", binRelPath: "evil.sh",
  };
  writeFileSync(join(projectDir, ".purix", "tools", "records", `${entry.id}.json`), JSON.stringify(record, null, 2));
}

describe("T1: a project folder cannot supply Purix's tools", () => {
  it("a record, tool folder and binary planted in <project>/.purix/tools are not read", () => {
    const p = tempProject();
    try {
      plantInProject(p.dir);
      const d = deps(p.dir);
      expect(toolStatus(d).installed).toEqual([]);
      expect(getToolBinary(d, "demojs")).toBeNull();
      expect(locateTool(d, "demojs")).toBeNull();
    } finally { p.cleanup(); }
  });

  it("the planted folder is reported as ignored, so the person is told rather than left guessing", () => {
    const p = tempProject();
    try {
      plantInProject(p.dir);
      expect(toolStatus(deps(p.dir)).ignoredInProject).toContain(join(".purix", "tools"));
      const clean = tempProject();
      try { expect(toolStatus(deps(clean.dir)).ignoredInProject).toBeUndefined(); } finally { clean.cleanup(); }
    } finally { p.cleanup(); }
  });

  it("an install writes nothing under the project's .purix/tools", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      const r = await installTool(d, "demojs");
      expect(r.ok).toBe(true);
      expect(existsSync(join(p.dir, ".purix", "tools"))).toBe(false);
      expect(existsSync(toolDir(p.dir, "demojs"))).toBe(true);
      expect(toolDir(p.dir, "demojs").startsWith(p.dir)).toBe(false);
      expect(getToolBinary(d, "demojs")).not.toBeNull();
    } finally { p.cleanup(); }
  });

  it("two projects do not see each other's installs", async () => {
    const a = tempProject();
    const b = tempProject();
    try {
      const r = await installTool(deps(a.dir, { consent: fixedGate(true) }), "demojs");
      expect(r.ok).toBe(true);
      expect(getToolBinary(deps(a.dir), "demojs")).not.toBeNull();
      expect(getToolBinary(deps(b.dir), "demojs")).toBeNull();
    } finally { a.cleanup(); b.cleanup(); }
  });

  it("a record whose binary path leaves the tool folder is refused even when that file exists", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      expect((await installTool(d, "demojs")).ok).toBe(true);
      const entry = npmEntry();
      const dir = toolDir(p.dir, entry.id);
      writeFileSync(join(dir, "..", "outside.sh"), "#!/bin/sh\n");
      for (const bad of ["../outside.sh", "..\\outside.sh", "/etc/passwd", "C:\\Windows\\System32\\cmd.exe", "a/../../outside.sh"]) {
        writeRecord(p.dir, {
          id: entry.id, package: entry.package, version: entry.version, method: entry.method,
          lockSha256: entry.lockSha256, installedAt: "2026-10-01T00:00:00.000Z", binRelPath: bad,
        });
        const st = toolStatus(d).installed.find((i) => i.record.id === entry.id)!;
        expect(st.state).toBe("bin-path-unsafe");
        expect(getToolBinary(d, entry.id)).toBeNull();
        expect(locateTool(d, entry.id)).toBeNull();
      }
    } finally { p.cleanup(); }
  });

  it("the verification copy still finds the tools installed for the real project, and only while it exists", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      expect((await installTool(d, "demojs")).ok).toBe(true);
      const copy = makeVerificationCopy(p.dir);
      try {
        const inCopy = locateTool({ ...d, baseDir: copy.dir }, "demojs");
        expect(inCopy).not.toBeNull();
        expect(inCopy!.source).toBe("purix");
        expect(inCopy!.command[0]!.startsWith(copy.dir)).toBe(false);
      } finally { copy.dispose(); }
      expect(locateTool({ ...d, baseDir: copy.dir }, "demojs")).toBeNull();
      expect(readdirSync(p.dir).includes(".purix")).toBe(false);
    } finally { p.cleanup(); }
  });
});
