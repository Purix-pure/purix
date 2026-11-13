// scripts/measure-untested-files.mjs
// H7 / A6: which source files have no test that names them? Measurement only; it never fails the build unless asked to.
//
// A non-test .ts file under packages/*/src counts as:
//   named      a test file with the same stem sits next to it (a.ts and a.test.ts, a_edges.test.ts, a.something.test.ts), or
//              a test in the same package imports it directly (static import, re-export or import()).
//   spawned    a test refers to the file by its name as text (a worker or child process a test starts), with no import
//   reached    no test names it, but a file that a test imports imports it (so the code runs under test, with no test aimed at it).
//   unreached  neither. These are the files a change can break with no test noticing.
// "Imports" is read from the source text with a regular expression, not a parser: a specifier built at run time is not seen.
// Files under fixtures/, test-support/, *.d.ts and entry files that only start a program are listed but marked "entry".
//
// Usage: node scripts/measure-untested-files.mjs [--json] [--fail-over N]
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PURIX_MEASURE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const asJson = args.includes("--json");
const failOver = args.includes("--fail-over") ? Number(args[args.indexOf("--fail-over") + 1]) : null;

const SKIP_DIRS = new Set(["node_modules", "dist", "fixtures", "test_fixtures"]);
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const pkgs = readdirSync(join(root, "packages")).filter((n) => existsSync(join(root, "packages", n, "src")));
const all = pkgs.flatMap((n) => walk(join(root, "packages", n, "src")));
const isTest = (f) => /\.test\.m?ts$/.test(f);
const sources = all.filter((f) => !isTest(f));
const tests = all.filter(isTest);
const rel = (f) => relative(root, f).split("\\").join("/");

const IMPORT_RE = /(?:import|export)\s+(?:type\s+)?(?:[^'"()]*?\sfrom\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
function resolveSpec(fromFile, spec) {
  let base;
  if (spec.startsWith(".")) base = resolve(dirname(fromFile), spec);
  else if (spec.startsWith("@purix/core/")) base = join(root, "packages/core/src", spec.slice("@purix/core/".length));
  else return null;
  const stem = base.replace(/\.(m?js|ts)$/, "");
  for (const c of [`${stem}.ts`, `${stem}.mts`, join(stem, "index.ts"), base]) if (existsSync(c) && statSync(c).isFile()) return c;
  return null;
}
const importsCache = new Map();
function importsOf(f) {
  if (importsCache.has(f)) return importsCache.get(f);
  const text = readFileSync(f, "utf8");
  const out = new Set();
  for (const m of text.matchAll(IMPORT_RE)) {
    const r = resolveSpec(f, m[1] ?? m[2]);
    if (r) out.add(r);
  }
  importsCache.set(f, out);
  return out;
}

const pkgOf = (f) => rel(f).split("/")[1];
const direct = new Set();
for (const t of tests) for (const i of importsOf(t)) if (!isTest(i)) direct.add(i);

const stemNamed = new Set();
const testStems = tests.map((t) => ({ dir: dirname(t), stem: basename(t).replace(/\.test\.m?ts$/, "") }));
for (const s of sources) {
  const stem = basename(s).replace(/\.m?ts$/, "");
  const dir = dirname(s);
  if (testStems.some((t) => t.dir === dir && (t.stem === stem || t.stem.startsWith(`${stem}_`) || t.stem.startsWith(`${stem}.`)))) stemNamed.add(s);
}

const named = new Set([...direct].filter((f) => sources.includes(f)));
for (const s of stemNamed) named.add(s);
const testText = tests.map((t) => readFileSync(t, "utf8")).join("\n");
const spawnedByName = (s) => {
  const stem = basename(s).replace(/\.m?ts$/, "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9_])${stem}\\.(?:m?ts|m?js)(?![A-Za-z0-9_])`).test(testText);
};
const spawned = new Set(sources.filter((s) => !named.has(s) && spawnedByName(s)));
for (const s of spawned) named.add(s);
const reached = new Set();
const queue = [...named];
while (queue.length) {
  const f = queue.pop();
  for (const i of importsOf(f)) if (!isTest(i) && !named.has(i) && !reached.has(i)) { reached.add(i); queue.push(i); }
}
const isHelper = (f) => /\/test-support\//.test(rel(f));
const rows = sources.map((f) => ({
  file: rel(f),
  package: pkgOf(f),
  status: isHelper(f) ? "helper" : spawned.has(f) ? "spawned" : named.has(f) ? "named" : reached.has(f) ? "reached" : "unreached",
  lines: readFileSync(f, "utf8").split("\n").length,
}));
const count = (s) => rows.filter((r) => r.status === s).length;
const stemOnlyUnnamed = sources.filter((f) => !stemNamed.has(f) && !isHelper(f)).length;
const summary = { sourceFiles: rows.length, testFiles: tests.length, stemOnlyUnnamed, named: count("named"), spawned: count("spawned"), reached: count("reached"), unreached: count("unreached"), helper: count("helper") };
const unnamed = rows.filter((r) => r.status === "reached" || r.status === "unreached");

if (asJson) {
  console.log(JSON.stringify({ summary, unnamed }, null, 2));
} else {
  console.log(`Source files ${summary.sourceFiles}, test files ${summary.testFiles}`);
  console.log(`  no sibling test with the same name (strictest reading): ${summary.stemOnlyUnnamed}`);
  console.log(`  named by a test (sibling or direct import): ${summary.named}`);
  console.log(`  started by a test as a worker, by name: ${summary.spawned}`);
  console.log(`  no test names it, but a tested file imports it (reached): ${summary.reached}`);
  console.log(`  no test names it and none reaches it (unreached): ${summary.unreached}`);
  console.log(`  test helpers: ${summary.helper}`);
  console.log(`No named test: ${unnamed.length}`);
  for (const r of unnamed.sort((a, b) => b.lines - a.lines)) console.log(`  ${r.status.padEnd(9)} ${String(r.lines).padStart(5)}  ${r.file}`);
}
if (failOver !== null && unnamed.length > failOver) {
  console.error(`More files without a named test (${unnamed.length}) than the limit (${failOver}).`);
  process.exit(1);
}
