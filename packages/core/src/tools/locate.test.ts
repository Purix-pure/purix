// src/tools/locate.test.ts: locateTool, missingToolHint, searchPurpose (ADR-060 consumer API)
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installTool, locateTool, missingToolHint, searchPurpose, type BrokerDeps } from "./broker.js";
import { aliasToolState, toolDir, unaliasToolState } from "./state.js";
import { fakeRunner, fixedGate, memoryAudit, npmEntry, pipEntry, tempProject } from "./test_helpers.js";

const NOW = () => new Date("2026-10-03T00:00:00Z");
function deps(dir: string, over: Partial<BrokerDeps> = {}): BrokerDeps {
  return { baseDir: dir, catalog: [pipEntry(), npmEntry()], platform: "linux", now: NOW, runner: fakeRunner(), audit: memoryAudit(), ...over };
}
function touch(path: string): void {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
}

describe("locateTool", () => {
  it("returns null for an empty project and creates nothing", () => {
    const p = tempProject();
    try {
      expect(locateTool(deps(p.dir), "demo")).toBeNull();
      expect(locateTool(deps(p.dir), "demojs")).toBeNull();
      expect(locateTool(deps(p.dir), "no-such-tool")).toBeNull();
      expect(existsSync(join(p.dir, ".purix"))).toBe(false);
    } finally { p.cleanup(); }
  });

  it("finds a Purix-installed tool, reports where to bind it, and marks the source", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      const r = await installTool(d, "demo");
      expect(r.ok).toBe(true);
      const loc = locateTool(d, "demo")!;
      expect(loc.source).toBe("purix");
      expect(loc.command).toHaveLength(1);
      expect(loc.command[0]).toContain(toolDir(p.dir, "demo"));
      expect(loc.toolHome).toBeDefined();
      expect(existsSync(loc.toolHome!)).toBe(true);
    } finally { p.cleanup(); }
  });

  it("prefers the project's own copy over a Purix-installed one (no second copy is used)", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      await installTool(d, "demojs");
      touch(join(p.dir, "node_modules", ".bin", "demojs"));
      const loc = locateTool(d, "demojs")!;
      expect(loc.source).toBe("project");
      expect(loc.command).toEqual([join(p.dir, "node_modules", ".bin", "demojs")]);
      expect(loc.toolHome).toBeUndefined();
    } finally { p.cleanup(); }
  });

  it("finds a project-provided npm tool when Purix installed nothing", () => {
    const p = tempProject();
    try {
      touch(join(p.dir, "node_modules", ".bin", "demojs"));
      expect(locateTool(deps(p.dir), "demojs")?.source).toBe("project");
    } finally { p.cleanup(); }
  });

  it("finds a Windows .cmd shim in the project", () => {
    const p = tempProject();
    try {
      touch(join(p.dir, "node_modules", ".bin", "demojs.cmd"));
      expect(locateTool(deps(p.dir), "demojs")?.command[0]).toMatch(/demojs\.cmd$/);
    } finally { p.cleanup(); }
  });

  it("typescript keeps the previous behaviour: run the project's own tsc script through node", () => {
    const p = tempProject();
    try {
      const ts = npmEntry({ id: "typescript", package: "typescript", bin: "tsc" });
      touch(join(p.dir, "node_modules", "typescript", "bin", "tsc"));
      touch(join(p.dir, "node_modules", ".bin", "tsc"));
      const loc = locateTool(deps(p.dir, { catalog: [ts] }), "typescript")!;
      expect(loc.command).toEqual(["node", join(p.dir, "node_modules", "typescript", "bin", "tsc")]);
      expect(loc.source).toBe("project");
    } finally { p.cleanup(); }
  });

  it("never falls back to a binary on PATH", () => {
    const p = tempProject();
    const before = process.env["PATH"];
    try {
      const fake = join(p.dir, "fakebin");
      touch(join(fake, "demo"));
      touch(join(fake, "demojs"));
      process.env["PATH"] = `${fake}${process.platform === "win32" ? ";" : ":"}${before ?? ""}`;
      expect(locateTool(deps(p.dir), "demo")).toBeNull();
      expect(locateTool(deps(p.dir), "demojs")).toBeNull();
    } finally { process.env["PATH"] = before; p.cleanup(); }
  });

  it("a tool tampered with after install is not handed out", async () => {
    const p = tempProject();
    try {
      const d = deps(p.dir, { consent: fixedGate(true) });
      await installTool(d, "demo");
      writeFileSync(join(toolDir(p.dir, "demo"), "requirements.txt"), "evil==9.9.9\n");
      expect(locateTool(d, "demo")).toBeNull();
    } finally { p.cleanup(); }
  });

  it("works through the alias the verification copy uses to see the real project's tools", async () => {
    const real = tempProject();
    const copy = tempProject();
    try {
      const d = deps(real.dir, { consent: fixedGate(true) });
      await installTool(d, "demo");
      aliasToolState(copy.dir, real.dir);
      const loc = locateTool(deps(copy.dir), "demo")!;
      expect(loc).not.toBeNull();
      expect(existsSync(loc.command[0]!)).toBe(true);
      // toolHome is the REAL tool folder (in the user's tools state), which is what a sandbox must bind.
      expect(loc.toolHome).toBe(realpathSync(toolDir(real.dir, "demo")));
      expect(loc.toolHome!.startsWith(copy.dir)).toBe(false);
    } finally { unaliasToolState(copy.dir); real.cleanup(); copy.cleanup(); }
  });
});

describe("missingToolHint", () => {
  it("names the install command", () => {
    const p = tempProject();
    try {
      expect(missingToolHint(deps(p.dir), "demo")).toBe("Run: purix tools install demo");
    } finally { p.cleanup(); }
  });
  it("tells a project that declares the tool to install its own dependencies first", () => {
    const p = tempProject();
    try {
      writeFileSync(join(p.dir, "package.json"), JSON.stringify({ devDependencies: { demojs: "^2.0.0" } }));
      const hint = missingToolHint(deps(p.dir), "demojs");
      expect(hint).toMatch(/declared by your project/);
      expect(hint).toMatch(/purix tools install demojs/);
    } finally { p.cleanup(); }
  });
  it("never suggests editing the project's package manifest", () => {
    const p = tempProject();
    try {
      expect(missingToolHint(deps(p.dir), "demojs")).not.toMatch(/npm install -D|pnpm add|yarn add/);
    } finally { p.cleanup(); }
  });
  it("says so for an unknown id", () => {
    const p = tempProject();
    try {
      expect(missingToolHint(deps(p.dir), "nope")).toMatch(/not in the Purix tool catalog/);
    } finally { p.cleanup(); }
  });
});

describe("searchPurpose", () => {
  it("reports each match's state and creates nothing", () => {
    const p = tempProject();
    try {
      touch(join(p.dir, "node_modules", ".bin", "vitest"));
      const r = searchPurpose({ baseDir: p.dir, platform: "linux" }, "run tests");
      const byId = Object.fromEntries(r.matches.map((m) => [m.entry.id, m.state]));
      expect(byId["vitest"]).toBe("project-provided");
      expect(byId["pytest"]).toBe("missing");
      expect(existsSync(join(p.dir, ".purix"))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("returns no matches for something outside the catalog", () => {
    const p = tempProject();
    try {
      expect(searchPurpose({ baseDir: p.dir }, "mypy").matches).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("among equally good tools, the one the project already declares comes first and says so", () => {
    const p = tempProject();
    try {
      writeFileSync(join(p.dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }));
      const r = searchPurpose({ baseDir: p.dir, platform: "linux" }, "run tests");
      expect(r.matches[0]!.entry.id).toBe("vitest");
      expect(r.matches[0]!.reasons.join(" ")).toMatch(/your project already declares it/);
    } finally { p.cleanup(); }
  });
  it("a tool the user named outranks one the project merely declares", () => {
    const p = tempProject();
    try {
      writeFileSync(join(p.dir, "package.json"), JSON.stringify({ devDependencies: { vitest: "^2.0.0" } }));
      const r = searchPurpose({ baseDir: p.dir, platform: "linux" }, "run tests with mocha");
      expect(r.matches[0]!.entry.id).toBe("mocha");
    } finally { p.cleanup(); }
  });
});
