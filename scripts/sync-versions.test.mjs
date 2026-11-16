// Tests for scripts/sync-versions.mjs. Each test works on its own temporary copy of the files the script reads, so the real
// repository is never touched. Versions used for bumps are made up (9.9.9-test.n) so the tests stay valid after any real release bump.
//   node --test scripts/sync-versions.test.mjs
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const COPY = [
  "package.json", "README.md", "CHANGELOG.md", "server.json", "docker-compose.yml", "Dockerfile", "pnpm-lock.yaml",
  "docs/compliance/CHANGELOG.md", ".github/workflows/ci.yml", ".github/workflows/publish.yml", ".github/workflows/repeat-run.yml",
  "packages/core/package.json", "packages/core/README.md", "packages/mcp-server/package.json", "packages/mcp-server/README.md",
  "packages/cli/package.json", "packages/cli/README.md", "packages/core/src/config/brand.ts", "scripts/sync-versions.mjs",
];
const made = [];

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "purix-versions-"));
  made.push(dir);
  for (const f of COPY) {
    if (!existsSync(join(repo, f))) continue;
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    cpSync(join(repo, f), join(dir, f));
  }
  return dir;
}
const run = (dir, ...args) => {
  const r = spawnSync(process.execPath, [join(dir, "scripts/sync-versions.mjs"), ...args], { cwd: dir, encoding: "utf8" });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
};
function snapshot(dir) {
  const h = createHash("sha256");
  const walk = (rel) => {
    for (const e of readdirSync(join(dir, rel), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else h.update(p).update(readFileSync(join(dir, p)));
    }
  };
  walk("");
  return h.digest("hex");
}
const rootVersion = (dir) => JSON.parse(readFileSync(join(dir, "package.json"), "utf8")).version;

test.after(() => { for (const d of made) rmSync(d, { recursive: true, force: true }); });

test("a clean copy of the repository passes --check", () => {
  const d = fixture();
  const r = run(d, "--check");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /has a \[.+\] section/);
});

test("--dry-run lists the files and changes nothing", () => {
  const d = fixture();
  const before = snapshot(d);
  const r = run(d, "9.9.9-test.1", "--dry-run");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Dry run/);
  assert.match(r.out, /packages\/cli\/package\.json/);
  assert.match(r.out, /docs\/compliance\/CHANGELOG\.md/);
  assert.equal(snapshot(d), before);
});

test("a bump changes every site, rolls the changelog, and --check passes afterwards", () => {
  const d = fixture();
  const old = rootVersion(d);
  const r = run(d, "9.9.9-test.1");
  assert.equal(r.code, 0, r.out);
  assert.equal(rootVersion(d), "9.9.9-test.1");
  for (const p of ["core", "mcp-server", "cli"]) assert.equal(JSON.parse(readFileSync(join(d, `packages/${p}/package.json`), "utf8")).version, "9.9.9-test.1");
  assert.equal(JSON.parse(readFileSync(join(d, "server.json"), "utf8")).packages[0].version, "9.9.9-test.1");
  assert.match(readFileSync(join(d, "CHANGELOG.md"), "utf8"), /current package version is `9\.9\.9-test\.1`/);
  const log = readFileSync(join(d, "docs/compliance/CHANGELOG.md"), "utf8");
  assert.ok(log.indexOf("## [Unreleased]") < log.indexOf("## [9.9.9-test.1]"), "new section sits under [Unreleased]");
  assert.ok(log.indexOf("## [9.9.9-test.1]") < log.indexOf(`## [${old}]`), "new section sits above the previous release");
  assert.equal(run(d, "--check").code, 0);
  assert.doesNotMatch(readFileSync(join(d, "pnpm-lock.yaml"), "utf8"), new RegExp(`specifier: workspace:\\^${old.replace(/\./g, "\\.")}`));
});

test("a lower version is refused and nothing changes; --allow-downgrade overrides", () => {
  const d = fixture();
  assert.equal(run(d, "9.9.9-test.5").code, 0);
  const before = snapshot(d);
  const r = run(d, "9.9.9-test.4");
  assert.equal(r.code, 2, r.out);
  assert.match(r.out, /lower than the current version/);
  assert.equal(snapshot(d), before);
  assert.equal(run(d, "9.9.9-test.4", "--allow-downgrade").code, 0);
});

test("prerelease numbers compare as numbers: test.10 is above test.9", () => {
  const d = fixture();
  assert.equal(run(d, "9.9.9-test.9").code, 0);
  assert.equal(run(d, "9.9.9-test.10", "--dry-run").code, 0);
  assert.equal(run(d, "9.9.9", "--dry-run").code, 0, "a release is above its own prereleases");
  assert.equal(run(d, "9.9.9-test.2").code, 2, "test.2 is below test.9");
});

test("the same version again is a no-op", () => {
  const d = fixture();
  const before = snapshot(d);
  const r = run(d, rootVersion(d));
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Already at/);
  assert.equal(snapshot(d), before);
});

test("not a semantic version: refused", () => {
  const d = fixture();
  const before = snapshot(d);
  assert.equal(run(d, "v1.2.3").code, 2);
  assert.equal(run(d, "1.2").code, 2);
  assert.equal(snapshot(d), before);
});

test("refuses to bump when the repository already disagrees, and changes nothing", () => {
  const d = fixture();
  const f = join(d, "packages/cli/README.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(rootVersion(d), "0.0.1"));
  const before = snapshot(d);
  const r = run(d, "9.9.9-test.1");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /Not changing anything/);
  assert.equal(snapshot(d), before);
});

test("--check fails when the changelog has no section for the current version", () => {
  const d = fixture();
  const f = join(d, "docs/compliance/CHANGELOG.md");
  writeFileSync(f, readFileSync(f, "utf8").replace(`## [${rootVersion(d)}]`, "## [renamed]"));
  const r = run(d, "--check");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /has a \[.+\] section/);
});

test("an empty [Unreleased] is flagged, not hidden", () => {
  const d = fixture();
  const f = join(d, "docs/compliance/CHANGELOG.md");
  const text = readFileSync(f, "utf8");
  const start = text.indexOf("## [Unreleased]");
  const stop = text.indexOf("\n## [", start + 5);
  writeFileSync(f, `${text.slice(0, start)}## [Unreleased]\n${text.slice(stop)}`);
  const r = run(d, "9.9.9-test.1");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /\[Unreleased\] was empty/);
});

test("a leftover mention of the old version is listed for review (history and scripts are skipped)", () => {
  const d = fixture();
  const old = rootVersion(d);
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs/INSTALL.md"), `Install ${old} like this.\n`);
  const r = run(d, "9.9.9-test.1");
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /docs\/INSTALL\.md:1:/);
  assert.doesNotMatch(r.out, /docs\/compliance\/CHANGELOG\.md:\d+:/);
  assert.doesNotMatch(r.out, /scripts\/sync-versions\.mjs:\d+:/);
});

test("--stale does not match a longer version that starts the same way", () => {
  const d = fixture();
  mkdirSync(join(d, "docs"), { recursive: true });
  writeFileSync(join(d, "docs/A.md"), "see 1.2.30 and 1.2.3-beta.1 and 11.2.3\n");
  assert.match(run(d, "--stale", "1.2.3").out, /No file still mentions 1\.2\.3/);
  writeFileSync(join(d, "docs/A.md"), "see 1.2.3 here\n");
  assert.match(run(d, "--stale", "1.2.3").out, /docs\/A\.md:1:/);
  assert.ok(statSync(join(d, "docs/A.md")).isFile());
});
