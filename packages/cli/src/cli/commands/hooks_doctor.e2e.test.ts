// src/cli/commands/hooks_doctor.e2e.test.ts
//
// `purix hooks doctor` as a child process, with a real `purix` shim on PATH so the installed command string runs through the real
// /bin/sh and the real engine. Linux/macOS only. This is NOT a live agent and the doctor says so.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsx = pathToFileURL(require.resolve("tsx")).href;
const CLI = join(import.meta.dirname, "..", "..", "cli.ts");
const posix = process.platform !== "win32";

describe("purix hooks doctor (child process)", { skip: !posix }, () => {
  let root: string;
  let home: string;
  let bin: string;
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-doc-e2e-")));
    home = realpathSync(mkdtempSync(join(tmpdir(), "purix-doc-home-")));
    bin = realpathSync(mkdtempSync(join(tmpdir(), "purix-doc-bin-")));
    mkdirSync(join(root, ".git"));
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(bin, "purix"), `#!/bin/sh\nexec "${process.execPath}" --import "${tsx}" "${CLI}" "$@"\n`);
    chmodSync(join(bin, "purix"), 0o755);
  });
  afterEach(() => {
    for (const d of [root, home, bin]) safeRmSync(d);
  });
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", tsx, CLI, ...args], { cwd: root, encoding: "utf-8", timeout: 120_000, env: { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${delimiter}${process.env["PATH"]}`, CLAUDE_PROJECT_DIR: "" } });

  test("install, then doctor: the real installed command blocks the canary and blocks when purix is missing; the live step is not claimed", () => {
    expect(run(["hooks", "install", "claude-code"]).status).toBe(0);
    const r = run(["hooks", "doctor", "claude-code"]);
    expect(r.stdout).toContain("canary-block: the installed command blocked a simulated write");
    expect(r.stdout).toContain("canary-fail-closed: with purix removed from PATH");
    expect(r.stdout).toContain("live-agent: needs a live Claude Code");
    expect(r.stdout).toMatch(/simulated payload/);
    expect(r.status).toBe(0);
  });

  test("doctor with nothing installed exits 1 and says how to install", () => {
    const r = run(["hooks", "doctor"]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain("purix hooks install");
  });
});
