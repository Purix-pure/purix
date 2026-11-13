// packages/core/src/tools/test_helpers.ts — test-only helpers for the tools broker (not exported to consumers).
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import type { AuditSink, ToolsAuditEvent } from "./audit.js";
import { hashLockFiles, shippedCatalog } from "./catalog.js";
import { binRelPath } from "./installer.js";
import { readLock, toolDir, writeLock } from "./state.js";
import type { ConsentGate, InstallSummary } from "./consent.js";
import type { RunResult, Runner } from "./installer.js";
import type { CatalogEntry, Platform } from "./types.js";

export function tempProject(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "purix-tools-test-"));
  return { dir, cleanup: () => safeRmSync(dir) };
}

const H = "a".repeat(64);

export function pipEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  const files = { "requirements.txt": `demo==1.2.3 \\\n    --hash=sha256:${H}\n` };
  return {
    id: "demo", displayName: "Demo", description: "demo", group: "coding", capabilities: ["lint"], languages: ["python"],
    platforms: ["linux", "darwin", "win32"], method: "pip-venv", package: "demo", version: "1.2.3", bin: "demo", license: "MIT",
    releasedAt: "2024-01-01T00:00:00.000Z", priority: 10, files, lockSha256: hashLockFiles(files), ...over,
  };
}

export function npmEntry(over: Partial<CatalogEntry> = {}): CatalogEntry {
  const files = {
    "package.json": JSON.stringify({ name: "x", version: "1.0.0", private: true, dependencies: { demojs: "2.0.0" } }),
    "package-lock.json": JSON.stringify({ lockfileVersion: 3, packages: { "": {}, "node_modules/demojs": { version: "2.0.0", resolved: "https://registry.npmjs.org/demojs/-/demojs-2.0.0.tgz", integrity: "sha512-AAAA" } } }),
  };
  return {
    id: "demojs", displayName: "DemoJS", description: "demo", group: "testing", capabilities: ["run-tests"], languages: ["typescript"],
    platforms: ["linux", "darwin", "win32"], method: "npm-ci", package: "demojs", version: "2.0.0", bin: "demojs", license: "MIT",
    releasedAt: "2024-01-01T00:00:00.000Z", priority: 10, files, lockSha256: hashLockFiles(files), ...over,
  };
}

/** Records every command; "succeeds" by creating the file(s) a real install would leave behind. */
export function fakeRunner(opts: { python?: boolean; npmMissing?: boolean; failOn?: string } = {}): Runner & { calls: string[][] } {
  const calls: string[][] = [];
  const ok: RunResult = { exitCode: 0, stdout: "", stderr: "" };
  return {
    calls,
    run(argv, o) {
      calls.push(argv);
      const joined = argv.join(" ");
      if (opts.failOn && joined.includes(opts.failOn)) return { exitCode: 1, stdout: "", stderr: `boom: ${opts.failOn}` };
      if (argv[1] === "--version") return opts.python === false ? { exitCode: null, stdout: "", stderr: "" } : ok;
      if (argv[1] === "-m" && argv[2] === "venv") {
        const venv = argv[3]!;
        mkdirSync(join(venv, "bin"), { recursive: true });
        mkdirSync(join(venv, "Scripts"), { recursive: true });
        return ok;
      }
      if (argv.includes("pip")) {
        for (const sub of ["bin", "Scripts"]) {
          const venv = dirname(dirname(argv[0]!));
          mkdirSync(join(venv, sub), { recursive: true });
          writeFileSync(join(venv, sub, sub === "bin" ? "demo" : "demo.exe"), "");
        }
        return ok;
      }
      if (argv[0] === "npm") {
        if (opts.npmMissing) return { exitCode: null, stdout: "", stderr: "" };
        mkdirSync(join(o.cwd, "node_modules", ".bin"), { recursive: true });
        writeFileSync(join(o.cwd, "node_modules", ".bin", "demojs"), "");
        writeFileSync(join(o.cwd, "node_modules", ".bin", "demojs.cmd"), "");
        return ok;
      }
      return ok;
    },
  };
}

export function memoryAudit(opts: { failOn?: ToolsAuditEvent["action"] } = {}): AuditSink & { events: ToolsAuditEvent[] } {
  const events: ToolsAuditEvent[] = [];
  return {
    events,
    record(e) {
      if (opts.failOn === e.action) throw new Error("audit down");
      events.push(e);
    },
  };
}

export function fixedGate(answer: boolean): ConsentGate & { summaries: InstallSummary[] } {
  const summaries: InstallSummary[] = [];
  return { summaries, confirmInstall(s) { summaries.push(s); return Promise.resolve(answer); } };
}

/**
 * Lays down what a real `purix tools install <id>` leaves behind, without running an installer:
 * the locked files next to the tool, the binary, and the lock record. For tests of consumers
 * (providers, verify) that need locateTool to find a tool. Uses the shipped catalog by default, so
 * the record carries the real lock hash and the tool reads as intact.
 */
export function placeFakeInstall(baseDir: string, id: string, catalog: readonly CatalogEntry[] = shippedCatalog(), platform: Platform = process.platform as Platform): string {
  const entry = catalog.find((e) => e.id === id);
  if (!entry) throw new Error(`placeFakeInstall: ${id} is not in the catalog`);
  const dir = toolDir(baseDir, id);
  mkdirSync(dir, { recursive: true });
  for (const [name, text] of Object.entries(entry.files)) writeFileSync(join(dir, name), text);
  const rel = binRelPath(entry, platform);
  const bin = join(dir, ...rel.split("/"));
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(bin, "");
  const existing = readLock(baseDir);
  const records = existing.kind === "ok" ? existing.lock.records.filter((r) => r.id !== id) : [];
  records.push({ id, package: entry.package, version: entry.version, method: entry.method, lockSha256: entry.lockSha256, installedAt: "2026-10-03T00:00:00.000Z", binRelPath: rel });
  writeLock(baseDir, { version: 1, records });
  return bin;
}
