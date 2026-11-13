// F05-01 first slice: deriveImportEdges. Real files in a throwaway folder. Not wired into anything yet (see test_discovery.ts).
// Measured separately against TypeScript's own module resolution on Purix's packages: see the handoff.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deriveImportEdges } from "./test_discovery.js";
import { safeRmSync } from "../platform/fs_retry.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "purix-edges-")); });
afterEach(() => safeRmSync(dir));
function put(rel: string, content: string): void { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), content); }
const ALL = ["src/a.ts", "src/b.ts", "src/lib/index.ts", "src/lib/c.ts", "src/d.ts"];

describe("deriveImportEdges", () => {
  it("resolves relative imports written with .js, bare names, folders and multi-line imports", () => {
    put("src/a.ts", `import { b } from "./b.js";\nimport {\n  c,\n} from "./lib/c.js";\nimport * as lib from "./lib";\n`);
    for (const f of ALL.slice(1)) put(f, "export const x = 1;\n");
    expect(deriveImportEdges(ALL, dir)).toEqual([
      { from: "src/a.ts", to: "src/b.ts" }, { from: "src/a.ts", to: "src/lib/c.ts" }, { from: "src/a.ts", to: "src/lib/index.ts" },
    ]);
  });
  it("sees export-from, side-effect, dynamic and require forms", () => {
    put("src/a.ts", `export * from "./b.js";\nimport "./d.js";\nconst m = await import("./lib/c.js");\nconst r = require("./lib");\n`);
    for (const f of ALL.slice(1)) put(f, "");
    expect(deriveImportEdges(ALL, dir).map((e) => e.to).sort()).toEqual(["src/b.ts", "src/d.ts", "src/lib/c.ts", "src/lib/index.ts"]);
  });
  it("ignores package imports, files outside the set, and self-imports; lists each edge once", () => {
    put("src/a.ts", `import fs from "node:fs";\nimport x from "left-pad";\nimport "./outside.js";\nimport "./a.js";\nimport "./b.js";\nimport "./b.js";\n`);
    put("src/b.ts", "");
    expect(deriveImportEdges(["src/a.ts", "src/b.ts"], dir)).toEqual([{ from: "src/a.ts", to: "src/b.ts" }]);
  });
  it("follows tsconfig paths aliases", () => {
    put("tsconfig.json", `{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["src/lib/*"] }, } }`);
    put("src/a.ts", `import { c } from "@lib/c";\n`);
    put("src/lib/c.ts", "");
    expect(deriveImportEdges(["src/a.ts", "src/lib/c.ts"], dir)).toEqual([{ from: "src/a.ts", to: "src/lib/c.ts" }]);
  });
  it("skips unreadable and non-JS/TS files without failing", () => {
    put("src/a.ts", `import "./gone.js";\n`);
    expect(deriveImportEdges(["src/a.ts", "src/missing.ts", "README.md"], dir)).toEqual([]);
  });
});
