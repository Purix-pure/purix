// scripts/check-import-cycles.test.mjs
// The cycle check must see a real cycle (a zero is only worth something if it can be non-zero), must ignore type-only and
// dynamic imports, and must honour the allow list.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("./check-import-cycles.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");

function project(files, allowed) {
  const root = mkdtempSync(join(tmpdir(), "purix-cycles-"));
  mkdirSync(join(root, "packages", "x", "src"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const [name, body] of Object.entries(files)) writeFileSync(join(root, "packages", "x", "src", name), body);
  if (allowed) writeFileSync(join(root, "scripts", "import-cycles.allowed.json"), JSON.stringify(allowed));
  return root;
}
const run = (root) => spawnSync(process.execPath, [script], { env: { ...process.env, PURIX_CYCLE_ROOT: root }, encoding: "utf8" });

test("a plain two-file cycle fails and names both files", () => {
  const root = project({ "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n', "b.ts": 'import { a } from "./a.js";\nexport const b = a;\n' });
  const r = run(root);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /packages\/x\/src\/a\.ts -> packages\/x\/src\/b\.ts/);
  rmSync(root, { recursive: true, force: true });
});

test("a cycle through a re-export is found", () => {
  const root = project({ "a.ts": 'export * from "./b.js";\n', "b.ts": 'import { x } from "./a.js";\nexport const y = x;\n' });
  assert.equal(run(root).status, 1);
  rmSync(root, { recursive: true, force: true });
});

test("type-only imports and dynamic imports do not count", () => {
  const root = project({
    "a.ts": 'import type { B } from "./b.js";\nexport type A = B;\n',
    "b.ts": 'export type B = string;\nexport async function load() { return (await import("./a.js")); }\n',
  });
  const r = run(root);
  assert.equal(r.status, 0, r.stdout);
  rmSync(root, { recursive: true, force: true });
});

test("a cycle in the allow list passes; the same cycle without it fails", () => {
  const files = { "a.ts": 'import { b } from "./b.js";\nexport const a = b;\n', "b.ts": 'import { a } from "./a.js";\nexport const b = a;\n' };
  const key = "packages/x/src/a.ts -> packages/x/src/b.ts";
  const allowedRoot = project(files, [key]);
  assert.equal(run(allowedRoot).status, 0);
  const bareRoot = project(files);
  assert.equal(run(bareRoot).status, 1);
  rmSync(allowedRoot, { recursive: true, force: true });
  rmSync(bareRoot, { recursive: true, force: true });
});

test("the real tree has no cycle", () => {
  const r = spawnSync(process.execPath, [script], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stdout);
});
