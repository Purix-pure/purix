#!/usr/bin/env node
// scripts/sbom-check.mjs: testing plan 5.5. Produces a software bill of materials for each published package and checks it
// against the lockfile, so "an SBOM is attached to the release" is something a script can say and not a hope.
//
//   node scripts/sbom-check.mjs                    writes .release-check/sbom/<package>.cdx.json, exits 1 on a problem
//   node scripts/sbom-check.mjs --out <folder>     write somewhere else (the release workflow can attach that folder)
//
// How: `pnpm --filter <package> sbom --sbom-format cyclonedx --prod` (offline; it reads the lockfile and node_modules). Then:
//   1. the document parses and says CycloneDX;
//   2. its root component is the package (name and version match package.json);
//   3. every production dependency named in package.json is listed, except workspace packages, which are the other
//      two packages of this repository and are checked for their own SBOM;
//   4. every listed component with a name and version exists in pnpm-lock.yaml as `name@version`.
// Not checked: licences, vulnerabilities (the release check runs the audit), signatures or provenance (npm shows those after a publish).
// Exit 0 = every package passed, 1 = a problem, 2 = could not run.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const outIdx = argv.indexOf("--out");
const outDir = resolve(outIdx > -1 ? argv[outIdx + 1] : join(root, ".release-check", "sbom"));
const PACKAGES = ["core", "mcp-server", "cli"];

const lockPath = join(root, "pnpm-lock.yaml");
if (!existsSync(lockPath)) { console.error("sbom-check: pnpm-lock.yaml not found"); process.exit(2); }
const lock = readFileSync(lockPath, "utf8");
// A lockfile key looks like `  ajv@8.20.0:` or `  '@scope/name@1.2.3':`; a peer-dependency suffix `(...)` may follow the version.
const inLock = (name, version) => {
  const key = `${name}@${version}`;
  return lock.includes(`  ${key}:`) || lock.includes(`  '${key}':`) || lock.includes(`  ${key}(`) || lock.includes(`  '${key}(`) || lock.includes(`/${key}`);
};

mkdirSync(outDir, { recursive: true });
let failed = 0;
for (const dir of PACKAGES) {
  const pkg = JSON.parse(readFileSync(join(root, "packages", dir, "package.json"), "utf8"));
  const problems = [];
  const r = spawnSync(`pnpm --filter ${pkg.name} sbom --sbom-format cyclonedx --prod`, { cwd: root, shell: true, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  let sbom;
  if (r.status !== 0) problems.push(`pnpm sbom exited ${r.status}: ${(r.stderr || r.stdout).trim().split("\n").slice(-3).join(" | ")}`);
  else {
    try { sbom = JSON.parse(r.stdout); } catch { problems.push("pnpm sbom printed something that is not JSON"); }
  }
  if (sbom) {
    const file = join(outDir, `${dir}.cdx.json`);
    writeFileSync(file, JSON.stringify(sbom, null, 2) + "\n");
    if (sbom.bomFormat !== "CycloneDX") problems.push(`bomFormat is "${sbom.bomFormat}", expected CycloneDX`);
    const rootC = sbom.metadata?.component;
    // pnpm names a scoped package by its bare name plus a group, so compare on the bare name.
    const bare = pkg.name.replace(/^@[^/]+\//, "");
    if (!rootC || rootC.name !== bare || rootC.version !== pkg.version) problems.push(`root component is ${rootC?.name}@${rootC?.version}, expected ${bare}@${pkg.version}`);
    const comps = sbom.components ?? [];
    const names = new Set(comps.map((c) => (c.group ? `${c.group}/${c.name}` : c.name)));
    for (const dep of Object.keys(pkg.dependencies ?? {})) {
      const workspace = String(pkg.dependencies[dep]).startsWith("workspace:");
      if (!workspace && !names.has(dep)) problems.push(`production dependency ${dep} is not in the SBOM`);
    }
    let unmatched = 0;
    for (const c of comps) {
      const full = c.group ? `${c.group}/${c.name}` : c.name;
      if (full.startsWith("@purix/")) continue; // this repository's own packages are not in the lockfile as registry entries
      if (c.name && c.version && !inLock(full, c.version)) { unmatched++; if (unmatched <= 5) problems.push(`${full}@${c.version} is in the SBOM but not in pnpm-lock.yaml`); }
    }
    if (unmatched > 5) problems.push(`... and ${unmatched - 5} more components not found in pnpm-lock.yaml`);
    if (comps.length === 0 && Object.keys(pkg.dependencies ?? {}).some((d) => !String(pkg.dependencies[d]).startsWith("workspace:"))) problems.push("the SBOM lists no components although the package has production dependencies");
    console.log(`${problems.length ? "FAIL" : "ok  "} ${pkg.name}@${pkg.version}: ${comps.length} components${problems.length ? "" : ` -> ${file}`}`);
  } else console.log(`FAIL ${pkg.name}@${pkg.version}`);
  for (const p of problems) console.log(`     ${p}`);
  if (problems.length) failed++;
}
console.log(failed ? `\nsbom-check: ${failed} package(s) failed` : `\nsbom-check: all ${PACKAGES.length} packages passed. Attach ${outDir} to the release.`);
process.exit(failed ? 1 : 0);
