#!/usr/bin/env node
// scripts/sync-versions.mjs: the one place that knows where a Purix version lives, and what must agree with what.
//
//   node scripts/sync-versions.mjs --check           fail (exit 1) if anything disagrees. Changes nothing.
//   node scripts/sync-versions.mjs 0.4.0-beta.2      set the release version everywhere it is written, then re-check
//
// RELEASE VERSION. The root package.json "version" is the source of truth. The three packages move in lockstep with it.
// Written in: the four package.json files, the workspace ranges between the packages, server.json, docker-compose.yml,
// the workspace specifiers in pnpm-lock.yaml, the beta banner in each package README, the release sentence in README.md.
// A stale value anywhere fails the check, not just a missing one.
//
// TOOL PINS. Where a tool version is written more than once, every copy must agree:
//   pnpm      root packageManager == every pnpm/setup "version:" in .github/workflows == the README sentence
//   node      the four "engines.node" ranges are identical; the CI matrix floor == the engines floor; Dockerfile NODE_VERSION >= floor major
//   repo URL  repository.url is identical in the three packages and names the same repository as server.json and the brand default
//             (compared without regard to letter case; a case difference is reported as a note, see below)
//
// NOT CHECKED: what the installed tools on a person's machine are (that is `node -v`, `pnpm -v`); the CHANGELOG text (a person
// writes it; the script reminds you); docs that record history ("tested on pnpm 12.4.1") on purpose.
//
// CASE NOTE. npm provenance compares package.json "repository.url" with the repository name GitHub signs, letter for letter.
// If the URLs differ only in case the script prints a note instead of failing, because only GitHub knows the canonical spelling.
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VER = "(\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.]+)?)";
const SEMVER = new RegExp(`^${VER}$`);

const read = (rel) => readFileSync(join(root, rel), "utf8");
const has = (rel) => existsSync(join(root, rel));
const json = (rel) => JSON.parse(read(rel));

const PACKAGES = ["core", "mcp-server", "cli"];
const rootVersion = () => json("package.json").version;

// Every place the release version is written. `re` has exactly one capture group: the version text. `min` is how many
// matches must exist. Every match must equal the release version.
function versionSites() {
  const sites = [
    { file: "package.json", what: "root version", re: new RegExp(`^\\s*"version":\\s*"${VER}"`, "gm"), min: 1 },
    { file: "README.md", what: "release sentence", re: new RegExp(`version in this repository is \\*\\*${VER}\\*\\*`, "g"), min: 1 },
  ];
  for (const p of PACKAGES) {
    const f = `packages/${p}/package.json`;
    sites.push({ file: f, what: "package version", re: new RegExp(`^\\s*"version":\\s*"${VER}"`, "gm"), min: 1 });
    sites.push({ file: f, what: "workspace ranges", re: new RegExp(`"@purix/[a-z-]+":\\s*"workspace:\\^${VER}"`, "g"), min: 0 });
    sites.push({ file: `packages/${p}/README.md`, what: "README beta banner", re: new RegExp(`[Bb]eta \\(\`${VER}\`\\)`, "g"), min: 1 });
  }
  for (const f of ["server.json", "packages/mcp-server/server.json"]) {
    if (has(f)) sites.push({ file: f, what: "MCP registry version", re: new RegExp(`"version":\\s*"${VER}"`, "g"), min: 1 });
  }
  if (has("docker-compose.yml")) sites.push({ file: "docker-compose.yml", what: "image tags", re: new RegExp(`image:\\s*purix:${VER}`, "g"), min: 1 });
  if (has("pnpm-lock.yaml")) sites.push({ file: "pnpm-lock.yaml", what: "workspace specifiers", re: new RegExp(`specifier:\\s*workspace:\\^${VER}`, "g"), min: 1 });
  return sites.filter((s) => has(s.file));
}

const results = [];
const note = (msg) => console.log(`  note: ${msg}`);
function record(ok, label, detail = "") {
  results.push({ ok, label, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? `\n      ${detail.replace(/\n/g, "\n      ")}` : ""}`);
}

function checkReleaseVersion(expected) {
  for (const s of versionSites()) {
    const text = read(s.file);
    const found = [...text.matchAll(s.re)].map((m) => m[1]);
    const stale = [...new Set(found.filter((v) => v !== expected))];
    const label = `${s.file}: ${s.what} = ${expected}`;
    if (found.length < s.min) record(false, label, `expected at least ${s.min} place(s), found ${found.length}`);
    else if (stale.length) record(false, label, `found ${stale.join(", ")}`);
    else record(true, label);
  }
}

function pnpmPins() {
  const pm = /^pnpm@(\d+\.\d+\.\d+)$/.exec(json("package.json").packageManager ?? "")?.[1];
  const label = "pnpm: packageManager, workflows and README agree";
  if (!pm) return record(false, label, 'root package.json has no "packageManager": "pnpm@x.y.z"');
  const problems = [];
  const wfDir = join(root, ".github/workflows");
  if (existsSync(wfDir)) {
    for (const f of readdirSync(wfDir).filter((n) => /\.ya?ml$/.test(n))) {
      const lines = readFileSync(join(wfDir, f), "utf8").split("\n");
      lines.forEach((line, i) => {
        if (!/uses:\s*pnpm\/setup@/.test(line)) return;
        const v = lines.slice(i + 1, i + 8).map((l) => /^\s*version:\s*([0-9][^\s#]*)/.exec(l)?.[1]).find(Boolean);
        if (v !== pm) problems.push(`.github/workflows/${f}:${i + 1}: pnpm/setup version is ${v ?? "missing"}, packageManager says ${pm}`);
      });
    }
  }
  const readme = /pins pnpm (\d+\.\d+\.\d+)/.exec(read("README.md"))?.[1];
  if (readme !== undefined && readme !== pm) problems.push(`README.md says it pins pnpm ${readme}, packageManager says ${pm}`);
  record(problems.length === 0, label, problems.join("\n"));
}

function nodePins() {
  const ranges = ["package.json", ...PACKAGES.map((p) => `packages/${p}/package.json`)].map((f) => [f, json(f).engines?.node]);
  const uniq = new Set(ranges.map(([, r]) => r));
  record(uniq.size === 1 && !uniq.has(undefined), "node: engines.node is the same in all four package.json files", ranges.map(([f, r]) => `${f}: ${r}`).join("\n"));
  const floor = /\^(\d+\.\d+\.\d+)/.exec(ranges[0][1] ?? "")?.[1];
  if (!floor) return;
  const problems = [];
  if (has(".github/workflows/ci.yml")) {
    const m = /matrix:\s*\n\s*node:\s*\[([^\]]*)\]/.exec(read(".github/workflows/ci.yml"));
    const first = m?.[1].split(",")[0]?.replace(/['"\s]/g, "");
    if (first !== floor) problems.push(`ci.yml matrix starts at ${first ?? "(not found)"}, engines floor is ${floor}`);
  }
  if (has("Dockerfile")) {
    const d = /ARG NODE_VERSION=(\d+)/.exec(read("Dockerfile"))?.[1];
    if (d !== undefined && Number(d) < Number(floor.split(".")[0])) problems.push(`Dockerfile NODE_VERSION=${d} is below the engines floor ${floor}`);
  }
  record(problems.length === 0, "node: CI matrix floor and Dockerfile fit the engines range", problems.join("\n"));
}

function repoUrls() {
  const norm = (u) => u.replace(/^git\+/, "").replace(/\.git$/, "").replace(/^https?:\/\/github\.com\//, "");
  const urls = PACKAGES.map((p) => [`packages/${p}/package.json`, json(`packages/${p}/package.json`).repository?.url ?? ""]);
  const exact = new Set(urls.map(([, u]) => u));
  record(exact.size === 1 && !exact.has(""), "repo: repository.url is identical in the three packages", urls.map(([f, u]) => `${f}: ${u || "(missing)"}`).join("\n"));
  const mine = norm(urls[0][1]);
  const others = [];
  if (has("server.json")) others.push(["server.json", norm(json("server.json").repository?.url ?? "")]);
  const brand = has("packages/core/src/config/brand.ts") ? /githubRepo:\s*"([^"]+)"/.exec(read("packages/core/src/config/brand.ts"))?.[1] : undefined;
  if (brand) others.push(["brand.ts githubRepo", brand]);
  const wrong = others.filter(([, v]) => v.toLowerCase() !== mine.toLowerCase());
  record(wrong.length === 0, "repo: server.json and the brand default name the same repository", wrong.map(([f, v]) => `${f}: ${v}, packages say ${mine}`).join("\n"));
  for (const [f, v] of others) if (v !== mine && v.toLowerCase() === mine.toLowerCase()) note(`${f} spells the repository "${v}", the packages say "${mine}" (letter case only; npm provenance needs the packages to match GitHub's own spelling)`);
}

function checkAll() {
  const v = rootVersion();
  if (!SEMVER.test(v)) { record(false, "root package.json version is a semantic version", `got "${v}"`); return; }
  console.log(`Release version: ${v}\n`);
  checkReleaseVersion(v);
  pnpmPins();
  nodePins();
  repoUrls();
}

function applyVersion(next) {
  const current = rootVersion();
  for (const s of versionSites()) {
    const text = read(s.file);
    const out = text.replace(s.re, (whole, ver) => whole.replace(ver, next));
    if (out !== text) writeFileSync(join(root, s.file), out);
  }
  console.log(`Set ${current} -> ${next}\n`);
}

const arg = process.argv[2];
if (arg === undefined || arg === "--help" || arg === "-h") {
  console.log("usage: node scripts/sync-versions.mjs --check | <new version, e.g. 0.4.0-beta.2>");
  process.exit(arg === undefined ? 2 : 0);
}
if (arg === "--check") {
  checkAll();
} else {
  if (!SEMVER.test(arg)) { console.error(`"${arg}" is not a semantic version (x.y.z or x.y.z-beta.n)`); process.exit(2); }
  // Refuse to bump from a state that already disagrees: the person should see what is wrong first, not have it papered over.
  const before = [];
  const cur = rootVersion();
  const origLog = console.log;
  console.log = () => {};
  checkReleaseVersion(cur);
  console.log = origLog;
  for (const r of results.splice(0)) if (!r.ok) before.push(`${r.label}\n    ${r.detail}`);
  if (before.length) {
    console.error(`Not changing anything: the repository already disagrees about ${cur}:\n\n${before.join("\n")}\n\nFix these by hand, then run again.`);
    process.exit(1);
  }
  applyVersion(arg);
  checkAll();
  if (results.every((r) => r.ok)) console.log(`\nDone. Still yours to do: add a section for ${arg} to docs/compliance/CHANGELOG.md, review \`git diff\`, commit.`);
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} problem(s).`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks pass.`);
