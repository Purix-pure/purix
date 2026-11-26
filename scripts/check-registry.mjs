#!/usr/bin/env node
// scripts/check-registry.mjs: asks the npm registry what is really published, so a release fails early and clearly.
//
//   node scripts/check-registry.mjs pre  --version 0.4.0-beta.2 --tag beta
//       Before publishing. Fails if any of the three packages already has that version (npm never allows a version to be
//       published twice), or if the dist-tag does not fit the version (a prerelease must never get "latest").
//   node scripts/check-registry.mjs post --version 0.4.0-beta.2 --tag beta [--install]
//       After publishing. Fails unless all three packages show that version, the dist-tag points at it, and the version
//       carries a provenance attestation. With --install it also installs @purix/cli from the registry into an empty
//       folder and checks `purix --version`. Retries for a few minutes, because the registry can lag behind a publish.
//
// Exit 0 = fine, 1 = the registry disagrees, 2 = bad usage. PURIX_REGISTRY overrides the registry URL (used by the tests).
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const PACKAGES = ["@purix/core", "@purix/mcp-server", "@purix/cli"];
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?$/;

export function expectedTag(version) {
  if (!version.includes("-")) return "latest";
  const t = /^[^-]+-([A-Za-z]+)/.exec(version)?.[1];
  return t ?? "next"; // same rule as the "Compute npm dist-tag" step in publish.yml
}

export async function fetchPackument(name, registry = process.env.PURIX_REGISTRY ?? "https://registry.npmjs.org") {
  const res = await fetch(`${registry}/${name.replace("/", "%2f")}`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(20000) });
  if (res.status === 404) return null; // package (or its first version) does not exist yet
  if (!res.ok) throw new Error(`registry answered HTTP ${res.status} for ${name}`);
  return res.json();
}

export function checkPre(docs, version, tag) {
  const problems = [];
  if (tag === "latest" && version.includes("-")) problems.push(`prerelease ${version} must not be published under the "latest" tag`);
  if (tag !== expectedTag(version)) problems.push(`tag "${tag}" does not fit version ${version} (expected "${expectedTag(version)}")`);
  for (const [name, doc] of docs) if (doc?.versions?.[version]) problems.push(`${name}@${version} is already on npm; versions cannot be reused, so bump the version`);
  return problems;
}

export function checkPost(docs, version, tag) {
  const problems = [];
  for (const [name, doc] of docs) {
    const v = doc?.versions?.[version];
    if (!v) { problems.push(`${name}@${version} is not on the registry`); continue; }
    if (doc["dist-tags"]?.[tag] !== version) problems.push(`${name}: dist-tag "${tag}" points at ${doc["dist-tags"]?.[tag] ?? "nothing"}, expected ${version}`);
    if (!v.dist?.attestations?.provenance) problems.push(`${name}@${version} has no provenance attestation`);
  }
  return problems;
}

async function load() { return Promise.all(PACKAGES.map(async (n) => [n, await fetchPackument(n)])); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const [mode, ...rest] = process.argv.slice(2);
  const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
  const version = opt("--version"), tag = opt("--tag");
  if (!["pre", "post"].includes(mode) || !version || !SEMVER.test(version) || !tag) {
    console.error("usage: check-registry.mjs pre|post --version <x.y.z[-pre.n]> --tag <dist-tag> [--install]");
    process.exit(2);
  }
  if (mode === "pre") {
    const problems = checkPre(await load(), version, tag);
    if (problems.length) { console.error(problems.map((p) => `FAIL  ${p}`).join("\n")); process.exit(1); }
    console.log(`PASS  ${version} is not on npm yet for any of the ${PACKAGES.length} packages, and tag "${tag}" fits it`);
    return;
  }
  let problems = [];
  for (let attempt = 1; attempt <= 10; attempt++) {
    problems = checkPost(await load(), version, tag);
    if (!problems.length) break;
    if (attempt < 10) { console.log(`registry not ready yet (${problems.length} difference(s)); retrying in 15s (${attempt}/10)`); await sleep(15000); }
  }
  if (problems.length) { console.error(problems.map((p) => `FAIL  ${p}`).join("\n")); process.exit(1); }
  console.log(`PASS  all ${PACKAGES.length} packages are on npm at ${version}, tag "${tag}" points at it, provenance present`);
  if (rest.includes("--install")) {
    const dir = mkdtempSync(join(tmpdir(), "purix-registry-"));
    try {
      // On Windows npm is npm.cmd, which cannot be started without a shell (ENOENT); the arguments here are fixed strings and a checked version.
      const shell = process.platform === "win32";
      execFileSync("npm", ["init", "-y"], { cwd: dir, stdio: "ignore", shell });
      execFileSync("npm", ["install", `@purix/cli@${version}`], { cwd: dir, stdio: "inherit", shell });
      const out = execFileSync(join(dir, "node_modules", ".bin", process.platform === "win32" ? "purix.cmd" : "purix"), ["--version"], { cwd: dir, encoding: "utf8", shell: process.platform === "win32" }).trim();
      if (out !== version) { console.error(`FAIL  installed purix reports "${out}", expected ${version}`); process.exit(1); }
      console.log(`PASS  fresh install of @purix/cli@${version} from npm runs and reports ${out}`);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main().catch((e) => { console.error(`FAIL  ${e.message}`); process.exit(1); });
