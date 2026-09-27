#!/usr/bin/env node
// Purix release check — runs the release tests automatically and writes a plain-language report.
//
//   node scripts/release-check.mjs fast     ~3 min   "is the build broken?"
//   node scripts/release-check.mjs full     ~6 min   "is it ready to finalize?"  (fast + extra gates)
//   node scripts/release-check.mjs full --tag v0.2.0-beta.0   also checks the tag matches the package versions
//
// Every step ends as PASS, FAIL, or NOT CHECKED. A step that could not run is never a PASS.
// The script never publishes, never tags, never touches the registry with write access.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "full" ? "full" : "fast";
const tagIdx = process.argv.indexOf("--tag");
const tag = tagIdx > -1 ? process.argv[tagIdx + 1] : null;

function findRoot(dir) {
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "turbo.json")) && existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    dir = dirname(dir);
  }
  throw new Error("Run this from inside the purix repo (could not find turbo.json + pnpm-workspace.yaml).");
}
const root = findRoot(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, ".release-check");
const tarDir = join(outDir, "tarballs");
rmSync(outDir, { recursive: true, force: true });
mkdirSync(tarDir, { recursive: true });

const results = [];
const isWin = process.platform === "win32";

function run(cmd, opts = {}) {
  const t = Date.now();
  const r = spawnSync(cmd, { cwd: opts.cwd ?? root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 15 * 60_000 });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, out, secs: Math.round((Date.now() - t) / 1000) };
}
function record(name, status, detail, secs = 0, why = "") {
  results.push({ name, status, detail, secs, why });
  const icon = status === "PASS" ? "PASS       " : status === "FAIL" ? "FAIL       " : "NOT CHECKED";
  console.log(`[${icon}] ${name}${secs ? ` (${secs}s)` : ""}`);
  if (status !== "PASS") console.log(`             ${detail.split("\n")[0]}`);
}
let logN = 0;
function step(name, cmd, why, opts = {}) {
  console.log(`... ${name}`);
  const r = run(cmd, opts);
  mkdirSync(join(outDir, "logs"), { recursive: true });
  const logFile = `logs/${String(++logN).padStart(2, "0")}-${name.replace(/[^a-z0-9]+/gi, "-").slice(0, 40)}.log`;
  writeFileSync(join(outDir, logFile), r.out);
  let tail = opts.extract ? opts.extract(r.out) : r.out.trim().split("\n").slice(-12).join("\n");
  if (r.code !== 0 && r.out.includes("ERR_PNPM_IGNORED_BUILDS"))
    tail = "pnpm refused to continue because two dependencies have install scripts nobody has approved yet.\nFIX: in the repo folder run `pnpm approve-builds`, choose the packages, then commit the file it changes (pnpm-workspace.yaml). Then run this check again.\n" + tail;
  if (r.code !== 0) tail += `\n(full log: .release-check/${logFile})`;
  record(name, r.code === 0 ? "PASS" : "FAIL", r.code === 0 ? "ok" : tail, r.secs, why);
  return r;
}
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const pkgs = ["core", "mcp-server", "cli"];
const versions = Object.fromEntries(pkgs.map((p) => [p, readJson(join(root, "packages", p, "package.json")).version]));

console.log(`\nPurix release check — mode: ${mode}\nRepo: ${root}\nNode ${process.version}\n`);

// ---------- Part 1: fast path ----------
step("Install with the locked dependency list", "pnpm install --frozen-lockfile", "Proves anyone can rebuild the exact same dependencies.");
step("Core stays independent of cli/api (boundary check)", "pnpm run boundary-check", "Architecture rule: core must not import cli.");
step("No build junk committed (artifact check)", "pnpm run artifact-check", "Keeps toolchain leftovers out of the repo.");
step("Type check, all packages", "pnpm exec turbo run typecheck --force", "Catches type errors before users do.");
step("Build, all packages", "pnpm exec turbo run build --force", "Produces the files that get published.");

// Pack the real artifacts once, then test THOSE files.
let packOk = true;
console.log("... Pack the three packages into tarballs");
{
  const t = Date.now();
  for (const p of pkgs) {
    const r = run(`pnpm pack --pack-destination "${tarDir}"`, { cwd: join(root, "packages", p) });
    if (r.code !== 0) { packOk = false; record(`Pack @purix/${p}`, "FAIL", r.out.trim().split("\n").slice(-6).join("\n"), 0); }
  }
  if (packOk) record("Pack the three packages into tarballs", "PASS", "ok", Math.round((Date.now() - t) / 1000));
}
const tarballs = packOk ? readdirSync(tarDir).filter((f) => f.endsWith(".tgz")).sort() : [];

if (packOk) {
  console.log("... Install tarballs into an empty folder and run the CLI (what a real user does)");
  const t = Date.now();
  const clean = mkdtempSync(join(tmpdir(), "purix-clean-"));
  writeFileSync(join(clean, "package.json"), JSON.stringify({ name: "clean-room", version: "1.0.0", private: true }));
  const inst = run(`npm install ${tarballs.map((f) => `"${join(tarDir, f)}"`).join(" ")} --no-audit --no-fund`, { cwd: clean });
  let detail = "ok", ok = inst.code === 0;
  if (ok) {
    const cliJs = join(clean, "node_modules", "@purix", "cli", "dist", "cli.js");
    const ver = run(`node "${cliJs}" --version`, { cwd: clean });
    const help = run(`node "${cliJs}" --help`, { cwd: clean });
    const status = run(`node "${cliJs}" status`, { cwd: clean });
    if (ver.code !== 0 || ver.out.trim() !== versions.cli) { ok = false; detail = `--version printed "${ver.out.trim()}", expected "${versions.cli}"`; }
    else if (help.code !== 0) { ok = false; detail = "--help failed:\n" + help.out.slice(-400); }
    else if (status.code !== 0) { ok = false; detail = "status failed:\n" + status.out.slice(-400); }
  } else detail = inst.out.trim().split("\n").slice(-8).join("\n");
  rmSync(clean, { recursive: true, force: true });
  record("Clean install of the packed files works (version, --help, status)", ok ? "PASS" : "FAIL", detail, Math.round((Date.now() - t) / 1000));
}

{
  const r = step("MCP server handshake + tool calls (smoke test)", "node scripts/smoke-test.mjs", "Proves a coding agent can connect and call tools.");
  rmSync(join(root, "purix-mcp-report.md"), { force: true });
  const m = r.out.match(/Tool discovery \(found (\d+)\)/);
  if (m) console.log(`             tools discovered: ${m[1]}`);
}
step("Full test suite", "pnpm exec turbo run test --force", "All unit and integration tests, every package.", { timeoutMs: 25 * 60_000 });

// ---------- Part 2: finalization gates that a script CAN check ----------
if (mode === "full") {
  step("Coverage gate (90% lines, branches, functions on security code)", "pnpm run coverage", "Confirms the verification and sandbox code is actually tested.", {
    extract: (o) => { const m = o.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/); return m ? `Lines ${m[1]}%, branches ${m[2]}%, functions ${m[3]}% — each must be 90 or more.` : o.trim().split("\n").slice(-6).join("\n"); },
  });
  step("Language conformance suite (TypeScript + Python)", "pnpm exec tsx packages/core/src/language/conformance/run.ts", "Confirms Purix's checks behave the same per language.", {
    timeoutMs: 10 * 60_000,
    extract: (o) => { const errs = [...o.matchAll(/"error":\s*"([^"\\]{0,60}(?:\\.[^"\\]{0,120})*)/g)].map((m) => m[1].replace(/\\"/g, '"').slice(0, 220)); return (/Certified: (true|false)/.exec(o)?.[0] ?? "no result") + (errs.length ? "\n" + errs.join("\n") : ""); },
  });

  // Versions consistent
  const uniq = new Set(Object.values(versions));
  let vDetail = `versions: ${JSON.stringify(versions)}`;
  let vOk = uniq.size === 1;
  if (vOk && tag) { vOk = tag.replace(/^v/, "") === [...uniq][0]; if (!vOk) vDetail = `tag ${tag} does not match package version ${[...uniq][0]}`; }
  record(tag ? `All three package versions match tag ${tag}` : "All three package versions match each other", vOk ? "PASS" : "FAIL", vOk ? "ok" : vDetail);

  // Tarball contents + digests
  if (packOk) {
    let bad = [];
    const digests = [];
    for (const f of tarballs) {
      const full = join(tarDir, f);
      const list = run(`tar -tzf "${full}"`).out.split("\n").map((s) => s.trim()).filter(Boolean);
      const has = (re) => list.some((x) => re.test(x));
      if (!has(/package\/package\.json$/)) bad.push(`${f}: no package.json`);
      if (!has(/package\/LICENSE$/)) bad.push(`${f}: no LICENSE`);
      if (!has(/package\/dist\//)) bad.push(`${f}: no dist/ folder`);
      if (has(/package\/src\//)) bad.push(`${f}: contains src/ (should ship dist only)`);
      if (has(/(^|\/)\.env($|\.)/) && !has(/\.env\.example$/)) bad.push(`${f}: contains a .env file`);
      // The conformance fixtures under dist/language/conformance/fixtures/ are shipped ON PURPOSE (scripts/copy-fixtures.mjs):
      // `purix lang verify <id>` runs them on the user's machine and fails with "file does not exist" without them.
      // They include *.test.ts files (broken_test_fixture.test.ts, passing_fixture.test.ts), so exclude that folder from the
      // "no test files" rule — and instead require it to be present in the core package.
      const isConformanceFixture = (x) => /package\/dist\/language\/conformance\/fixtures\//.test(x);
      if (list.some((x) => /\.test\.(js|ts)$/.test(x) && !isConformanceFixture(x))) bad.push(`${f}: contains test files`);
      if (/purix-core-/.test(f) && !list.some(isConformanceFixture)) bad.push(`${f}: missing dist/language/conformance/fixtures (purix lang verify needs them)`);
      digests.push(`${f}  sha256:${createHash("sha256").update(readFileSync(full)).digest("hex")}`);
    }
    writeFileSync(join(outDir, "tarball-digests.txt"), digests.join("\n") + "\n");
    record("Tarball contents are clean (dist only, LICENSE present, no secrets/tests)", bad.length ? "FAIL" : "PASS", bad.length ? bad.join("\n") : "digests saved to .release-check/tarball-digests.txt");
  }

  // Workflow parity: publish.yml must enforce what ci.yml enforces
  const pub = existsSync(join(root, ".github/workflows/publish.yml")) ? readFileSync(join(root, ".github/workflows/publish.yml"), "utf8") : "";
  const gaps = [];
  if (!/run:\s*pnpm run coverage/.test(pub)) gaps.push("publish.yml does not run the coverage gate");
  if (!/conformance\/run\.ts/.test(pub)) gaps.push("publish.yml does not run the conformance suite");
  if (!/--tag\s+\S+/.test(pub)) gaps.push("publish.yml publishes without --tag (npm will set 'latest' on prereleases)");
  if (/prerelease|beta|alpha|rc/.test(versions.cli) === false && /--tag beta/.test(pub)) gaps.push("stable version but --tag beta is set");
  record("Release workflow enforces the same gates as CI, and sets a dist-tag", gaps.length ? "FAIL" : "PASS", gaps.length ? gaps.join("\n") : "ok");

  const lock = run("pnpm audit --prod --audit-level high");
  record("Dependency vulnerability audit (production deps, high+)", lock.code === 0 ? "PASS" : "FAIL", lock.code === 0 ? "ok" : lock.out.trim().split("\n").slice(-10).join("\n"), lock.secs);

  // Things no script on one machine can honestly verify
  const manual = [
    ["Other operating systems (Windows, macOS)", "Run this script on each OS, or add a CI matrix. This machine is " + process.platform + "."],
    ["Sandbox isolation on a machine with bwrap / sandbox-exec", "Check the test output for the line '[sandbox] no bwrap ... running tests unisolated'. If present, isolation was not verified."],
    ["Real LLM provider run (stage 1)", "Needs a real API key and a scratch repo. Run purix modify / ingest by hand once."],
    ["Real coding agent over MCP (stage 2)", "Attach purix mcp-serve to OpenCode / Claude Code and call the tools once."],
    ["Publish under the beta tag and install from the real registry (stage 4)", "Needs a real publish. Never automated by this script."],
    ["Rollback rehearsal (dist-tag move + deprecate) on a throwaway registry", "Do once against a local registry with the tarballs in .release-check/tarballs."],
    ["SBOM generated and attached to the release", "Not produced by this script."],
    ["Provenance shown on npm package pages after publish", "Check each package page after publishing."],
    ["Stale documents updated (TESTING report, SETUP.md, BETA_SCOPE.md)", "Manual review."],
  ];
  for (const [n, d] of manual) record(n, "NOT CHECKED", d);
}

// ---------- Report ----------
const fails = results.filter((r) => r.status === "FAIL");
const notChecked = results.filter((r) => r.status === "NOT CHECKED");
const passes = results.filter((r) => r.status === "PASS");
let verdict;
if (fails.length) verdict = `NOT READY. ${fails.length} check(s) failed.`;
else if (mode === "fast") verdict = "FAST CHECK PASSED. The build is not obviously broken. This does NOT mean the release is finalized; run: node scripts/release-check.mjs full";
else if (notChecked.length) verdict = `AUTOMATED CHECKS PASSED, NOT FINALIZED. ${notChecked.length} item(s) still need a human or another machine.`;
else verdict = "FINALIZED.";

const lines = [
  `# Purix release check report`, ``,
  `Mode: ${mode}  |  Date: ${new Date().toISOString()}  |  Machine: ${process.platform}, Node ${process.version}`,
  `Package versions: ${JSON.stringify(versions)}`, ``,
  `## Verdict`, ``, verdict, ``,
  `Passed: ${passes.length}  |  Failed: ${fails.length}  |  Not checked: ${notChecked.length}`, ``,
  `## Results`, ``,
  ...results.map((r) => `- **${r.status}** — ${r.name}${r.secs ? ` (${r.secs}s)` : ""}${r.status !== "PASS" ? `\n  - ${r.detail.replace(/\n/g, "\n    ")}` : ""}`),
  ``,
];
writeFileSync(join(outDir, "report.md"), lines.join("\n"));
writeFileSync(join(outDir, "report.json"), JSON.stringify({ mode, verdict, versions, results }, null, 2));

console.log(`\n==== VERDICT ====\n${verdict}\n`);
if (fails.length) { console.log("What failed:"); fails.forEach((f) => console.log(` - ${f.name}`)); }
console.log(`\nFull report: ${join(outDir, "report.md")}`);
process.exit(fails.length ? 1 : 0);
