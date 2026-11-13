// pythonProvider asks the tools broker for its tools (ADR-060). It no longer finds, probes or installs anything itself.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonProvider } from "./python.js";
import { providerKitHooks } from "../provider-kit.js";
import { safeRmSync } from "../../platform/fs_retry.js";
import { placeFakeInstall } from "../../tools/test_helpers.js";
import { toolDir } from "../../tools/state.js";

let dir: string;
let calls: Array<{ command: string[]; opts: any }>;
const realHook = providerKitHooks.runIsolatedOrNotInstalled;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-pybroker-"));
  writeFileSync(join(dir, "requirements.txt"), "flask==2.0.0\n");
  writeFileSync(join(dir, "a.py"), "x = 1\n");
  calls = [];
  (providerKitHooks as any).runIsolatedOrNotInstalled = (command: string[], opts: any) => {
    calls.push({ command, opts });
    return { exitCode: 0, stdout: "[]", stderr: "", isolation: "none" };
  };
});
afterEach(() => { (providerKitHooks as any).runIsolatedOrNotInstalled = realHook; safeRmSync(dir); });

describe("pythonProvider with no tools installed", () => {
  it("verify reports not_installed with the broker's hint, and runs nothing (no PATH probe)", () => {
    const r = pythonProvider.verify(["a.py"], dir, (() => { throw new Error("must not run"); }) as any);
    expect(r).toEqual({ status: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: "Run: purix tools install pyright" });
    expect(calls).toEqual([]);
  });
  it("runTests reports not_installed with the broker's hint", () => {
    writeFileSync(join(dir, "test_a.py"), "def test_a(): pass\n");
    const r = pythonProvider.runTests("c", ["a.py"], dir);
    expect(r.status).toBe("not_installed");
    expect(r.actionHint).toBe("Run: purix tools install pytest");
    expect(calls).toEqual([]);
  });
  it("checkIdiom reports not_installed with the broker's hint", () => {
    const r = pythonProvider.checkIdiom(["a.py"], dir);
    expect(r.ran).toBe(false);
    expect(r.actionHint).toBe("Run: purix tools install ruff");
    expect(calls).toEqual([]);
  });
  it("auditDependencies cannot run, and says so (ran:false), never a clean pass", async () => {
    const r = await pythonProvider.auditDependencies(dir);
    expect(r.ran).toBe(false);
    expect(r.vulnerabilities).toEqual([]);
    expect(calls).toEqual([]);
  });
  it("never mentions the removed `purix lang install` anywhere in its answers", () => {
    const all = JSON.stringify([
      pythonProvider.verify(["a.py"], dir, (() => { throw new Error("x"); }) as any),
      pythonProvider.runTests("c", ["a.py"], dir),
      pythonProvider.checkIdiom(["a.py"], dir),
    ]);
    expect(all).not.toMatch(/lang install/);
  });
});

describe("pythonProvider with a Purix-installed tool", () => {
  it("runs the installed binary and lets the sandbox read the tool's real folder", () => {
    const bin = placeFakeInstall(dir, "pyright");
    pythonProvider.verify(["a.py"], dir, providerKitHooks.runIsolatedOrNotInstalled);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.command[0]).toBe(bin);
    expect(calls[0]!.opts.extraReadOnlyBinds).toHaveLength(1);
    expect(calls[0]!.opts.extraReadOnlyBinds[0]).toContain(toolDir(dir, "pyright"));
  });
  it("ruff keeps its cache under the toolchain folder, outside the project source", () => {
    placeFakeInstall(dir, "ruff");
    pythonProvider.checkIdiom(["a.py"], dir);
    expect(calls[0]!.opts.env.RUFF_CACHE_DIR).toContain(join(".purix", "tmp", "python"));
  });
});
