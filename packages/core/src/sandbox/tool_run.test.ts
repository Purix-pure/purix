// src/sandbox/tool_run.test.ts
//
// T1: the project's own TypeScript compiler and ESLint run through runIsolated, not a bare spawn. This machine has no real bwrap, so a fake
// `bwrap` on a prepended PATH (same technique as sandbox_exec_platform.test.ts) stands in: it records its argv and answers as the test tells it.
// What is proved here is Purix's own argv, its result mapping and its wording. Nothing here proves a real namespace was created.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runToolIsolated, toolReadOnlyBinds } from "./tool_run";
import { verifyComponent } from "../verify/verify";
import { safeRmSync } from "../platform/fs_retry.js";

const linuxOnly = { skip: process.platform !== "linux" ? "needs a Unix shell and `which`" : false };

let bin: string;
let project: string;
let argvLog: string;
let saved: Record<string, string | undefined>;
const KEYS = ["PATH", "PURIX_STRICT_ISOLATION"];

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  bin = mkdtempSync(join(tmpdir(), "purix-toolrun-bin-"));
  project = realpathSync(mkdtempSync(join(tmpdir(), "purix-toolrun-proj-")));
  argvLog = join(bin, "argv.json");
  writeFileSync(join(project, "package.json"), "{}");
  writeFileSync(join(project, "a.ts"), "export const a = 1;\n");
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  safeRmSync(bin);
  safeRmSync(project);
});

/** A fake bwrap: records argv, prints `stdout` / `stderr`, exits with `code`. */
function fakeBwrap(opts: { code?: number; stdout?: string; stderr?: string }): void {
  const file = join(bin, "bwrap");
  writeFileSync(
    file,
    `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)));\n` +
      `process.stdout.write(${JSON.stringify(opts.stdout ?? "")});process.stderr.write(${JSON.stringify(opts.stderr ?? "")});process.exit(${opts.code ?? 0});\n`
  );
  chmodSync(file, 0o755);
  process.env.PATH = `${bin}:${saved.PATH}`;
}
const argv = (): string[] => JSON.parse(readFileSync(argvLog, "utf8"));

function plantTsc(): void {
  mkdirSync(join(project, "node_modules", ".bin"), { recursive: true });
  const tsc = join(project, "node_modules", ".bin", "tsc");
  writeFileSync(tsc, "#!/usr/bin/env node\nprocess.exit(0);\n");
  chmodSync(tsc, 0o755);
}

describe("runToolIsolated", () => {
  it("runs the tool through bwrap: project read-only, network off, one scratch folder writable that is not the project", linuxOnly, () => {
    fakeBwrap({ stdout: "ok" });
    const r = runToolIsolated(["node", "tool.js"], project, { what: "The check" });
    expect(r.kind).toBe("ran");
    if (r.kind !== "ran") return;
    expect(r.isolation).toBe("network-namespace");
    const a = argv();
    expect(a).toContain("--unshare-net");
    const i = a.findIndex((x, k) => x === "--ro-bind" && a[k + 1] === project);
    expect(i).toBeGreaterThan(-1);
    const bound = a.findIndex((x) => x === "--bind");
    expect(a[bound + 1]).not.toBe(project);
    expect(a.slice(-2)).toEqual(["node", "tool.js"]);
  });

  it("a program that bwrap could not find is 'could not check', not a failure of the code", linuxOnly, () => {
    fakeBwrap({ code: 1, stderr: "bwrap: execvp node: No such file or directory\n" });
    const r = runToolIsolated(["node", "x"], project, { what: "The TypeScript check" });
    expect(r.kind).toBe("infrastructure");
    if (r.kind === "infrastructure") {
      expect(r.infrastructure).toBe("not_installed");
      expect(r.reason).toContain("not a failure of your code");
    }
  });

  it("a sandbox that cannot be created is infrastructure sandbox_unavailable", linuxOnly, () => {
    fakeBwrap({ code: 1, stderr: "bwrap: Creating new namespace failed: Operation not permitted\n" });
    const r = runToolIsolated(["node", "x"], project, { what: "The style check" });
    expect(r).toMatchObject({ kind: "infrastructure", infrastructure: "sandbox_unavailable" });
  });

  it("strict isolation with no sandbox tool does not run the tool", linuxOnly, () => {
    process.env.PATH = bin; // empty: no which, no bwrap
    process.env.PURIX_STRICT_ISOLATION = "1";
    const r = runToolIsolated([process.execPath, "-e", "0"], project, { what: "The style check" });
    expect(r).toMatchObject({ kind: "infrastructure", infrastructure: "sandbox_unavailable" });
    if (r.kind === "infrastructure") expect(r.reason).toMatch(/PURIX_STRICT_ISOLATION/);
  });
});

describe("toolReadOnlyBinds", () => {
  it("binds the real node_modules a verification copy links to, and a tool's own folder", linuxOnly, () => {
    const realModules = realpathSync(mkdtempSync(join(tmpdir(), "purix-realmods-")));
    try {
      symlinkSync(realModules, join(project, "node_modules"), "dir");
      expect(toolReadOnlyBinds(project, "/opt/tool-home")).toEqual([realModules, "/opt/tool-home"]);
    } finally {
      safeRmSync(realModules);
    }
  });
});

describe("verifyComponent through the sandbox", () => {
  it("a pass reports the isolation it really had", linuxOnly, () => {
    plantTsc();
    fakeBwrap({ code: 0 });
    const r = verifyComponent([join(project, "a.ts")], project);
    expect(r).toEqual({ status: "pass", isolation: "network-namespace" });
  });

  it("a type error is still a failure of the code, with the compiler's text", linuxOnly, () => {
    plantTsc();
    fakeBwrap({ code: 2, stdout: "a.ts(1,1): error TS2322: bad type" });
    const r = verifyComponent([join(project, "a.ts")], project);
    expect(r.status).toBe("fail");
    if (r.status === "fail") {
      expect(r.reason).toContain("TS2322");
      expect(r.infrastructure).toBeUndefined();
    }
  });

  it("a build-info write refused by the read-only project is infrastructure, not a code failure", linuxOnly, () => {
    plantTsc();
    fakeBwrap({ code: 2, stdout: "error TS5033: Could not write file 'tsconfig.tsbuildinfo': EROFS" });
    const r = verifyComponent([join(project, "a.ts")], project);
    expect(r.status).toBe("fail");
    if (r.status === "fail") {
      expect(r.infrastructure).toBe("sandbox_unavailable");
      expect(r.reason).toContain("not a failure of your code");
    }
  });
});
