// scripts/hide-sandbox-tools.mjs
//
// Several tests assume "this machine has no sandbox tool": the unisolated fallback, the stop markers, the env allow-list,
// the Python providers. GitHub's ubuntu runners ship bubblewrap but Ubuntu 24.04 blocks the user namespaces it needs, so
// runIsolated (rightly) throws SandboxUnavailableError and every one of those tests fails. The same tests would also fail on
// any developer machine that has a working bwrap (Linux) or the always-present sandbox-exec (macOS).
//
// This makes that assumption true instead of hoped for. It returns a PATH on which `bwrap` and `sandbox-exec` do not
// resolve, by mirroring (with symlinks) only the PATH folders that contain one of them. Tests that need a sandbox tool put
// their own fake one first on PATH (sandbox_exec_platform.test.ts), which still wins. Production code is untouched.
//
// Used by scripts/purix-04-run-all.mjs and packages/core/scripts/run-tests.mjs. A no-op on Windows and where neither tool exists.
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const HIDDEN = ["bwrap", "sandbox-exec"];

export function pathWithoutSandboxTools(pathValue = process.env.PATH ?? "") {
  if (process.platform === "win32") return pathValue;
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const out = [];
  for (const dir of dirs) {
    if (!HIDDEN.some((n) => existsSync(join(dir, n)))) {
      out.push(dir);
      continue;
    }
    out.push(mirrorWithout(dir));
  }
  return out.join(delimiter);
}

function mirrorWithout(dir) {
  const key = createHash("sha256").update(dir).digest("hex").slice(0, 12);
  const final = join(tmpdir(), `purix-nosandbox-${key}`);
  if (existsSync(final)) return final;
  const staging = `${final}.${process.pid}`;
  try {
    mkdirSync(staging, { recursive: true });
    for (const name of readdirSync(dir)) {
      if (HIDDEN.includes(name)) continue;
      try {
        symlinkSync(join(dir, name), join(staging, name));
      } catch {
        // an entry that cannot be mirrored is not worth stopping the run for
      }
    }
    try {
      renameSync(staging, final);
    } catch {
      rmSync(staging, { recursive: true, force: true }); // another process won the race: use its copy
    }
    return existsSync(final) ? final : dir;
  } catch {
    return dir;
  }
}

/** Sets process.env.PATH in place so every child process started afterwards inherits it. */
export function hideSandboxTools() {
  process.env.PATH = pathWithoutSandboxTools();
}

// CLI form: `node scripts/hide-sandbox-tools.mjs <command> [args...]` runs the command with the sandbox tools hidden (used by the conformance CI job).
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] && process.argv.length > 2) {
  hideSandboxTools();
  const [cmd, ...args] = process.argv.slice(2);
  const r = spawnSync(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
  process.exit(r.status ?? 1);
}
