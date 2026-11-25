// scripts/test-one.mjs
//
// Run ONE test file (or a few) of any package, safely: with its own empty home folder and temp folder (scripts/test-home-preload.mjs),
// so the test can never read or change your real ~/.purix (your keys, your login).
//
//   node scripts/test-one.mjs packages/core/src/security/secrets_manager_walkup.test.ts
//   node scripts/test-one.mjs packages/cli/src/cli/dashboard/dashboard.test.ts packages/cli/src/cli/commands/receipt.test.ts
//   node scripts/test-one.mjs packages/core/src/hooks/secret_read.test.ts --name "denies"     only tests whose name contains "denies"
//
// Slashes or backslashes both work. Exit code is the test runner's.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
let name;
const files = [];
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--name") { name = argv[++i]; continue; }
  files.push(argv[i]);
}
if (files.length === 0) {
  console.error("usage: node scripts/test-one.mjs <test file> [more files] [--name <part of a test name>]");
  process.exit(2);
}

const abs = files.map((f) => resolve(root, f));
for (const f of abs) if (!existsSync(f)) { console.error(`test-one: no such file: ${f}`); process.exit(2); }

const pkgDirs = new Set();
for (const f of abs) {
  const parts = relative(root, f).split(sep);
  if (parts[0] !== "packages" || parts.length < 3) { console.error(`test-one: ${f} is not inside packages/<name>/`); process.exit(2); }
  pkgDirs.add(join(root, "packages", parts[1]));
}
if (pkgDirs.size !== 1) { console.error("test-one: give files from one package at a time (core, cli or mcp-server)."); process.exit(2); }
const [cwd] = [...pkgDirs];

const args = [
  "--import", pathToFileURL(join(root, "scripts", "test-home-preload.mjs")).href,
  "--import", "tsx",
  "--test",
  ...(name ? ["--test-name-pattern", name] : []),
  ...abs.map((f) => relative(cwd, f)),
];
const r = spawnSync(process.execPath, args, { cwd, stdio: "inherit", env: process.env });
process.exit(r.status ?? 1);
