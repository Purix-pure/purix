// packages/core/scripts/audit-tool-catalog.mjs
//
// Runs `npm audit` on the pinned lock of every npm tool in the shipped catalog (research 12, 1.1, probe P7) and fails on any
// critical or high finding. Needs network. Run it before a release and whenever the catalog changes:
//
//   node scripts/audit-tool-catalog.mjs
//
// Scope, stated plainly: npm tools only. The Python tools (pytest, pip-audit, ...) need `pip-audit`, which this script does not
// run. "High or critical" is a threshold chosen here, not research; it does not ask whether the vulnerable code is reachable
// from the way Purix runs the tool, so a failure needs a human read before a pin is moved.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const text = readFileSync(join(here, "../src/tools/catalog_data.ts"), "utf-8");
const MARK = "export const CATALOG_DATA: CatalogEntry[] = ";
const entries = JSON.parse(text.slice(text.indexOf(MARK) + MARK.length, text.lastIndexOf("];") + 1));

let failed = false;
for (const e of entries.filter((x) => x.method === "npm-ci")) {
  const dir = mkdtempSync(join(tmpdir(), `purix-audit-${e.id}-`));
  for (const [name, content] of Object.entries(e.files)) writeFileSync(join(dir, name), content);
  let out = "";
  try {
    out = execFileSync("npm", ["audit", "--package-lock-only", "--json"], { cwd: dir, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch (err) {
    out = err.stdout?.toString() ?? ""; // npm audit exits non-zero when it finds anything
  }
  let v;
  try {
    v = JSON.parse(out).metadata.vulnerabilities;
  } catch {
    console.log(`${e.id}@${e.version}: audit did not return a result (network or registry problem)`);
    failed = true;
    continue;
  }
  const bad = v.critical + v.high > 0;
  failed ||= bad;
  console.log(`${e.id.padEnd(11)} ${e.version.padEnd(8)} critical ${v.critical}  high ${v.high}  moderate ${v.moderate}  low ${v.low}  pinned ${e.releasedAt.slice(0, 10)}  ${bad ? "FAIL" : "ok"}`);
}
process.exit(failed ? 1 : 0);
