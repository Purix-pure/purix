#!/usr/bin/env node
// Purix release check — runs the release tests automatically and writes a plain-language report.
//
//   node scripts/release-check.mjs fast     ~3 min   "is the build broken?"
//   node scripts/release-check.mjs full     ~6 min   "is it ready to finalize?"  (fast + extra gates)
//   node scripts/release-check.mjs full --tag v0.4.0-beta.0   also checks the tag matches the package versions
//   node scripts/release-check.mjs package   only the release-only checks (used by purix-04-run-all.mjs, which already ran the rest)
//
// Every step ends as PASS, FAIL, or NOT CHECKED. A step that could not run is never a PASS.
// The script never publishes, never tags, never touches the registry with write access.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { platform, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "full" ? "full" : process.argv[2] === "package" ? "package" : "fast";
// "package" runs ONLY the checks no other script does (pack, clean install, versions, tarball contents, workflow parity, audit).
// scripts/purix-04-run-all.mjs runs everything else exactly once, then calls this with "package".
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
  const r = spawnSync(cmd, { cwd: opts.cwd ?? root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: opts.timeoutMs ?? 15 * 60_000, ...(opts.env ? { env: opts.env } : {}) });
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  return { code: r.status ?? 1, out, secs: Math.round((Date.now() - t) / 1000) };
}
function record(name, status, detail, secs = 0, why = "") {
  results.push({ name, status, detail, secs, why });
  const icon = status === "PASS" ? "PASS       " : status === "FAIL" ? "FAIL       " : "NOT CHECKED";
  console.log(`[${icon}] ${name}${secs ? ` (${secs}s)` : ""}`);
  if (status !== "PASS") for (const l of detail.split("\n").slice(0, 25)) console.log(`             ${l}`);
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

const shared = mode !== "package";
const sstep = (...a) => (shared ? step(...a) : undefined);
if (!shared && !existsSync(join(root, "packages", "cli", "dist", "cli.js"))) { record("Packages are built before packing", "FAIL", "packages/cli/dist/cli.js is missing. Run: pnpm run build"); }

console.log(`\nPurix release check — mode: ${mode}\nRepo: ${root}\nNode ${process.version}\n`);

// ---------- Part 1: fast path ----------
sstep("Install with the locked dependency list", "pnpm install --frozen-lockfile", "Proves anyone can rebuild the exact same dependencies.");
sstep("Core stays independent of cli/api (boundary check)", "pnpm run boundary-check", "Architecture rule: core must not import cli.");
sstep("One place per job, counts only fall (single-point check)", "pnpm run single-point-check", "ADR-061: no new console/fetch/env/.purix scatter in core.");
sstep("No circular imports (import-cycle check)", "pnpm run cycle-check", "A circular import between source files is a latent start-up failure.");
sstep("Core exports only what other packages import (public surface check)", "pnpm run exports-check", "H4: an unlisted internal module must not become importable by strangers once published.");
sstep("No build junk committed (artifact check)", "pnpm run artifact-check", "Keeps toolchain leftovers out of the repo.");
sstep("Type check, all packages", "pnpm exec turbo run typecheck --force", "Catches type errors before users do.");
sstep("Build, all packages", "pnpm exec turbo run build --force", "Produces the files that get published.");

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
  // What a stranger does: install the published files into a folder, then use the CLI on a project. Both folders have spaces and
  // non-ASCII characters in their names, because that is where launchers and path handling break first (testing plan 5.1).
  console.log("... Install tarballs into an empty folder (spaces and non-ASCII in the path) and use the CLI on a project");
  const t = Date.now();
  const clean = mkdtempSync(join(tmpdir(), "purix clean ünï 测试-"));
  const proj = join(clean, "my project ü");
  const home = join(clean, "home dir");
  mkdirSync(join(proj, "src"), { recursive: true }); mkdirSync(home, { recursive: true });
  writeFileSync(join(clean, "package.json"), JSON.stringify({ name: "clean-room", version: "1.0.0", private: true }));
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "stranger-project", version: "1.0.0", type: "module" }));
  writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");
  const env = { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1", CLAUDE_PROJECT_DIR: "", GEMINI_PROJECT_DIR: "" };
  const git = run("git init -q", { cwd: proj, env });
  if (git.code !== 0) mkdirSync(join(proj, ".git"), { recursive: true });
  const inst = run(`npm install ${tarballs.map((f) => `"${join(tarDir, f)}"`).join(" ")} --no-audit --no-fund`, { cwd: clean, env });
  let detail = "ok", ok = inst.code === 0;
  if (ok) {
    const cliJs = join(clean, "node_modules", "@purix", "cli", "dist", "cli.js");
    const cli = (args, cwd = clean) => run(`node "${cliJs}" ${args}`, { cwd, env });
    const ver = cli("--version");
    if (ver.code !== 0 || ver.out.trim() !== versions.cli) { ok = false; detail = `--version printed "${ver.out.trim()}", expected "${versions.cli}"`; }
    else {
      const help = cli("--help");
      if (help.code !== 0) { ok = false; detail = "--help failed:\n" + help.out.slice(-400); }
    }
    // The first-run path: index, adopt, lock. With the project store present, `check --strict` exits 1 on a file nothing has tested yet
    // ("skipped items count as failures"), so the lock is judged from --json, as scripts/ci-lock-flow.mjs does. Then the CI case: a fresh
    // checkout (files and lock, no store) must pass strict, and after a direct edit it must FAIL and name the file.
    for (const args of ok ? ["index", "adopt src/a.ts", "lock"] : []) {
      const r = cli(args, proj);
      if (r.code !== 0) { ok = false; detail = `purix ${args} exited ${r.code} in a folder with spaces and non-ASCII characters:\n${r.out.slice(-500)}`; break; }
    }
    if (ok) {
      const j = cli("check --json", proj);
      let lockOutcome = "unreadable";
      try { lockOutcome = JSON.parse(j.out).sections.find((x) => x.id === "lock")?.outcome ?? "missing"; } catch { /* reported below */ }
      if (lockOutcome !== "pass") { ok = false; detail = `the lock section of purix check was "${lockOutcome}", expected "pass":\n${j.out.slice(-400)}`; }
    }
    if (ok) {
      rmSync(join(proj, ".purix"), { recursive: true, force: true });
      rmSync(join(proj, ".git"), { recursive: true, force: true });
      const fresh = cli("check --strict", proj);
      if (fresh.code !== 0) { ok = false; detail = `check --strict failed on a fresh checkout of an untouched project (exit ${fresh.code}):\n${fresh.out.slice(-500)}`; }
    }
    if (ok) {
      writeFileSync(join(proj, "src", "a.ts"), "export const a = 2;\n");
      const after = cli("check --strict", proj);
      if (after.code !== 1 || !/a\.ts/.test(after.out)) { ok = false; detail = `check --strict must exit 1 and name src/a.ts after the file was edited, but exited ${after.code}:\n${after.out.slice(-300)}`; }
    }
  } else detail = inst.out.trim().split("\n").slice(-8).join("\n");
  rmSync(clean, { recursive: true, force: true });
  record("Clean install of the packed files works (version, help, index, adopt, lock, strict check on a fresh checkout, a caught edit)", ok ? "PASS" : "FAIL", detail, Math.round((Date.now() - t) / 1000));
}

if (shared) {
  const r = step("MCP server handshake + tool calls (smoke test)", "node scripts/smoke-test.mjs", "Proves a coding agent can connect and call tools.");
  rmSync(join(root, "purix-mcp-report.md"), { force: true });
  const m = r.out.match(/Tool discovery \(found (\d+)\)/);
  if (m) console.log(`             tools discovered: ${m[1]}`);
}
sstep("Full test suite", "pnpm exec turbo run test --force --concurrency=1", "All unit and integration tests, every package.", {
  timeoutMs: 25 * 60_000,
  // Show the failing tests themselves, not the last build line turbo printed.
  extract: (out) => {
    const lines = out.split("\n").map((l) => l.replace(/\r$/, ""));
    // node:test prints a "failing tests:" section at the end; show it from the start.
    const i = lines.findIndex((l) => /failing tests:/i.test(l));
    if (i >= 0) return lines.slice(i, i + 25).join("\n");
    const hits = lines.filter((l) => /not ok|✖|ELIFECYCLE|Failed:|ERR_ASSERTION|AssertionError|failureType|expected:|actual:/.test(l)).slice(0, 25);
    return hits.length ? hits.join("\n") : lines.filter((l) => l.trim()).slice(-25).join("\n");
  },
});

// ---------- Part 2: finalization gates that a script CAN check ----------
if (mode !== "fast") {
if (mode === "full") {
  step("Coverage gate (90% lines, branches, functions on security code)", "pnpm run coverage", "Confirms the verification and sandbox code is actually tested.", {
    extract: (o) => { const m = o.match(/all files\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)/); return m ? `Lines ${m[1]}%, branches ${m[2]}%, functions ${m[3]}% — each must be 90 or more.` : o.trim().split("\n").slice(-6).join("\n"); },
  });
  step("Language conformance suite (TypeScript + Python)", "pnpm exec tsx packages/core/src/language/conformance/run.ts", "Confirms Purix's checks behave the same per language.", {
    timeoutMs: 10 * 60_000,
    extract: (o) => { const errs = [...o.matchAll(/"error":\s*"([^"\\]{0,60}(?:\\.[^"\\]{0,120})*)/g)].map((m) => m[1].replace(/\\"/g, '"').slice(0, 220)); return (/Certified: (true|false)/.exec(o)?.[0] ?? "no result") + (errs.length ? "\n" + errs.join("\n") : ""); },
  });

}

  // Versions consistent
  const uniq = new Set(Object.values(versions));
  let vDetail = `versions: ${JSON.stringify(versions)}`;
  let vOk = uniq.size === 1;
  if (vOk && tag) { vOk = tag.replace(/^v/, "") === [...uniq][0]; if (!vOk) vDetail = `tag ${tag} does not match package version ${[...uniq][0]}`; }
  record(tag ? `All three package versions match tag ${tag}` : "All three package versions match each other", vOk ? "PASS" : "FAIL", vOk ? "ok" : vDetail);

  // Placeholders that only the owner can fill. Each one is a public embarrassment or a dead control if it ships.
  {
    const problems = [];
    const text = (p) => (existsSync(join(root, p)) ? readFileSync(join(root, p), "utf8") : null);
    const notice = text("NOTICE");
    if (notice === null) problems.push("NOTICE is missing");
    else {
      if (/\[[^\]\n]*(name|entity|owner|holder)[^\]\n]*\]/i.test(notice)) problems.push("NOTICE still has a bracketed placeholder for the legal owner");
      if (/Purix \(formerly Purix\)/.test(notice)) problems.push('NOTICE still reads "Purix (formerly Purix)"');
    }
    const owners = text(".github/CODEOWNERS");
    if (owners === null) problems.push(".github/CODEOWNERS is missing");
    else if (!owners.split("\n").some((l) => l.trim() && !l.trim().startsWith("#"))) problems.push(".github/CODEOWNERS has no active rule (every line is a comment)");
    try {
      for (const r of readJson(join(root, "docs", "client-runs.json")).runs ?? []) {
        if (typeof r.version !== "string" || /^\s*$|^<.*>$/.test(r.version)) problems.push(`docs/client-runs.json: the ${r.client} run has no real version ("${r.version}")`);
      }
    } catch (e) { problems.push(`docs/client-runs.json cannot be read: ${e.message}`); }
    for (const p of pkgs) {
      const pn = text(`packages/${p}/NOTICE`);
      if (pn === null) problems.push(`packages/${p}/NOTICE is missing (Apache 2.0 section 4(d))`);
      else if (notice !== null && pn !== notice) problems.push(`packages/${p}/NOTICE differs from the root NOTICE`);
    }
    record("Owner placeholders are filled in (NOTICE, CODEOWNERS, client-runs version)", problems.length ? "FAIL" : "PASS", problems.length ? problems.join("\n") : "ok");
  }

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
      if (!has(/package\/NOTICE$/)) bad.push(`${f}: no NOTICE`);
      if (!has(/package\/dist\//)) bad.push(`${f}: no dist/ folder`);
      if (has(/package\/src\//)) bad.push(`${f}: contains src/ (should ship dist only)`);
      if (has(/package\/dist\/eval\//)) bad.push(`${f}: contains dist/eval/ (the L1 eval harness is developer tooling and must not ship)`);
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

  // An audit that could not reach the registry says nothing about vulnerabilities. It must not be reported as a failure of the
  // code (or as a pass): it is NOT CHECKED, and the network stage of the runner (`--network`) is where it is proven.
  const lock = run("pnpm audit --prod --audit-level high");
  const offline = lock.code !== 0 && /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|fetch failed|getaddrinfo|network|offline|proxy/i.test(lock.out) && !/vulnerabilit(y|ies) found|\b(high|critical)\b.*severity/i.test(lock.out);
  record("Dependency vulnerability audit (production deps, high+)", offline ? "NOT CHECKED" : lock.code === 0 ? "PASS" : "FAIL", offline ? "the registry could not be reached, so nothing was audited: " + lock.out.trim().split("\n").slice(-3).join(" | ") : lock.code === 0 ? "ok" : lock.out.trim().split("\n").slice(-10).join("\n"), lock.secs);

  // Testing plan 5.5: a software bill of materials per package, checked against the lockfile.
  const sbom = run(`node "${join(root, "scripts", "sbom-check.mjs")}" --out "${join(outDir, "sbom")}"`);
  record("SBOM (CycloneDX) generated for each package and matches the lockfile", sbom.code === 0 ? "PASS" : "FAIL", sbom.code === 0 ? "written to .release-check/sbom (attach it to the release)" : sbom.out.trim().split("\n").slice(-10).join("\n"), sbom.secs);

  // Things no script on one machine can honestly verify
  const manual = [
    ["Other operating systems (Windows, macOS)", "Run this script on each OS, or read the os-smoke jobs in ci.yml. This machine is " + platform() + "."],
    ["Sandbox isolation on a machine with bwrap / sandbox-exec", "Check the test output for the line '[sandbox] no bwrap ... running tests unisolated'. If present, isolation was not verified."],
    ["Real LLM provider run (testing plan step 7)", "Needs a real API key and a budget: pnpm eval:l1 --budget-usd <n>."],
    ["Real coding agent over MCP and hooks (testing plan step 6)", "scripts/real-agent-kit.mjs, one agent at a time. docs/client-runs.json must hold a passing row with a real version text."],
    ["Publish an rc and install it from the real registry on each OS (testing plan 5.3)", "Needs a real publish. Never automated by this script."],
    ["Rollback rehearsal: deprecate a bad rc and move the dist-tag back (testing plan 5.6)", "Do once with a deliberately bad rc; check a fresh install gets the good one."],
    ["The SBOM is attached to the GitHub release", "sbom-check wrote the files; attaching them is a manual step in the release."],
    ["Provenance shown on npm package pages after publish", "Check each package page after publishing."],
    ["Stale documents updated (docs/TESTING_ARCHITECTURE_REPORT_2026-09-07.md, SETUP.md, BETA_SCOPE.md, docs/CLIENT_SUPPORT.md header)", "Manual review."],
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
