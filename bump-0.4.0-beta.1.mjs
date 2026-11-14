// Run from the repo root:  node bump-0.4.0-beta.1.mjs
// Changes the version 0.4.0-beta.0 -> 0.4.0-beta.1 in the files that must agree for a release,
// and refuses to continue if any file does not contain exactly the number of matches expected.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const OLD = "0.4.0-beta.0";
const NEW = "0.4.0-beta.1";
// [file, expected number of occurrences of OLD]
const FILES = [
  ["package.json", 1],
  ["packages/core/package.json", 1],
  ["packages/mcp-server/package.json", 2],
  ["packages/cli/package.json", 3],
  ["server.json", 2],
  ["docker-compose.yml", 2],
  ["pnpm-lock.yaml", 3],
  ["packages/core/README.md", 1],
  ["packages/mcp-server/README.md", 1],
  ["packages/cli/README.md", 1],
];

const count = (s, sub) => s.split(sub).length - 1;
const plan = [];
for (const [file, expected] of FILES) {
  if (!existsSync(file)) { console.error(`MISSING: ${file} (run this from the repo root)`); process.exit(1); }
  const text = readFileSync(file, "utf8");
  const n = count(text, OLD);
  if (n !== expected) { console.error(`STOP: ${file} has ${n} occurrence(s) of ${OLD}, expected ${expected}. Nothing was changed.`); process.exit(1); }
  plan.push([file, text]);
}

// README.md (root): only the "Release status" sentence.
const rootReadme = readFileSync("README.md", "utf8");
const marker = `The version in this repository is **${OLD}**.`;
if (count(rootReadme, marker) !== 1) { console.error(`STOP: README.md release-status sentence not found exactly once. Nothing was changed.`); process.exit(1); }

// Changelog: mark beta.0 as published and add a beta.1 entry.
const clPath = "docs/compliance/CHANGELOG.md";
const cl = readFileSync(clPath, "utf8");
const clMarker = `## [${OLD}] — not yet published`;
if (count(cl, clMarker) !== 1) { console.error(`STOP: ${clPath} heading not found exactly once. Nothing was changed.`); process.exit(1); }

for (const [file, text] of plan) writeFileSync(file, text.split(OLD).join(NEW));
writeFileSync("README.md", rootReadme.replace(marker, `The version in this repository is **${NEW}**.`));
writeFileSync(
  clPath,
  cl.replace(
    clMarker,
    `## [${NEW}] — release pipeline\n\nSame code as ${OLD}; the version number changed so the release can go out through GitHub Actions with npm trusted publishing (and npm provenance).\n\n## [${OLD}] — published 2026-11-14 (by hand, without provenance)`
  )
);
console.log(`Done: ${FILES.length + 2} files changed to ${NEW}. Now run: git diff --stat`);
