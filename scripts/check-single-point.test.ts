// scripts/check-single-point.test.ts: plain node:test; run with `pnpm run single-point-check:test`.
import { describe, it } from "node:test";
import { expect } from "expect";
import { compare, countViolations, stripComments, isHardZero } from "./check-single-point.ts";

const empty = () => ({ R1: {}, R2: {}, R3: {}, R4: {}, R5: {}, R6: {}, R7: {}, R8: {} });
const f = (rel, text) => ({ rel, text });

describe("stripComments", () => {
  it("drops line and block comments but keeps string text", () => {
    const out = stripComments('const a = "console.log"; // console.log(1)\n/* fetch( */ const b = 1;');
    expect(out).toContain('"console.log"');
    expect(out).not.toContain("console.log(1)");
    expect(out).not.toContain("fetch(");
  });
  it("does not treat // inside a string as a comment", () => {
    expect(stripComments('const u = "https://x.test/a"; fetch(u)')).toContain("fetch(u)");
  });
});

describe("countViolations", () => {
  it("counts R1-R5 and ignores tests, comments and layout.ts for R3", () => {
    const c = countViolations([
      f("a.ts", 'console.log(1); console.error(2); process.stdout.write("x"); fetch("u"); const d = ".purix"; process.env.X;'),
      f("a.test.ts", "console.log(1)"),
      f("platform/layout.ts", 'const d = ".purix"'),
      f("b.ts", "// console.log(1)\nconst x = 1;"),
      f("c.ts", 'const t = ".purix-tmp";'),
    ]);
    expect(c.R1).toEqual({ "a.ts": 3 });
    expect(c.R2).toEqual({ "a.ts": 1 });
    expect(c.R3).toEqual({ "a.ts": 1 });
    expect(c.R4).toEqual({ "a.ts": 1 });
  });
});

describe("compare (the ratchet)", () => {
  const base = () => ({ ...empty(), R1: { "a.ts": 2 } });
  it("passes when counts are equal or fall", () => {
    expect(compare({ ...empty(), R1: { "a.ts": 2 } }, base()).failures).toEqual([]);
    const v = compare({ ...empty(), R1: { "a.ts": 1 } }, base());
    expect(v.failures).toEqual([]);
    expect(v.improvements).toEqual(["R1 a.ts: 2 -> 1"]);
  });
  it("fails when a count rises", () => {
    expect(compare({ ...empty(), R1: { "a.ts": 3 } }, base()).failures.length).toBe(1);
  });
  it("fails when a new file starts violating", () => {
    expect(compare({ ...empty(), R1: { "a.ts": 2, "new.ts": 1 } }, base()).failures.length).toBe(1);
  });
  it("everything under tools/ must be zero even if someone put it in the baseline", () => {
    expect(isHardZero("tools/broker.ts")).toBe(true);
    expect(isHardZero("tools/purpose.ts")).toBe(true);
    expect(isHardZero("platform/layout.ts")).toBe(false);
    const v = compare({ ...empty(), R2: { "tools/broker.ts": 1 } }, { ...empty(), R2: { "tools/broker.ts": 1 } });
    expect(v.failures.length).toBe(1);
  });
});

describe("R5: file writes go through platform/atomic_write.ts", () => {
  it("counts writeFileSync and renameSync, ignores atomic_write.ts, appendFileSync, comments and tests", () => {
    const c = countViolations([
      f("a.ts", "writeFileSync(p, x); renameSync(a, b); appendFileSync(log, y); // writeFileSync(no)"),
      f("platform/atomic_write.ts", "writeFileSync(p, x); renameSync(a, b);"),
      f("a.test.ts", "writeFileSync(p, x);"),
    ]);
    expect(c.R5).toEqual({ "a.ts": 2 });
  });

  it("a new direct write in a clean file fails the ratchet", () => {
    const v = compare({ ...empty(), R5: { "new.ts": 1 } }, empty());
    expect(v.failures.length).toBe(1);
  });
});

describe("R2 and R4: one network door and one environment door", () => {
  it("R2 counts fetch( everywhere except platform/net.ts", () => {
    const c = countViolations([
      f("a.ts", "await fetch(url); // fetch(no)"),
      f("platform/net.ts", "return globalThis.fetch(u, init);"),
    ]);
    expect(c.R2).toEqual({ "a.ts": 1 });
  });

  it("R4 counts process.env everywhere except platform/env.ts", () => {
    const c = countViolations([
      f("a.ts", "const k = process.env.X; const e = process.env;"),
      f("platform/env.ts", "return process.env[name];"),
    ]);
    expect(c.R4).toEqual({ "a.ts": 2 });
  });

  it("a new fetch or process.env in a clean file fails the ratchet", () => {
    expect(compare({ ...empty(), R2: { "new.ts": 1 } }, empty()).failures.length).toBe(1);
    expect(compare({ ...empty(), R4: { "new.ts": 1 } }, empty()).failures.length).toBe(1);
  });
});

describe("R6: no network-capable import outside platform/net.ts", () => {
  it("counts SDK and node:http(s) imports, in core, cli and mcp-server, and exempts net.ts and tests", () => {
    const c = countViolations([
      { rel: "llm/a.ts", text: 'const { GoogleGenAI } = await import("@google/genai");' },
      { rel: "llm/b.ts", text: 'import https from "node:https";' },
      { rel: "llm/c.ts", text: 'import OpenAI from "openai";' },
      { rel: "@cli/x.ts", text: 'import { request } from "node:http";' },
      { rel: "@mcp/y.ts", text: "const x = require('undici');" },
      { rel: "platform/net.ts", text: 'import { isIP } from "node:net"; import h from "node:https";' },
      { rel: "llm/d.test.ts", text: 'import h from "node:https";' },
      { rel: "llm/e.ts", text: '// import h from "node:https";\nimport { isIP } from "node:net";' },
    ]);
    expect(c.R6).toEqual({ "llm/a.ts": 1, "llm/b.ts": 1, "llm/c.ts": 1, "@cli/x.ts": 1, "@mcp/y.ts": 1 });
  });
  it("other rules do not apply to cli and mcp-server files (they print and read env by design)", () => {
    const c = countViolations([{ rel: "@cli/z.ts", text: 'console.log(process.env.HOME); fetch("x")' }]);
    expect(c.R1).toEqual({});
    expect(c.R2).toEqual({});
    expect(c.R4).toEqual({});
  });
  it("a new network import in a clean file fails the ratchet", () => {
    const v = compare({ ...empty(), R6: { "llm/new.ts": 1 } }, empty());
    expect(v.failures.length).toBe(1);
  });
});

describe("R8: one spawn point (platform/spawn_sync.ts)", () => {
  it("counts a direct node:child_process import, ignores comments, tests, and the OpenCode plugin text in hooks/install.ts", () => {
    const c = countViolations([
      f("hooks/path_check.ts", 'import { spawnSync } from "node:child_process";'),
      f("a.ts", 'const cp = await import("child_process"); const r = require("node:child_process");'),
      f("b.ts", '// import { spawnSync } from "node:child_process";'),
      f("a.test.ts", 'import { spawn } from "node:child_process";'),
      f("hooks/install.ts", 'const plugin = `import { spawnSync } from "node:child_process";`;'),
    ]);
    expect(c.R8).toEqual({ "hooks/path_check.ts": 1, "a.ts": 2 });
  });
  it("is not applied to the cli and mcp-server packages", () => {
    const c = countViolations([f("@cli/x.ts", 'import { spawn } from "node:child_process";')]);
    expect(c.R8).toEqual({});
  });
  it("a new direct import in a clean file fails the ratchet", () => {
    expect(compare({ ...empty(), R8: { "new.ts": 1 } }, empty()).failures.length).toBe(1);
  });
});
