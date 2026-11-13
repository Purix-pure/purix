// README: "`purix check` makes no network request at all." This runs the real CLI with a preload that records every attempt to
// open a network connection from inside the process (fetch, net.Socket.connect, dns lookups, http/https request) and fails the
// test if there is even one, on three project shapes: no state, a lock only (a CI checkout), and a full store. Limits, stated:
// it sees connections made by Node code in the `purix` process itself, not by a program purix starts (a type checker, say).
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliEntry = join(import.meta.dirname, "cli.ts");

const PRELOAD = `
const fs = require("node:fs");
const log = process.env.PURIX_NET_PROBE_LOG;
const hit = (what) => { try { fs.appendFileSync(log, what + "\\n"); } catch {} };
const origFetch = globalThis.fetch;
globalThis.fetch = function (...a) { hit("fetch " + String(a[0])); return origFetch.apply(this, a); };
const net = require("node:net");
const oc = net.Socket.prototype.connect;
// A connection to a local path (a unix socket or Windows pipe, which tsx uses for its own IPC) is not network traffic.
net.Socket.prototype.connect = function (...a) { let o = a[0]; if (Array.isArray(o)) o = o[0]; const local = o && typeof o === "object" && o.path !== undefined && o.port === undefined; if (!local) hit("net.connect " + JSON.stringify(o)); return oc.apply(this, a); };
const dns = require("node:dns");
const ol = dns.lookup;
dns.lookup = function (host, ...rest) { hit("dns.lookup " + host); return ol.call(this, host, ...rest); };
for (const m of ["node:http", "node:https"]) { const mod = require(m); for (const fn of ["request", "get"]) { const o = mod[fn]; mod[fn] = function (...a) { hit(m + "." + fn); return o.apply(this, a); }; } }
`;

function run(args: string[], cwd: string, home: string, probeLog: string, preload: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), PURIX_NET_PROBE_LOG: probeLog, NO_COLOR: "1" };
  delete env.CI;
  return spawnSync(process.execPath, ["--require", preload, "--import", tsxLoader, cliEntry, ...args], { cwd, env, encoding: "utf8", timeout: 120_000 });
}

describe("purix check makes no network request", () => {
  it("in a folder with no state, with a lock only, and with a full store", () => {
    const base = mkdtempSync(join(tmpdir(), "purix-nonet-"));
    try {
      const home = join(base, "home");
      const proj = join(base, "proj");
      mkdirSync(home, { recursive: true });
      mkdirSync(join(proj, "src"), { recursive: true });
      mkdirSync(join(proj, ".git"));
      const preload = join(base, "probe.cjs");
      writeFileSync(preload, PRELOAD);
      const probeLog = join(base, "probe.log");
      writeFileSync(probeLog, "");
      // Self-check: the probe itself must see a connection attempt, or an empty log proves nothing.
      const selfCheck = join(base, "selfcheck.cjs");
      writeFileSync(selfCheck, `require(${JSON.stringify(preload)}); require("node:dns").lookup("example.invalid", () => {});`);
      const self = spawnSync(process.execPath, [selfCheck], { env: { ...process.env, PURIX_NET_PROBE_LOG: probeLog }, encoding: "utf8", timeout: 30_000 });
      expect(self.status).toBe(0);
      expect(readFileSync(probeLog, "utf-8")).toContain("dns.lookup example.invalid");
      writeFileSync(probeLog, "");

      writeFileSync(join(proj, "package.json"), JSON.stringify({ name: "p", version: "1.0.0", type: "module" }));
      writeFileSync(join(proj, "src", "a.ts"), "export const a = 1;\n");

      const empty = mkdtempSync(join(base, "empty-"));
      expect(run(["check"], empty, home, probeLog, preload).status).toBe(0);

      expect(run(["index"], proj, home, probeLog, preload).status).toBe(0);
      expect(run(["adopt", "src/a.ts"], proj, home, probeLog, preload).status).toBe(0);
      expect(run(["lock"], proj, home, probeLog, preload).status).toBe(0);
      writeFileSync(probeLog, ""); // only `check` is under test; index/adopt/lock may do what they like

      run(["check", "--json"], proj, home, probeLog, preload);
      rmSync(join(proj, ".purix"), { recursive: true, force: true });
      rmSync(join(proj, ".git"), { recursive: true, force: true });
      expect(existsSync(join(proj, "purix.lock.json"))).toBe(true);
      run(["check", "--strict"], proj, home, probeLog, preload);

      expect(readFileSync(probeLog, "utf-8")).toBe("");
    } finally {
      safeRmSync(base);
    }
  });
});
