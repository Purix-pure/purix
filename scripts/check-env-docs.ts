// scripts/check-env-docs.ts (A12, problem catalogue 2026-11-07): every environment variable the code reads is written down in
// docs/ENVIRONMENT.md. Fails when one is not. It finds names three ways: the two tuples in core's platform/env.ts, and direct
// `process.env.NAME` / `process.env["NAME"]` reads in the cli and mcp-server packages (core reads through platform/env.ts).
// A name taken from data (a provider's key variable, a per-model override) cannot be listed and is documented as a rule in the doc.
// What it does not check: that the doc's description is true. A person reads that.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function stripLineAndBlockComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:\\])\/\/[^\n]*/g, "$1");
}

/** Variable names read as process.env.NAME or process.env["NAME"] in one source text (comments ignored). */
export function envNamesInSource(src: string): string[] {
  const text = stripLineAndBlockComments(src);
  const out = new Set<string>();
  for (const m of text.matchAll(/(?<![.\w$])process\.env(?:\.([A-Za-z_][A-Za-z0-9_]*)|\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\])/g)) out.add((m[1] ?? m[2])!);
  return [...out];
}

/** The names listed in the PURIX_ENV and AMBIENT_ENV tuples of platform/env.ts. */
export function namesFromEnvModule(src: string): string[] {
  const out: string[] = [];
  for (const tuple of ["PURIX_ENV", "AMBIENT_ENV"]) {
    const m = new RegExp(`export const ${tuple}\\s*=\\s*\\[([\\s\\S]*?)\\]\\s*as const`).exec(src);
    if (m) for (const n of m[1]!.matchAll(/["']([A-Z0-9_]+)["']/g)) out.push(n[1]!);
  }
  return out;
}

/** Names that do not appear as `NAME` (in backticks) in the doc text. */
export function undocumented(names: string[], docText: string): string[] {
  return [...new Set(names)].filter((n) => !docText.includes("`" + n + "`")).sort();
}

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist" || e === ".turbo") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith(".ts") && !p.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

function main(): void {
  const names = new Set<string>(namesFromEnvModule(readFileSync(join(root, "packages/core/src/platform/env.ts"), "utf-8")));
  for (const pkg of ["cli", "mcp-server"]) for (const f of walk(join(root, "packages", pkg, "src"))) for (const n of envNamesInSource(readFileSync(f, "utf-8"))) names.add(n);
  const doc = readFileSync(join(root, "docs/ENVIRONMENT.md"), "utf-8");
  const missing = undocumented([...names], doc);
  if (missing.length > 0) {
    console.error(`env-docs-check FAILED: ${missing.length} variable(s) read by the code are not in docs/ENVIRONMENT.md:\n  ${missing.join("\n  ")}`);
    process.exit(1);
  }
  console.log(`env-docs-check: ok (${names.size} variables, all in docs/ENVIRONMENT.md).`);
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1].replace(/\\/g, "/")}`).href) main();
