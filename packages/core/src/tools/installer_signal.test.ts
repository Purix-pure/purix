// src/tools/installer_signal.test.ts
//
// N3 follow-up (F02-03): spawn_sync now marks a child that a signal ended with stopped: "signal". installEntry read `exitCode === null` as
// "npm was not found on PATH", so an npm ci that was killed (for example the kernel's out-of-memory killer) was reported as a missing
// program. A missing program is still "runtime-missing"; a killed one says it was ended by a signal. Runner is faked; no real process.
import { describe, it } from "node:test";
import { expect } from "expect";
import { installEntry, type Runner, type RunResult, type InstallContext } from "./installer.js";
import { npmEntry, pipEntry, tempProject } from "./test_helpers.js";

const NOW = new Date("2026-10-03T00:00:00Z");
function ctxWith(dir: string, onRun: (argv: string[]) => RunResult): InstallContext {
  const runner: Runner = { run: (argv) => onRun(argv) };
  return { baseDir: dir, platform: "linux", now: NOW, runner, minReleaseAgeDays: 7 };
}
const killed: RunResult = { exitCode: null, stdout: "", stderr: "", stopped: "signal", signal: "SIGKILL" };

describe("installEntry with a child ended by a signal", () => {
  it("npm ci killed by a signal is not 'npm was not found'", () => {
    const p = tempProject();
    try {
      const out = installEntry(npmEntry(), ctxWith(p.dir, () => killed));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.reason).not.toBe("runtime-missing");
        expect(out.message).toContain("SIGKILL");
        expect(out.message).toContain("npm ci");
      }
    } finally { p.cleanup(); }
  });
  it("pip install killed by a signal is not 'could not start the command'", () => {
    const p = tempProject();
    try {
      const out = installEntry(pipEntry(), ctxWith(p.dir, (argv) => (argv.includes("pip") ? killed : { exitCode: 0, stdout: "", stderr: "" })));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.message).toContain("SIGKILL");
        expect(out.message).not.toContain("could not start");
      }
    } finally { p.cleanup(); }
  });
  it("control: a missing npm (no stop marker) is still runtime-missing", () => {
    const p = tempProject();
    try {
      const out = installEntry(npmEntry(), ctxWith(p.dir, () => ({ exitCode: null, stdout: "", stderr: "" })));
      expect(!out.ok && out.reason).toBe("runtime-missing");
    } finally { p.cleanup(); }
  });
  it("control: a missing npm marked not_found is still runtime-missing", () => {
    const p = tempProject();
    try {
      const out = installEntry(npmEntry(), ctxWith(p.dir, () => ({ exitCode: null, stdout: "", stderr: "", stopped: "not_found" })));
      expect(!out.ok && out.reason).toBe("runtime-missing");
    } finally { p.cleanup(); }
  });
});
