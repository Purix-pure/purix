// scripts/measure-unused-exports.mjs
// H4 dead-code scan (measurement only). Lists exported names that no OTHER non-test source file mentions.
//   test-only   another file mentions it, but only test files do: the code exists for a test
//   unused      no other file mentions it at all: either dead code or used only inside its own file (then it need not be exported)
// A name is "mentioned" when the word appears in the text of another file, so a common name can hide a real dead export (a false
// negative), and a name built at run time is not seen (a false positive). Treat the list as places to look, not as a delete list.
// Exported types are counted but not listed: a type can be part of the public surface on purpose.
// Usage: node scripts/measure-unused-exports.mjs [--json]
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PURIX_MEASURE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const asJson = process.argv.includes("--json");
const SKIP = new Set(["node_modules", "dist", "fixtures", "test_fixtures"]);
function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (SKIP.has(n)) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.m?ts$/.test(n) && !/\.d\.ts$/.test(n)) out.push(p);
  }
  return out;
}
const files = readdirSync(join(root, "packages"))
  .filter((n) => existsSync(join(root, "packages", n, "src")))
  .flatMap((n) => walk(join(root, "packages", n, "src")));
// scripts/ and docs-adjacent tooling count as users too
const extra = existsSync(join(root, "scripts")) ? walk(join(root, "scripts")) : [];
const text = new Map([...files, ...extra].map((f) => [f, readFileSync(f, "utf8")]));
const isTest = (f) => /\.test\.m?ts$/.test(f) || /\/test-support\//.test(f.split("\\").join("/"));
const EXPORT_RE = /^export\s+(?:declare\s+)?(?:async\s+)?(function\*?|const|let|class|interface|type|enum)\s+([A-Za-z_$][\w$]*)/gm;

const rows = [];
for (const f of files.filter((f) => !isTest(f))) {
  for (const m of text.get(f).matchAll(EXPORT_RE)) {
    const kind = m[1];
    const name = m[2];
    const re = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
    let prod = false;
    let test = false;
    for (const [g, t] of text) {
      if (g === f || !re.test(t)) continue;
      if (isTest(g)) test = true;
      else prod = true;
      if (prod) break;
    }
    if (!prod) rows.push({ file: relative(root, f).split("\\").join("/"), name, kind: /^(interface|type)$/.test(kind) ? "type" : "value", status: test ? "test-only" : "unused" });
  }
}
if (asJson) console.log(JSON.stringify(rows, null, 2));
else {
  const values = rows.filter((r) => r.kind === "value");
  const unused = values.filter((r) => r.status === "unused");
  const testOnly = values.filter((r) => r.status === "test-only");
  console.log(`Exported values (functions, constants, classes) with no other production user: ${values.length} (unused ${unused.length}, test-only ${testOnly.length})`);
  console.log(`Exported types with no other production user: ${rows.length - values.length} (not listed: a type may be public API on purpose)`);
  for (const r of values.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name))) console.log(`  ${r.status.padEnd(9)} ${r.file}  ${r.name}`);
}
