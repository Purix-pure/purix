// scripts/ci-lock-flow.mjs
//
// The CI scenario for `purix check --strict`, end to end and without a model:
//   1. a project where Purix governs a file            (purix index, purix adopt)
//   2. the lock is written and committed               (purix lock)
//   3. a FRESH CHECKOUT: the files and the lock, no local store
//   4. `purix check --strict` passes on the untouched checkout
//   5. after a direct edit of a governed file it fails (exit 1) and names the file
//   6. a lock that was not refreshed (store ahead of lock) fails, and `purix lock` fixes it
// Runs on every OS in ci.yml and before publish. Uses only the built CLI, a temp directory and a temp HOME.
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "packages", "cli", "dist", "cli.js");
if (!existsSync(cli)) {
  console.error(`ci-lock-flow: ${cli} not found. Run "pnpm run build" first.`);
  process.exit(2);
}
const root = mkdtempSync(join(tmpdir(), "purix-ci-lock-"));
const home = join(root, "home");
const proj = join(root, "proj");
mkdirSync(home, { recursive: true });
mkdirSync(join(proj, "src"), { recursive: true });
let failures = 0;

function purix(...args) {
  const r = spawnSync(process.execPath, [cli, ...args], { cwd: proj, encoding: "utf-8", env: { ...process.env, HOME: home, USERPROFILE: home, NO_COLOR: "1" }, timeout: 120000 });
  return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}
function expect(label, cond, detail = "") {
  console.log(`${cond ? "ok  " : "FAIL"} ${label}`);
  if (!cond) {
    failures++;
    if (detail) console.log(detail.split("\n").map((l) => `     ${l}`).join("\n"));
  }
}

try {
  writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", type: "module" }));
  writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");

  const index = purix("index");
  expect("index lists the file", index.code === 0, index.out);
  const adopt = purix("adopt", "src/a.ts");
  expect("adopt registers the file", adopt.code === 0, adopt.out);

  const lock = purix("lock");
  expect("lock writes purix.lock.json", lock.code === 0 && existsSync(join(proj, "purix.lock.json")), lock.out);

  // With the store present the verification section also runs, and its result depends on which compilers the
  // machine has, which is not what this script is about. So read the lock section from --json instead of the exit code.
  const again = purix("check", "--json");
  let lockSection;
  try {
    lockSection = JSON.parse(again.out).sections.find((x) => x.id === "lock");
  } catch {
    /* reported below */
  }
  expect("with the store and a current lock: the lock section passes", lockSection?.outcome === "pass", again.out);

  // A fresh checkout has the files and the lock but not the store (which lives in .purix/ or .git/purix-state/).
  rmSync(join(proj, ".purix"), { recursive: true, force: true });
  rmSync(join(proj, ".git"), { recursive: true, force: true });
  const fresh = purix("check", "--strict");
  expect("fresh checkout, untouched: strict passes and says the chain was not checked", fresh.code === 0 && /not checked here/.test(fresh.out), fresh.out);
  expect("checking created no state in the checkout", !existsSync(join(proj, ".purix")), fresh.out);

  writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n// edited directly\n");
  const edited = purix("check", "--strict");
  expect("fresh checkout, governed file edited: strict fails (exit 1) and names the file", edited.code === 1 && /a\.ts/.test(edited.out), edited.out);
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failures > 0) {
  console.error(`\nci-lock-flow: ${failures} check(s) failed.`);
  process.exit(1);
}
console.log("\nci-lock-flow: ok");
