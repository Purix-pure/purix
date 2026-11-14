// Run from the repo root:  node fix-repo-url.mjs
// npm checks that "repository.url" in each package.json matches the repository name GitHub signs into the
// provenance statement: "Purix-pure/purix" (capital P). Only that one line is changed in each file.
import { readFileSync, writeFileSync } from "node:fs";
const OLD = '"url": "git+https://github.com/purix-pure/purix.git"';
const NEW = '"url": "git+https://github.com/Purix-pure/purix.git"';
const files = ["packages/core/package.json", "packages/mcp-server/package.json", "packages/cli/package.json"];
const texts = files.map((f) => [f, readFileSync(f, "utf8")]);
for (const [f, t] of texts) {
  const n = t.split(OLD).length - 1;
  if (n !== 1) { console.error(`STOP: ${f} has ${n} matching line(s), expected 1. Nothing was changed.`); process.exit(1); }
}
for (const [f, t] of texts) writeFileSync(f, t.replace(OLD, NEW));
console.log("Done: repository.url changed in 3 files. Now run: git diff");
