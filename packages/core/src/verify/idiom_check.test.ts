// checkIdioms(): the ESLint bridge. A fake eslint executable (Unix shebang) drives the "ran" paths.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkIdioms } from "./idiom";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-idiom-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function fakeEslint(stdout: string) {
  mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
  const bin = join(dir, "node_modules", ".bin", "eslint");
  writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(stdout)});\n`);
  chmodSync(bin, 0o755);
}
const unixOnly = { skip: process.platform === "win32" ? "fake eslint needs a Unix shebang" : false };

describe("checkIdioms", () => {
  it("does not run (ran: false) without a local eslint", () => {
    writeFileSync(join(dir, "eslint.config.mjs"), "export default [];");
    expect(checkIdioms(["a.ts"], dir)).toEqual({ findings: [], ran: false });
  });
  it("does not run without an eslint config, even if the binary exists", () => {
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    writeFileSync(join(dir, "node_modules", ".bin", "eslint"), "");
    expect(checkIdioms(["a.ts"], dir)).toEqual({ findings: [], ran: false });
  });
  it("maps eslint's JSON messages to findings, tolerating missing fields", unixOnly, () => {
    writeFileSync(join(dir, ".eslintrc.json"), "{}");
    fakeEslint(JSON.stringify([{ filePath: join(dir, "src", "a.ts"), messages: [{ line: 3, ruleId: "no-var", message: "Unexpected var" }, { message: "no rule id or line" }] }, { filePath: join(dir, "b.ts") }]));
    const r = checkIdioms(["src/a.ts"], dir);
    expect(r.ran).toBe(true);
    expect(r.findings).toEqual([
      { path: join("src", "a.ts"), line: 3, rule: "no-var", message: "Unexpected var" },
      { path: join("src", "a.ts"), line: 0, rule: "unknown", message: "no rule id or line" },
    ]);
  });
  it("treats unparseable output as unknown (ran: false), never as clean", unixOnly, () => {
    writeFileSync(join(dir, "eslint.config.js"), "");
    fakeEslint("this is not json");
    expect(checkIdioms(["a.ts"], dir)).toEqual({ findings: [], ran: false });
  });
});
