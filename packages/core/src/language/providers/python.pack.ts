// packages/core/src/language/providers/python.pack.ts
//
// What Python needs from the machine and project. Which Python tools exist, their pinned versions,
// where they are installed and how they are installed is the tools broker's job (src/tools); this
// pack no longer carries any of it.
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { LanguagePack } from "../pack.js";
import { spawnSync } from "../../platform/spawn_sync.js";
import { toolchainProbeCwd } from "../../platform/toolchain_tmp.js";

export const pythonPack: LanguagePack = {
  languageId: "python",
  minSupportedVersion: "3.10.0",
  tier: "free",

  checkRuntimePresent(baseDir: string): { present: boolean; message?: string } {
    // cwd must never default to wherever the caller happens to be (e.g.
    // packages/core) — a bare "python"/"python3" probe with no interpreter
    // on PATH can trigger Windows' py launcher / pymanager shim to
    // self-install a runtime into cwd. Route it through .purix/tmp/python/
    // so any such self-install is confined to a disposable dir. Creates nothing (see toolchainProbeCwd).
    const probeCwd = toolchainProbeCwd(baseDir, "python");
    // tier T1, and a probe that was stopped (deadline, signal, output cap) is said to have been stopped: it used to fall through to
    // "not found on PATH", which tells the person to install something that is already there.
    let stoppedNote: string | undefined;
    for (const bin of ["python", "python3"]) {
      const res = spawnSync([bin, "--version"], { cwd: probeCwd, stdout: "pipe", stderr: "pipe", tier: "T1" });
      if (res.exitCode === 0) return { present: true };
      if (res.stopped && res.stopped !== "not_found" && !stoppedNote) {
        stoppedNote = `Python did not answer \`${bin} --version\` (stopped: ${res.stopped.replace("_", " ")}), so it could not be checked. Purix cannot tell whether Python is installed; try \`${bin} --version\` yourself.`;
      }
    }
    return {
      present: false,
      message: stoppedNote ?? "Python runtime not found on PATH. Please install Python >= 3.10 from https://www.python.org/downloads/",
    };
  },

  checkProjectValid(baseDir: string): { valid: boolean; reason?: string } {
    const hasPy =
      existsSync(resolve(baseDir, "pyproject.toml")) ||
      existsSync(resolve(baseDir, "requirements.txt")) ||
      existsSync(resolve(baseDir, "setup.py"));
    if (hasPy) return { valid: true };
    return {
      valid: false,
      reason: "No Python project markers found (pyproject.toml, requirements.txt, setup.py).",
    };
  },

  capabilities: {
    compileOrTypeCheck: true,
    testExecution: true,
    testIntegrityCheck: true,
    idiomCheck: true,
    dependencyVulnScan: true,
  }
};
