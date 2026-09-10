// packages/core/src/language/providers/python.pack.ts
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import type { LanguagePack, ToolSpec } from "../pack.js";
import { spawnSync } from "../../platform/spawn_sync.js";
import { resolveToolchainTmp, toolchainSubdir } from "../../platform/toolchain_tmp.js";

export const PYTHON_PINNED_VERSIONS = {
  pyright: "1.1.380",
  pytest: "8.3.4",
  ruff: "0.8.4",
  pipAudit: "2.7.3",
};

function createToolSpec(name: string, packageSpecName: string, pinnedVersion: string): ToolSpec {
  return {
    name,
    pinnedVersion,
    resolveBinPath(baseDir: string): string {
      const isWin = process.platform === "win32";
      const venvDir = toolchainSubdir(baseDir, "python", "venv");
      const binDir = join(venvDir, isWin ? "Scripts" : "bin");
      return join(binDir, isWin ? `${name}.exe` : name);
    },
    isInstalled(baseDir: string): boolean {
      const binPath = this.resolveBinPath(baseDir);
      if (existsSync(binPath)) return true;
      // IMPORTANT: cwd must be the language's own .purix-tmp dir, never baseDir.
      // On Windows, invoking a bare "python"/"<toolname>" with no matching
      // interpreter on PATH can trigger the py launcher / pymanager shim to
      // silently self-install a full portable runtime into cwd. Pointing cwd
      // at .purix-tmp/python/ means that self-install (if it happens) lands
      // in a git-ignored, disposable location instead of inside source.
      const toolchainDir = resolveToolchainTmp(baseDir, "python");
      const res = spawnSync([name, "--version"], { cwd: toolchainDir, stdout: "pipe", stderr: "pipe" });
      return res.exitCode === 0;
    },
    async install(baseDir: string): Promise<{ ok: boolean; error?: string }> {
      const toolchainDir = resolveToolchainTmp(baseDir, "python");
      const venvDir = toolchainSubdir(baseDir, "python", "venv");
      if (!existsSync(venvDir)) {
        // Same reasoning as isInstalled: never run a bare "python" invocation
        // with cwd inside baseDir (e.g. packages/core) — keep any accidental
        // launcher self-install confined to .purix-tmp/python/.
        const venvRes = spawnSync(["python", "-m", "venv", venvDir], { cwd: toolchainDir, stdout: "pipe", stderr: "pipe" });
        if (venvRes.exitCode !== 0) {
          return { ok: false, error: `Failed to create virtual environment: ${venvRes.stderr.toString() || venvRes.stdout.toString()}` };
        }
      }
      const isWin = process.platform === "win32";
      const pipBin = join(venvDir, isWin ? "Scripts/pip.exe" : "bin/pip");
      if (!existsSync(pipBin)) {
        return { ok: false, error: `Could not find pip in venv at ${pipBin}` };
      }
      // pipBin is an absolute path into our own venv, not a bare command name,
      // so this one can't trigger the launcher shim — but keep cwd consistent
      // with the rest of this file's toolchain-isolation convention anyway.
      const installRes = spawnSync([pipBin, "install", `${packageSpecName}==${pinnedVersion}`], { cwd: toolchainDir, stdout: "pipe", stderr: "pipe" });
      if (installRes.exitCode !== 0) {
        return { ok: false, error: installRes.stderr.toString().trim() || installRes.stdout.toString().trim() || "pip install failed" };
      }
      return { ok: true };
    },
  };
}

export const pythonTools: ToolSpec[] = [
  createToolSpec("pyright", "pyright", PYTHON_PINNED_VERSIONS.pyright),
  createToolSpec("pytest", "pytest", PYTHON_PINNED_VERSIONS.pytest),
  createToolSpec("ruff", "ruff", PYTHON_PINNED_VERSIONS.ruff),
  createToolSpec("pip-audit", "pip-audit", PYTHON_PINNED_VERSIONS.pipAudit),
];

export const pythonPack: LanguagePack = {
  languageId: "python",
  minSupportedVersion: "3.10.0",
  tools: pythonTools,
  tier: "pro",

  checkRuntimePresent(baseDir: string): { present: boolean; message?: string } {
    // cwd must never default to wherever the caller happens to be (e.g.
    // packages/core) — a bare "python"/"python3" probe with no interpreter
    // on PATH can trigger Windows' py launcher / pymanager shim to
    // self-install a runtime into cwd. Route it through .purix-tmp/python/
    // so any such self-install is confined to a git-ignored, disposable dir.
    const toolchainDir = resolveToolchainTmp(baseDir, "python");
    const res = spawnSync(["python", "--version"], { cwd: toolchainDir, stdout: "pipe", stderr: "pipe" });
    if (res.exitCode === 0) return { present: true };
    const res3 = spawnSync(["python3", "--version"], { cwd: toolchainDir, stdout: "pipe", stderr: "pipe" });
    if (res3.exitCode === 0) return { present: true };
    return {
      present: false,
      message: "Python runtime not found on PATH. Please install Python >= 3.10 from https://www.python.org/downloads/",
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
  },

  isFullyInstalled(baseDir: string): boolean {
    return this.tools.every((t) => t.isInstalled(baseDir));
  },

  async install(baseDir: string): Promise<Array<{ tool: string; ok: boolean; error?: string }>> {
    const results: Array<{ tool: string; ok: boolean; error?: string }> = [];
    for (const tool of this.tools) {
      const res = await tool.install(baseDir);
      results.push({ tool: tool.name, ...res });
      if (!res.ok) break;
    }
    return results;
  },

  async uninstall(baseDir: string): Promise<{ ok: boolean; error?: string }> {
    try {
      const venvDir = toolchainSubdir(baseDir, "python", "venv");
      if (existsSync(venvDir)) {
        rmSync(venvDir, { recursive: true, force: true });
      }
      return { ok: true };
    } catch (err: any) {
      return { ok: false, error: err?.message ?? "unknown error" };
    }
  },
};