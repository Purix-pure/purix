// scripts/check-import-cycles.mjs
// H4: circular imports. Walks every non-test .ts file under packages/*/src, follows relative imports and re-exports (static only),
// and reports each cycle once. Exits 1 if there is any cycle that is not in scripts/import-cycles.allowed.json (a list of cycle
// keys: the files of the cycle, sorted, joined with " -> "). Type-only imports are skipped: they are erased and cannot cause a
// load-order problem. Dynamic import() is not followed (it is the usual way to break a cycle on purpose).
import { readdirSync, readFileSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = process.env.PURIX_CYCLE_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), "..");
const allowedPath = join(root, "scripts", "import-cycles.allowed.json");
const allowed = new Set(existsSync(allowedPath) ? JSON.parse(readFileSync(allowedPath, "utf8")) : []);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === "fixtures") continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.ts$/.test(name) && !/\.test\.ts$/.test(name) && !/\.d\.ts$/.test(name)) out.push(p);
  }
  return out;
}

const files = [];
for (const pkg of readdirSync(join(root, "packages"))) {
  const src = join(root, "packages", pkg, "src");
  if (existsSync(src)) walk(src, files);
}
const fileSet = new Set(files);

function resolveImport(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = resolve(dirname(from), spec.replace(/\.js$/, ""));
  for (const cand of [base + ".ts", join(base, "index.ts")]) if (fileSet.has(cand)) return cand;
  return null;
}

// import x from "./a"; import { x } from "./a"; export { x } from "./a"; export * from "./a"; import "./a";
const STATIC = /(^|\n)\s*(import|export)\s+(?!type\b)([^;'"]*?\s+from\s+)?["'](\.[^"']+)["']/g;
const graph = new Map();
for (const f of files) {
  const text = readFileSync(f, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const deps = new Set();
  for (const m of text.matchAll(STATIC)) {
    const to = resolveImport(f, m[4]);
    if (to && to !== f) deps.add(to);
  }
  graph.set(f, [...deps]);
}

// Tarjan's strongly connected components: every component with more than one file is a cycle.
let index = 0;
const idx = new Map(), low = new Map(), onStack = new Set(), stack = [];
const cycles = [];
function strong(v) {
  idx.set(v, index); low.set(v, index); index++; stack.push(v); onStack.add(v);
  for (const w of graph.get(v) ?? []) {
    if (!idx.has(w)) { strong(w); low.set(v, Math.min(low.get(v), low.get(w))); }
    else if (onStack.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
  }
  if (low.get(v) === idx.get(v)) {
    const comp = [];
    let w;
    do { w = stack.pop(); onStack.delete(w); comp.push(w); } while (w !== v);
    if (comp.length > 1) cycles.push(comp.map((x) => relative(root, x).split("\\").join("/")).sort());
  }
}
for (const f of files) if (!idx.has(f)) strong(f);

const unexpected = cycles.filter((c) => !allowed.has(c.join(" -> ")));
console.log(`check-import-cycles: ${files.length} files, ${cycles.length} cycle group(s), ${cycles.length - unexpected.length} allowed`);
for (const c of unexpected) console.log(`FAIL cycle (${c.length} files): ${c.join(" -> ")}`);
process.exit(unexpected.length ? 1 : 0);
