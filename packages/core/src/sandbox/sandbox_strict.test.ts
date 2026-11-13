// packages/core/src/sandbox/sandbox_strict.test.ts
//
// A4-1 minimal (security review, findings F16 and V1). Two things, on Linux without bubblewrap (the case this suite runs in):
//   1. Strict isolation (PURIX_STRICT_ISOLATION=1): a step that would run with no sandbox is refused instead of run, and the
//      refusal reaches the caller as an infrastructure result ("sandbox_unavailable"), so the repair loop never sees it.
//   2. A project's own tool is no longer handed the person's environment: the TypeScript compiler and ESLint steps ran with the
//      whole of process.env, and a planted `eslint` printed the secret in it (review probe idiom.mts).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolated, IsolationRequiredError, SandboxUnavailableError } from "./sandbox_exec";
import { verifyInSandbox } from "./sandbox";
import { registerLanguageProvider } from "../language/registry";
import type { LanguageProvider } from "../language/provider";
import { checkIdioms } from "../verify/idiom";
import { infrastructureStopOf } from "../recovery/infrastructure_stop.js";
import { verificationOutcome } from "../verify/outcome.js";
import { closeDb } from "../manifest/store";
import { safeRmSync } from "../platform/fs_retry.js";

const unixOnly = { skip: process.platform === "win32" ? "needs `which` and Unix shebangs" : false };

let dir: string;
let emptyBin: string;
let saved: Record<string, string | undefined>;
let cwd0: string;
const KEYS = ["PATH", "PURIX_STRICT_ISOLATION", "PURIX_PROBE_SECRET"];

beforeEach(() => {
  cwd0 = process.cwd();
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), "purix-strict-"));
  emptyBin = mkdtempSync(join(tmpdir(), "purix-emptybin-"));
  writeFileSync(join(dir, "package.json"), "{}");
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  closeDb();
  process.chdir(cwd0);
  safeRmSync(dir);
  safeRmSync(emptyBin);
});

/** No `which`, so neither bwrap nor sandbox-exec is found on any platform: the unisolated branch. */
const noSandboxTools = () => { process.env.PATH = emptyBin; };

describe("runIsolated: strict isolation", () => {
  it("runs unisolated and says so when strict mode is off (today's behaviour, unchanged)", unixOnly, () => {
    noSandboxTools();
    delete process.env.PURIX_STRICT_ISOLATION;
    const r = runIsolated([process.execPath, "-e", "process.stdout.write('ran')"], { cwd: dir, writableDir: dir });
    expect(r.isolation).toBe("none");
    expect(r.stdout).toBe("ran");
  });

  it("refuses to run when strict mode is on and no sandbox tool is found, and does not start the command", unixOnly, () => {
    noSandboxTools();
    process.env.PURIX_STRICT_ISOLATION = "1";
    const marker = join(dir, "marker.txt");
    expect(() => runIsolated([process.execPath, "-e", `require('fs').writeFileSync(${JSON.stringify(marker)}, 'x')`], { cwd: dir, writableDir: dir })).toThrow(IsolationRequiredError);
    expect(() => runIsolated([process.execPath, "-e", "0"], { cwd: dir, writableDir: dir })).toThrow(/PURIX_STRICT_ISOLATION/);
    expect(existsSync(marker)).toBe(false);
  });

  it("the refusal says what to do", unixOnly, () => {
    noSandboxTools();
    process.env.PURIX_STRICT_ISOLATION = "1";
    try {
      runIsolated([process.execPath, "-e", "0"], { cwd: dir, writableDir: dir });
      throw new Error("should have thrown");
    } catch (err) {
      const m = (err as Error).message;
      expect(m).toMatch(/bubblewrap|bwrap/i);
      expect(m).toMatch(/sandbox-exec|macOS/i);
      expect(m).toMatch(/Windows/i);
      expect(m).toContain("unset PURIX_STRICT_ISOLATION");
    }
  });

  for (const off of ["0", "false", "", "no"]) {
    it(`PURIX_STRICT_ISOLATION=${JSON.stringify(off)} is not strict`, unixOnly, () => {
      noSandboxTools();
      process.env.PURIX_STRICT_ISOLATION = off;
      expect(runIsolated([process.execPath, "-e", "0"], { cwd: dir, writableDir: dir }).isolation).toBe("none");
    });
  }

  it("gives the child a scratch HOME (the writable directory), not the person's", unixOnly, () => {
    noSandboxTools();
    delete process.env.PURIX_STRICT_ISOLATION;
    const r = runIsolated([process.execPath, "-e", "process.stdout.write(String(process.env.HOME))"], { cwd: dir, writableDir: dir });
    expect(r.stdout).toBe(dir);
  });

  it("does not hand the child a credential-like variable that the old deny-list missed", unixOnly, () => {
    noSandboxTools();
    process.env.AWS_ACCESS_KEY_ID = "AKIAEXAMPLEEXAMPLE00";
    try {
      const r = runIsolated([process.execPath, "-e", "process.stdout.write(String(process.env.AWS_ACCESS_KEY_ID))"], { cwd: dir, writableDir: dir });
      expect(r.stdout).toBe("undefined");
    } finally {
      delete process.env.AWS_ACCESS_KEY_ID;
    }
  });
});

describe("verifyInSandbox: a missing or broken sandbox is an infrastructure result, not an exception", () => {
  const throwing = (id: string, err: Error): LanguageProvider => ({
    id,
    minSupportedVersion: "1.0.0",
    detect: () => false,
    verify: () => { throw err; },
    runTests: () => ({ status: "pass", quarantinedFailures: [] }),
    checkIdiom: () => ({ ran: true, findings: [] }),
    auditDependencies: async () => ({ pinning: [], vulnerabilities: [], ran: false }),
    getFingerprint: async () => ({}),
  });

  it("strict mode with no sandbox: status fail, infrastructure sandbox_unavailable, never repair-eligible", () => {
    registerLanguageProvider(throwing("strictlang", new IsolationRequiredError()));
    const r = verifyInSandbox("c1", [{ path: "a.strict", new_content: "x" }], dir, "strictlang");
    expect(r.status).toBe("fail");
    if (r.status !== "fail") return;
    expect(r.infrastructure).toBe("sandbox_unavailable");
    expect(r.reason).toMatch(/PURIX_STRICT_ISOLATION/);
    expect(infrastructureStopOf(r)?.kind).toBe("sandbox_unavailable");
    expect(verificationOutcome(r)).toBe("error");
  });

  it("bwrap installed but unable to start (the Docker case) is the same kind of result, not a crash", () => {
    registerLanguageProvider(throwing("brokenbwrap", new SandboxUnavailableError("bwrap: Creating new namespace failed: Operation not permitted")));
    const r = verifyInSandbox("c1", [{ path: "a.broken", new_content: "x" }], dir, "brokenbwrap");
    expect(r.status).toBe("fail");
    if (r.status !== "fail") return;
    expect(r.infrastructure).toBe("sandbox_unavailable");
    expect(r.reason).toMatch(/failed to create an isolated sandbox/);
  });

  it("any other error from a provider is still thrown, not swallowed", () => {
    registerLanguageProvider(throwing("boomlang", new Error("boom")));
    expect(() => verifyInSandbox("c1", [{ path: "a.boom", new_content: "x" }], dir, "boomlang")).toThrow("boom");
  });
});

describe("a project's own tools do not see the person's environment (V1)", () => {
  it("ESLint is started with the allow-listed environment: a planted eslint cannot print a secret", unixOnly, () => {
    process.env.PURIX_PROBE_SECRET = "TOP-SECRET-VALUE";
    writeFileSync(join(dir, "eslint.config.js"), "");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "eslint");
    writeFileSync(
      bin,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify([{ filePath: ${JSON.stringify(join(dir, "a.ts"))}, messages: [{ line: 1, ruleId: "probe", message: "secret=" + process.env.PURIX_PROBE_SECRET + ";home=" + process.env.HOME }] }]));\n`
    );
    chmodSync(bin, 0o755);
    const r = checkIdioms(["a.ts"], dir);
    expect(r.ran).toBe(true);
    const message = r.findings[0]!.message;
    expect(message).not.toContain("TOP-SECRET-VALUE");
    expect(message).toContain("secret=undefined");
    expect(message).not.toContain(String(saved.HOME ?? process.env.HOME));
  });

  it("with strict isolation on, ESLint does not run at all (it has no sandbox): ran false, never clean", unixOnly, () => {
    writeFileSync(join(dir, "eslint.config.js"), "");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "eslint");
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.stdout.write("[]");\n`);
    chmodSync(bin, 0o755);
    process.env.PURIX_STRICT_ISOLATION = "1";
    expect(checkIdioms(["a.ts"], dir)).toEqual({ findings: [], ran: false });
  });

  it("the TypeScript compiler step is started with the allow-listed environment", unixOnly, async () => {
    const { verifyComponent } = await import("../verify/verify");
    process.env.PURIX_PROBE_SECRET = "TOP-SECRET-VALUE";
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "tsc");
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.stderr.write("env:" + String(process.env.PURIX_PROBE_SECRET));\nprocess.exit(1);\n`);
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    const r = verifyComponent([join(dir, "a.ts")], dir);
    expect(r.status).toBe("fail");
    if (r.status === "fail") {
      expect(r.reason).toContain("env:undefined");
      expect(r.reason).not.toContain("TOP-SECRET-VALUE");
    }
  });

  it("with strict isolation on, the TypeScript compiler step is refused: it has no sandbox, and the result says that", unixOnly, async () => {
    const { verifyComponent } = await import("../verify/verify");
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    const bin = join(dir, "node_modules", ".bin", "tsc");
    writeFileSync(bin, `#!/usr/bin/env node\nprocess.exit(0);\n`);
    chmodSync(bin, 0o755);
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    process.env.PURIX_STRICT_ISOLATION = "1";
    const r = verifyComponent([join(dir, "a.ts")], dir);
    expect(r.status).toBe("fail");
    if (r.status !== "fail") return;
    expect(r.infrastructure).toBe("sandbox_unavailable");
    expect(r.reason).toMatch(/not run|did not run|not isolated|outside the sandbox/i);
    expect(r.reason).toMatch(/PURIX_STRICT_ISOLATION/);
  });
});
