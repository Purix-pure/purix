#!/usr/bin/env node
// scripts/sync-versions.mjs: the one place that knows where a Purix version lives, and what must agree with what.
//
//   node scripts/sync-versions.mjs --check              fail (exit 1) if anything disagrees. Changes nothing.
//   node scripts/sync-versions.mjs 0.4.0-beta.3         set the release version everywhere it is written, then re-check
//   node scripts/sync-versions.mjs 0.4.0-beta.3 --dry-run   show every line it would change; write nothing
//   node scripts/sync-versions.mjs --stale 0.4.0-beta.2     list files that still mention an old version (review list)
//
// One command does a release bump: `pnpm run version-set <x.y.z>`. It also rolls the changelog (the [Unreleased] notes become the
// [x.y.z] section and a new empty [Unreleased] is left above), refuses a version lower than the current one (--allow-downgrade
// overrides), and ends with the list of places that still mention the old version, so nobody has to search by hand.
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
//             (compared EXACTLY, letter case included: npm provenance and the MCP registry both compare case-sensitively)
//   mcpName   mcpName in the cli and mcp-server packages == server.json "name" == io.github.<owner>/<repo> of repository.url
//
// NOT CHECKED: what the installed tools on a person's machine are (that is `node -v`, `pnpm -v`); the CHANGELOG text (a person
// writes it; the script reminds you); docs that record history ("tested on pnpm 12.4.1") on purpose.
//
// CASE NOTE. npm provenance compares package.json "repository.url" with the repository name GitHub signs, letter for letter.
// So every spelling is compared exactly and a case difference FAILS. The right spelling is GitHub's own: the owner and repo as
// shown at the top of the repository page (checked 2026-11-17: "Purix-pure/purix"). The MCP registry also compares io.github.<owner>/
// case-sensitively against that owner, so mcpName and server.json "name" must carry it too.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
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
  // Sentences that say what the current version is. Not history: the changelog section headings are handled separately (rollChangelog).
  const BT = "`";
  sites.push({ file: "CHANGELOG.md", what: "current-version sentence", re: new RegExp("current package version is " + BT + VER + BT, "g"), min: 1 });
  sites.push({ file: "CHANGELOG.md", what: "current-version section name", re: new RegExp("its notes are the " + BT + "\\[" + VER + "\\]" + BT + " section", "g"), min: 1 });
  sites.push({ file: ".github/workflows/publish.yml", what: "workflow input example", re: new RegExp("\\(e\\.g\\. " + VER + "\\)", "g"), min: 1 });
  if (has("pnpm-lock.yaml")) sites.push({ file: "pnpm-lock.yaml", what: "workspace specifiers", re: new RegExp(`specifier:\\s*workspace:\\^${VER}`, "g"), min: 1 });
  return sites.filter((s) => has(s.file));
}

const results = [];
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
  const wrong = others.filter(([, v]) => v !== mine);
  record(wrong.length === 0, "repo: server.json and the brand default spell the repository exactly like the packages (letter case included)", wrong.map(([f, v]) => `${f}: ${v}, packages say ${mine}`).join("\n"));
  const [owner, name] = mine.split("/");
  const want = `io.github.${owner}/${name}`;
  const names = [...["cli", "mcp-server"].map((p) => [`packages/${p}/package.json mcpName`, json(`packages/${p}/package.json`).mcpName ?? ""])];
  if (has("server.json")) names.push(["server.json name", json("server.json").name ?? ""]);
  const badNames = names.filter(([, v]) => v !== want);
  record(badNames.length === 0, `mcp: mcpName and the server.json name are exactly ${want}`, badNames.map(([f, v]) => `${f}: ${v || "(missing)"}`).join("\n"));
}

function checkAll() {
  const v = rootVersion();
  if (!SEMVER.test(v)) { record(false, "root package.json version is a semantic version", `got "${v}"`); return; }
  console.log(`Release version: ${v}\n`);
  checkReleaseVersion(v);
  checkChangelog(v);
  pnpmPins();
  nodePins();
  repoUrls();
}

const CHANGELOG = "docs/compliance/CHANGELOG.md";
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const hasSection = (text, v) => new RegExp(`^## \\[${esc(v)}\\]`, "m").test(text);

// Semantic-version precedence (semver.org rule 11): returns -1, 0 or 1.
function compareVersions(a, b) {
  const parse = (v) => { const [core, pre] = v.split(/-(.+)/); return { n: core.split(".").map(Number), pre: pre ? pre.split(".") : [] }; };
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x.n[i] !== y.n[i]) return x.n[i] < y.n[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) { if (Number(p) !== Number(q)) return Number(p) < Number(q) ? -1 : 1; }
    else if (pn !== qn) return pn ? -1 : 1;
    else if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

function checkChangelog(v) {
  if (!has(CHANGELOG)) return;
  record(hasSection(read(CHANGELOG), v), `${CHANGELOG}: has a [${v}] section`, `add "## [${v}]" with this release's notes (the version command does it from [Unreleased])`);
}

// The [Unreleased] notes become the notes of the new version; a fresh empty [Unreleased] stays above.
function rolledChangelog(next) {
  const text = read(CHANGELOG);
  if (hasSection(text, next)) return { text, note: `${CHANGELOG} already has a [${next}] section; left as it is` };
  const m = /^## \[Unreleased\][^\n]*\n/m.exec(text);
  if (!m) return { text, note: `${CHANGELOG} has no [Unreleased] heading: add the [${next}] section by hand` };
  const rest = text.slice(m.index + m[0].length);
  const stop = rest.search(/^## /m);
  const body = (stop === -1 ? rest : rest.slice(0, stop)).trim();
  return {
    text: `${text.slice(0, m.index)}## [Unreleased]\n\n## [${next}]\n${rest.length ? "" : "\n"}${rest}`,
    note: body ? `moved the [Unreleased] notes under [${next}] in ${CHANGELOG}` : `[Unreleased] was empty, so [${next}] has no notes: write them before you release`,
  };
}

// Work out every file change in memory first, so --dry-run and the real run agree exactly.
function planVersion(next) {
  const changes = new Map(); // file -> { before, after }
  const notes = [];
  const latest = (f) => changes.get(f)?.after ?? read(f);
  const put = (f, after) => { if (after !== latest(f)) changes.set(f, { before: changes.get(f)?.before ?? read(f), after }); };
  for (const s of versionSites()) put(s.file, latest(s.file).replace(s.re, (whole, ver) => whole.replace(ver, next)));
  if (has(CHANGELOG)) { const r = rolledChangelog(next); put(CHANGELOG, r.text); notes.push(r.note); }
  return { changes, notes };
}

function showPlan({ changes, notes }, next) {
  const cut = (s) => (s.length > 150 ? `${s.slice(0, 147)}...` : s);
  for (const [file, { before, after }] of changes) {
    const a = before.split("\n"), b = after.split("\n");
    console.log(`  ${file}`);
    if (a.length !== b.length) { console.log(`      ${b.length - a.length > 0 ? "+" : ""}${b.length - a.length} line(s): see notes below`); continue; }
    const diff = a.map((l, i) => [l, b[i]]).filter(([x, y]) => x !== y);
    for (const [x, y] of diff.slice(0, 4)) console.log(`      - ${cut(x.trim())}\n      + ${cut(y.trim())}`);
    if (diff.length > 4) console.log(`      ... and ${diff.length - 4} more changed line(s)`);
  }
  for (const n of notes) console.log(`  note: ${n}`);
  console.log(`\n${changes.size} file(s) would change to ${next}.`);
}

// Files that are history or tooling examples on purpose: a mention of an old version there is not stale.
const HISTORY = [/^docs\/compliance\/CHANGELOG\.md$/, /^scripts\//, /^pnpm-lock\.yaml$/, /catalog_data\.ts$/, /^docs\/(RELEASE_NOTES|HANDOFF|DECISIONS|PLAN|client-runs|CLIENT_SUPPORT|WHAT_PURIX)/];
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", ".turbo", ".purix", "coverage", ".release-check", ".test-logs"]);

function repoFiles() {
  try { return execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8", maxBuffer: 64e6, stdio: ["ignore", "pipe", "ignore"] }).split("\n").filter(Boolean); }
  catch { /* not a git checkout (a zip, say): walk the folder */ }
  const out = [];
  const walk = (rel) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(rel ? `${rel}/${e.name}` : e.name); }
      else out.push(rel ? `${rel}/${e.name}` : e.name);
    }
  };
  walk("");
  return out;
}

function staleMentions(old) {
  const re = new RegExp(`(?<![0-9A-Za-z.\\-])${esc(old)}(?![0-9A-Za-z])(?!\\.[0-9])(?!-[0-9A-Za-z])`);
  const hits = [];
  for (const f of repoFiles()) {
    if (HISTORY.some((h) => h.test(f))) continue;
    let text;
    try { if (statSync(join(root, f)).size > 2_000_000) continue; text = readFileSync(join(root, f), "utf8"); } catch { continue; }
    if (text.includes("\0")) continue;
    text.split("\n").forEach((line, i) => { if (re.test(line)) hits.push(`${f}:${i + 1}: ${line.trim().slice(0, 130)}`); });
  }
  return hits;
}

function reportStale(old) {
  const hits = staleMentions(old);
  if (!hits.length) { console.log(`\nNo file still mentions ${old} (history and tooling examples are skipped).`); return; }
  console.log(`\nReview: ${hits.length} place(s) still mention ${old}. The script left these alone because it cannot tell a stale claim from a fact about that version:`);
  for (const h of hits) console.log(`  ${h}`);
}

const args = process.argv.slice(2);
const flag = (n) => args.includes(n);
const positional = args.filter((a) => !a.startsWith("--") && a !== "-h");
const arg = flag("--check") ? "--check" : flag("--stale") ? "--stale" : positional[0];

if (arg === undefined || flag("--help") || args.includes("-h")) {
  console.log("usage: node scripts/sync-versions.mjs --check\n       node scripts/sync-versions.mjs <new version, e.g. 0.4.0-beta.3> [--dry-run] [--allow-downgrade]\n       node scripts/sync-versions.mjs --stale <old version>");
  process.exit(arg === undefined && !flag("--help") && !args.includes("-h") ? 2 : 0);
}
if (arg === "--check") {
  checkAll();
} else if (arg === "--stale") {
  const old = positional[0];
  if (!old || !SEMVER.test(old)) { console.error("usage: node scripts/sync-versions.mjs --stale <old version, e.g. 0.4.0-beta.2>"); process.exit(2); }
  reportStale(old);
  process.exit(0);
} else {
  const next = arg;
  if (!SEMVER.test(next)) { console.error(`"${next}" is not a semantic version (x.y.z or x.y.z-beta.n)`); process.exit(2); }
  const cur = rootVersion();
  const order = compareVersions(next, cur);
  if (order === 0) { console.log(`Already at ${cur}. Nothing to change.`); checkAll(); }
  else if (order < 0 && !flag("--allow-downgrade")) {
    console.error(`${next} is lower than the current version ${cur}. npm never allows a version to be reused or lowered, so this is almost always a typo. Use --allow-downgrade if you really mean it.`);
    process.exit(2);
  } else {
    // Refuse to bump from a state that already disagrees: the person should see what is wrong first, not have it papered over.
    const before = [];
    const origLog = console.log;
    console.log = () => {};
    checkReleaseVersion(cur);
    console.log = origLog;
    for (const r of results.splice(0)) if (!r.ok) before.push(`${r.label}\n    ${r.detail}`);
    if (before.length) {
      console.error(`Not changing anything: the repository already disagrees about ${cur}:\n\n${before.join("\n")}\n\nFix these by hand, then run again.`);
      process.exit(1);
    }
    const plan = planVersion(next);
    if (flag("--dry-run")) {
      console.log(`Dry run: ${cur} -> ${next}. Nothing is written.\n`);
      showPlan(plan, next);
      process.exit(0);
    }
    for (const [file, { after }] of plan.changes) writeFileSync(join(root, file), after);
    console.log(`Set ${cur} -> ${next}  (${plan.changes.size} file(s))\n`);
    for (const n of plan.notes) console.log(`  note: ${n}`);
    console.log("");
    checkAll();
    if (results.every((r) => r.ok)) {
      reportStale(cur);
      console.log(`\nDone. Still yours to do: read the [${next}] notes in ${CHANGELOG}, review \`git diff\`, commit.`);
    }
  }
}
const failed = results.filter((r) => !r.ok);
if (failed.length) {
  console.log(`\n${failed.length} problem(s).`);
  process.exit(1);
}
console.log(`\nAll ${results.length} checks pass.`);
