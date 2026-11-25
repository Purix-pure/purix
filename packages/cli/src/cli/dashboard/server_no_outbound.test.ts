// check-single-point rule R6 exempts server.ts from "no node:http import" on one stated ground: it is the one inbound listener, it binds
// 127.0.0.1 and it makes no outbound request. R6 and R2 cannot see an `http.request(...)` or a `net.connect(...)` added to this file,
// so this test keeps the promise the exemption rests on. If it fails, either remove the outbound call or route it through
// core's platform/net.ts and drop the exemption.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(join(import.meta.dirname, "server.ts"), "utf8");
// Code only: comments and string literals removed, so the header comment and error messages cannot satisfy or trip a pattern.
const code = source
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("dashboard/server.ts keeps the promise behind its R6 exemption", () => {
  it("imports only createServer from node:http, and no other network module as a value", () => {
    const http = [...code.matchAll(/import\s+(type\s+)?\{([^}]*)\}\s+from\s+"node:http"/g)];
    expect(http.length).toBe(1);
    expect(http[0]![2]!.split(",").map((s) => s.trim().replace(/^type\s+/, "")).filter(Boolean).sort()).toEqual(["Server", "createServer"]);
    expect(code).not.toMatch(/from\s+"(?:node:)?(?:https|http2|tls|dgram|dns)"/);
    // `node:net` is allowed as a type import only (AddressInfo); `connect`, `createConnection`, `Socket` would open a connection.
    for (const m of code.matchAll(/import\s+(type\s+)?\{[^}]*\}\s+from\s+"node:net"/g)) expect(m[1]).toBe("type ");
    expect(code).not.toMatch(/\b(?:createConnection|net\.connect|new\s+Socket)\b/);
  });

  it("makes no outbound call", () => {
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/\b(?:http|https)\.(?:request|get)\s*\(/);
    expect(code).not.toMatch(/\bnetFetch\b/);
    expect(code).not.toMatch(/child_process/); // no curl/wget through a shell either
  });

  it("listens on 127.0.0.1 only", () => {
    const listens = [...code.matchAll(/\.listen\(([^)]*)\)/g)];
    expect(listens.length).toBeGreaterThan(0);
    for (const l of listens) expect(l[1]).toContain('"127.0.0.1"');
  });
});

describe("the rest of the dashboard folder cannot open a connection either", () => {
  const strip = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  const files = readdirSync(import.meta.dirname).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));

  it("no file here uses a client for the network, a dynamic import of one, or require", () => {
    expect(files).toContain("server.ts");
    for (const f of files) {
      const c = strip(readFileSync(join(import.meta.dirname, f), "utf8"));
      expect({ f, hit: /\b(?:XMLHttpRequest|WebSocket|EventSource|undici)\b/.test(c) }).toEqual({ f, hit: false });
      expect({ f, hit: /\bimport\(\s*["'](?:node:)?(?:https?|http2|net|tls|dgram|dns)["']/.test(c) }).toEqual({ f, hit: false });
      expect({ f, hit: /\brequire\(/.test(c) }).toEqual({ f, hit: false });
      expect({ f, hit: /\bfetch\s*\(/.test(c) }).toEqual({ f, hit: false });
    }
  });

  it("only check_state.ts starts a process, and it starts only the Purix CLI (execFile, no shell)", () => {
    for (const f of files) {
      const c = strip(readFileSync(join(import.meta.dirname, f), "utf8"));
      const uses = /child_process/.test(c);
      expect({ f, uses }).toEqual({ f, uses: f === "check_state.ts" });
      if (uses) {
        expect(c).not.toMatch(/\b(?:exec|execSync|spawnSync|spawn)\s*\(/);
        expect(c).not.toMatch(/shell\s*:\s*true/);
      }
    }
  });
});
