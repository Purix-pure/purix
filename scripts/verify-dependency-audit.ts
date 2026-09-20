// scripts/verify-dependency-audit.ts
//
// Standalone verification that Purix's dependency_audit capability can
// actually detect a real, known vulnerability — not just that it runs.
// This is the item Document 4 §1.5 and run.ts's dependency_audit comment
// both name as still open: the conformance suite's fixed `ran` check
// proves the scanner isn't a no-op, but proves nothing about detection.
//
// Requires network access (real `npm install` / `pip install` against the
// live registries) — this could not be authored-and-verified inside a
// network-disabled sandbox, only authored. Run this somewhere with
// network before trusting it.
//
// Usage:  npx tsx scripts/verify-dependency-audit.ts
// Exit code 0 = every assertion below passed. Non-zero = read the output.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { typescriptProvider } from "../packages/core/src/language/providers/typescript.js";
import { pythonPack } from "../packages/core/src/language/providers/python.pack.js";
import { pythonProvider } from "../packages/core/src/language/providers/python.js";

let failures = 0;

function check(label: string, condition: boolean, detail: string): void {
  if (condition) {
    console.log(`  ✓ PASS — ${label}`);
  } else {
    failures++;
    console.log(`  ✗ FAIL — ${label}`);
    console.log(`    ${detail}`);
  }
}

/**
 * On Windows, `npm` resolves to `npm.cmd`, which Node's spawnSync cannot
 * reliably launch without `shell: true` — without it you get a silent
 * non-spawn: status: null, signal: null, no error text, easily
 * mistaken for a network failure (this is exactly what happened on the
 * first run of this script). `pip`/venv binaries are real .exe files on
 * Windows and don't need this. Only npm calls get the shell flag.
 */
function run(cmd: string[], cwd: string, opts: { needsShellOnWindows?: boolean } = {}): {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  signal: string | null;
  spawnError: string | null;
} {
  const useShell = !!opts.needsShellOnWindows && process.platform === "win32";
  const res = spawnSync(cmd[0]!, cmd.slice(1), { cwd, encoding: "utf-8", timeout: 90_000, shell: useShell });
  return {
    code: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    timedOut: res.signal === "SIGTERM" && res.status === null,
    signal: res.signal,
    // res.error is set when the process never spawned at all (e.g. ENOENT,
    // or the Windows .cmd-resolution issue above) — previously discarded,
    // which is exactly why the first run's failure printed as a blank line
    // instead of telling you what actually went wrong.
    spawnError: (res as any).error ? String((res as any).error.message ?? (res as any).error) : null,
  };
}

async function preflightNetworkCheck(): Promise<boolean> {
  console.log("Preflight: checking real network access to npm and PyPI registries...");
  const npmPing = run(["npm", "ping"], process.cwd(), { needsShellOnWindows: true });
  const npmOk = npmPing.code === 0;
  console.log(
    `  npm registry reachable: ${npmOk ? "yes" : "NO"}` +
      (npmOk
        ? ""
        : ` (exit ${npmPing.code}, signal ${npmPing.signal}${npmPing.spawnError ? `, spawnError: ${npmPing.spawnError}` : ""}) ${(npmPing.stderr || npmPing.stdout || "").trim().slice(0, 300)}`)
  );

  // Node's own global fetch (Node 18+) — not shelling out to `python3`,
  // which isn't guaranteed on Windows PATH (often just `python`) and
  // would give a false "PyPI unreachable" on a perfectly fine machine.
  let pypiOk = false;
  let pypiErr = "";
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch("https://pypi.org", { signal: controller.signal });
    clearTimeout(t);
    pypiOk = res.ok;
    if (!pypiOk) pypiErr = `HTTP ${res.status}`;
  } catch (err) {
    pypiErr = err instanceof Error ? err.message : String(err);
  }
  console.log(`  PyPI reachable: ${pypiOk ? "yes" : "NO"}${pypiOk ? "" : ` (${pypiErr})`}`);

  if (!npmOk || !pypiOk) {
    console.log(
      "\n  Preflight failed. If npm shows a spawnError above, this is a Windows\n" +
        "  process-spawning issue (npm.cmd needing a shell), not a network block —\n" +
        "  this script now works around it. If PyPI failed too, or npm still fails\n" +
        "  with no spawnError, that points at a real network/proxy restriction —\n" +
        "  run this in a plain terminal with normal internet access instead of\n" +
        "  through an agent's own tool-call wrapper, or allowlist\n" +
        "  registry.npmjs.org and pypi.org for the agent's network sandbox if it\n" +
        "  has one (see Document 3 §3's egress-allowlisting rule).\n"
    );
  }
  return npmOk && pypiOk;
}

async function verifyTypescript(): Promise<void> {
  console.log("\n=== TypeScript: dependency_audit ===");

  // --- Case 1: a real, known-vulnerable dependency ---
  // minimist < 1.2.6 (and < 0.2.4) carries CVE-2021-44906 / GHSA-xvch-5gv4-984h,
  // a prototype-pollution vulnerability, still an active advisory as of 2026.
  const vulnDir = mkdtempSync(join(tmpdir(), "purix-audit-verify-vuln-"));
  try {
    writeFileSync(
      join(vulnDir, "package.json"),
      JSON.stringify({ name: "audit-verify-vuln", version: "1.0.0", private: true, dependencies: { minimist: "0.0.8" } }, null, 2)
    );
    console.log(`  Installing a real, known-vulnerable dependency (minimist@0.0.8) into ${vulnDir}...`);
    const install = run(["npm", "install", "--no-audit", "--no-fund"], vulnDir, { needsShellOnWindows: true });
    if (install.code !== 0) {
      console.log("  ✗ FAIL — could not npm install minimist@0.0.8");
      console.log(`    exit code: ${install.code}, signal: ${install.signal}, timedOut: ${install.timedOut}`);
      if (install.spawnError) console.log(`    spawnError: ${install.spawnError}`);
      console.log(`    stderr: ${install.stderr.trim() || "(empty)"}`);
      console.log(`    stdout: ${install.stdout.trim() || "(empty)"}`);
      failures++;
    } else {
      const auditRes = await typescriptProvider.auditDependencies(vulnDir);
      check("scan actually executed (ran: true)", auditRes.ran === true, `auditRes: ${JSON.stringify(auditRes)}`);
      check(
        "the known minimist vulnerability was detected",
        auditRes.vulnerabilities.some((v) => v.module === "minimist"),
        `vulnerabilities found: ${JSON.stringify(auditRes.vulnerabilities)}`
      );
    }
  } finally {
    rmSync(vulnDir, { recursive: true, force: true });
  }

  // --- Case 2: a clean project — confirms no false positives ---
  const cleanDir = mkdtempSync(join(tmpdir(), "purix-audit-verify-clean-"));
  try {
    writeFileSync(join(cleanDir, "package.json"), JSON.stringify({ name: "audit-verify-clean", version: "1.0.0", private: true }, null, 2));
    writeFileSync(
      join(cleanDir, "package-lock.json"),
      JSON.stringify({ name: "audit-verify-clean", version: "1.0.0", lockfileVersion: 3, requires: true, packages: { "": { name: "audit-verify-clean", version: "1.0.0" } } }, null, 2)
    );
    const auditRes = await typescriptProvider.auditDependencies(cleanDir);
    check("clean project: scan executed (ran: true)", auditRes.ran === true, `auditRes: ${JSON.stringify(auditRes)}`);
    check("clean project: zero false-positive vulnerabilities", auditRes.vulnerabilities.length === 0, `unexpected findings: ${JSON.stringify(auditRes.vulnerabilities)}`);
  } finally {
    rmSync(cleanDir, { recursive: true, force: true });
  }

  // --- Case 3: no lockfile at all — confirms ran:false is honest, not silently true ---
  const noLockDir = mkdtempSync(join(tmpdir(), "purix-audit-verify-nolock-"));
  try {
    const auditRes = await typescriptProvider.auditDependencies(noLockDir);
    check("no lockfile: scan honestly reports it could not run (ran: false)", auditRes.ran === false, `auditRes: ${JSON.stringify(auditRes)}`);
  } finally {
    rmSync(noLockDir, { recursive: true, force: true });
  }
}

async function verifyPython(): Promise<void> {
  console.log("\n=== Python: dependency_audit ===");

  // --- Case 1: a real, known-vulnerable dependency ---
  // flask==0.5 is pip-audit's own maintainers' documented example
  // (PYSEC-2019-179 / PYSEC-2018-66) — about as canonical a choice as exists.
  const vulnDir = mkdtempSync(join(tmpdir(), "purix-audit-verify-py-vuln-"));
  try {
    writeFileSync(join(vulnDir, "requirements.txt"), "flask==0.5\n");
    console.log(`  Installing Purix's pinned Python toolchain (incl. pip-audit) into ${vulnDir}...`);
    await pythonPack.install(vulnDir);
    console.log(`  Installing a real, known-vulnerable dependency (flask==0.5) into ${vulnDir}'s venv...`);
    const venvPip = join(vulnDir, ".purix-tmp", "python", "venv", process.platform === "win32" ? "Scripts" : "bin", "pip");
    const install = run([venvPip, "install", "flask==0.5"], vulnDir);
    if (install.code !== 0) {
      console.log("  ✗ FAIL — could not pip install flask==0.5");
      console.log(`    exit code: ${install.code}, signal: ${install.signal}, timedOut: ${install.timedOut}`);
      if (install.spawnError) console.log(`    spawnError: ${install.spawnError}`);
      console.log(`    stderr: ${install.stderr.trim() || "(empty)"}`);
      console.log(`    stdout: ${install.stdout.trim() || "(empty)"}`);
      failures++;
    } else {
      const auditRes = await pythonProvider.auditDependencies(vulnDir);
      check("scan actually executed (ran: true)", auditRes.ran === true, `auditRes: ${JSON.stringify(auditRes)}`);
      check(
        "the known flask vulnerability was detected",
        auditRes.vulnerabilities.some((v) => v.module.toLowerCase() === "flask"),
        `vulnerabilities found: ${JSON.stringify(auditRes.vulnerabilities)}`
      );
    }
  } finally {
    rmSync(vulnDir, { recursive: true, force: true });
  }
}

(async () => {
  console.log("Purix dependency_audit — live verification (requires network)");
  const networkOk = await preflightNetworkCheck();
  if (!networkOk) {
    console.log("Aborting before the slow installs — fix the issue above and re-run rather than waiting on a timeout again.");
    process.exitCode = 1;
    return;
  }
  await verifyTypescript();
  await verifyPython();

  console.log("\n=== Summary ===");
  if (failures === 0) {
    console.log("All assertions passed. dependency_audit is confirmed to both run and detect a real, known vulnerability.");
  } else {
    console.log(`${failures} assertion(s) failed. dependency_audit is NOT yet confirmed — see FAIL lines above.`);
  }
  process.exitCode = failures === 0 ? 0 : 1;
})();