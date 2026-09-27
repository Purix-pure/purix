// src/sandbox/sandbox_exec_platform.test.ts
//
// runIsolated()'s two "real isolation" branches — the Linux bwrap path
// and the macOS sandbox-exec path — are gated on `process.platform` AND
// `hasBinary(...)`, which shells out to the real `which`. Neither branch
// is exercised by sandbox_exec.test.ts (this CI environment has no
// bwrap/sandbox-exec installed — confirmed by sandbox.ts's own log line,
// "no bwrap (Linux) or sandbox-exec (macOS) found — running tests
// unisolated"). We can't grant real user-namespace privileges here, but
// don't need to: hasBinary() only checks that a binary NAMED bwrap /
// sandbox-exec is resolvable on PATH, and all the surrounding
// argv/profile-construction code (what this file actually tests) runs
// regardless of whether that binary can truly create a namespace. A fake
// executable on a prepended PATH entry — the same technique
// idiom_check.test.ts already uses for a fake eslint — drives both
// branches for real, including the exact bwrap argv / sandbox-exec
// profile text sandbox_exec.ts constructs (verified against the current
// source: --ro-bind ordering, the post-tmpfs bind ordering, --unshare-net
// / --unshare-pid / --die-with-parent, and the macOS profile's
// deny-default / deny-network / write-scoped-to-writableDir shape).
//
// spawn_sync.ts's spawnSync(["bwrap", ...args], opts) invokes
// crossSpawn.sync("bwrap", args, ...) — so a fake `bwrap` script sees
// everything after the binary name as its own process.argv.slice(2).
//
// The bwrap describe block only runs on Linux and the sandbox-exec block
// only on macOS: each branch is unreachable on the other platform by a
// process.platform gate in sandbox_exec.ts itself, so there is nothing to
// exercise there rather than something to skip past. Can't run on
// Windows at all: this relies on `which` and Unix shebang executables,
// same constraint idiom_check.test.ts documents.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIsolated } from "./sandbox_exec";
import { safeRmSync } from "../platform/fs_retry.js";

const linuxOnly = {
  skip: process.platform !== "linux" ? `bwrap branch only runs on linux (platform: ${process.platform})` : false,
};
const macOnly = {
  skip: process.platform !== "darwin" ? `sandbox-exec branch only runs on darwin (platform: ${process.platform})` : false,
};

let fakeBinDir: string;
let cwd: string;
let originalPath: string | undefined;

beforeEach(() => {
  fakeBinDir = mkdtempSync(join(tmpdir(), "purix-fakebin-"));
  cwd = mkdtempSync(join(tmpdir(), "purix-sbxexec-cwd-"));
  originalPath = process.env.PATH;
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.PATH;
  else process.env.PATH = originalPath;
  safeRmSync(fakeBinDir);
  safeRmSync(cwd);
});

// Writes a fake executable that echoes its own argv (one per line) to
// stdout and exits 0 — enough to prove real argv/profile construction
// without needing an actual sandbox runtime.
function fakeBinary(name: string, body: string) {
  mkdirSync(fakeBinDir, { recursive: true });
  const bin = join(fakeBinDir, name);
  writeFileSync(bin, body);
  chmodSync(bin, 0o755);
}

function prependFakeBinToPath() {
  process.env.PATH = `${fakeBinDir}:${originalPath ?? ""}`;
}

describe("runIsolated — Linux bwrap path", () => {
  it("builds and runs a real bwrap invocation when bwrap is on PATH (hasBinary + isolation build)", linuxOnly, () => {
    fakeBinary("bwrap", `#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join("\\n"));\nprocess.exit(0);\n`);
    prependFakeBinToPath();

    const res = runIsolated(["echo", "hi"], { cwd, writableDir: cwd });

    expect(res.isolation).toBe("network-namespace");
    expect(res.exitCode).toBe(0);
    // Confirms the real bwrap argv this file builds: unshare flags, the
    // write bind, and the wrapped command all made it onto argv, not
    // just that SOMETHING ran.
    expect(res.stdout).toContain("--unshare-net");
    expect(res.stdout).toContain("--unshare-pid");
    expect(res.stdout).toContain("--die-with-parent");
    expect(res.stdout).toContain("--bind");
    expect(res.stdout).toContain(cwd);
    expect(res.stdout).toContain("echo");
  });

  it("creates any missing extraReadOnlyBinds directories before invoking bwrap", linuxOnly, () => {
    fakeBinary("bwrap", `#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join("\\n"));\nprocess.exit(0);\n`);
    prependFakeBinToPath();

    const missingBind = join(cwd, "toolchain-cache-not-yet-created");
    const res = runIsolated(["echo", "hi"], {
      cwd,
      writableDir: cwd,
      extraReadOnlyBinds: [missingBind],
    });

    expect(res.stdout).toContain("--ro-bind");
    expect(res.stdout).toContain(missingBind);
    // The directory must actually now exist on disk, not just appear in argv.
    expect(existsSync(missingBind)).toBe(true);
  });

  it("does not touch an extraReadOnlyBinds directory that already exists", linuxOnly, () => {
    fakeBinary("bwrap", `#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join("\\n"));\nprocess.exit(0);\n`);
    prependFakeBinToPath();

    const existingBind = join(cwd, "already-there");
    mkdirSync(existingBind, { recursive: true });
    writeFileSync(join(existingBind, "marker.txt"), "keep-me");

    runIsolated(["echo", "hi"], { cwd, writableDir: cwd, extraReadOnlyBinds: [existingBind] });

    expect(existsSync(join(existingBind, "marker.txt"))).toBe(true);
  });

  it("throws SandboxUnavailableError when bwrap is present but fails to set up its namespace (Docker case)", linuxOnly, () => {
    fakeBinary(
      "bwrap",
      `#!/usr/bin/env node\nprocess.stderr.write("bwrap: Creating new namespace failed: Operation not permitted\\n");\nprocess.exit(1);\n`
    );
    prependFakeBinToPath();

    expect(() => runIsolated(["echo", "hi"], { cwd, writableDir: cwd })).toThrow(
      /bwrap is installed but failed to create an isolated sandbox/
    );
  });

  it("reports the wrapped command's own non-zero exit as a normal result, not a setup failure, when it produced output", linuxOnly, () => {
    fakeBinary(
      "bwrap",
      `#!/usr/bin/env node\nprocess.stdout.write("some real output\\n");\nprocess.stderr.write("app-level error, nothing to do with bwrap\\n");\nprocess.exit(2);\n`
    );
    prependFakeBinToPath();

    const res = runIsolated(["some-command"], { cwd, writableDir: cwd });
    expect(res.isolation).toBe("network-namespace");
    expect(res.exitCode).toBe(2);
    expect(res.stdout).toContain("some real output");
  });

  it("passes opts.env through to the bwrap-wrapped command on top of the sanitized sandbox environment", linuxOnly, () => {
    fakeBinary(
      "bwrap",
      `#!/usr/bin/env node\nprocess.stdout.write(process.env.PURIX_TEST_MARKER || "MISSING");\nprocess.exit(0);\n`
    );
    prependFakeBinToPath();

    const res = runIsolated(["echo"], { cwd, writableDir: cwd, env: { PURIX_TEST_MARKER: "custom-value" } });
    expect(res.stdout).toContain("custom-value");
  });

  it("includes /lib64 in the read-only binds only when it exists on this host", linuxOnly, () => {
    fakeBinary("bwrap", `#!/usr/bin/env node\nconsole.log(process.argv.slice(2).join("\\n"));\nprocess.exit(0);\n`);
    prependFakeBinToPath();

    const res = runIsolated(["echo", "hi"], { cwd, writableDir: cwd });
    if (existsSync("/lib64")) {
      expect(res.stdout).toContain("/lib64");
    } else {
      expect(res.stdout).not.toContain("/lib64");
    }
  });
});

describe("runIsolated — macOS sandbox-exec path", () => {
  it("builds and runs a real sandbox-exec invocation with a restrictive profile when sandbox-exec is on PATH", macOnly, () => {
    fakeBinary(
      "sandbox-exec",
      `#!/usr/bin/env node\n// argv: -p <profile> <command...>\nconsole.log(process.argv[3]);\nconsole.log(process.argv.slice(4).join(" "));\nprocess.exit(0);\n`
    );
    prependFakeBinToPath();

    const res = runIsolated(["echo", "hi"], { cwd, writableDir: cwd });

    expect(res.isolation).toBe("os-sandbox");
    expect(res.exitCode).toBe(0);
    // Asserts the real generated profile text — deny-by-default,
    // deny-network, and writes scoped to exactly writableDir — not a stub.
    expect(res.stdout).toContain("(deny default)");
    expect(res.stdout).toContain("(deny network*)");
    expect(res.stdout).toContain(`(allow file-write* (subpath "${cwd}"))`);
    expect(res.stdout).toContain("echo hi");
  });

  it("includes npm/pnpm cache subpaths in the read allowlist when HOME is set", macOnly, () => {
    fakeBinary("sandbox-exec", `#!/usr/bin/env node\nconsole.log(process.argv[3]);\nprocess.exit(0);\n`);
    prependFakeBinToPath();
    const savedHome = process.env.HOME;
    process.env.HOME = "/Users/purix-test";

    try {
      const res = runIsolated(["echo", "hi"], { cwd, writableDir: cwd });
      expect(res.stdout).toContain("/Users/purix-test/.npm");
      expect(res.stdout).toContain("/Users/purix-test/Library/pnpm");
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });

  it("omits the home-directory cache subpaths entirely when HOME is unset", macOnly, () => {
    fakeBinary("sandbox-exec", `#!/usr/bin/env node\nconsole.log(process.argv[3]);\nprocess.exit(0);\n`);
    prependFakeBinToPath();
    const savedHome = process.env.HOME;
    delete process.env.HOME;

    try {
      const res = runIsolated(["echo", "hi"], { cwd, writableDir: cwd });
      expect(res.stdout).not.toContain(".npm");
      expect(res.stdout).not.toContain("Library/pnpm");
    } finally {
      if (savedHome !== undefined) process.env.HOME = savedHome;
    }
  });
});

describe("runIsolated — no sandbox tool available", () => {
  it("falls back to unisolated execution and says so honestly when neither bwrap nor sandbox-exec is found", () => {
    // hasBinary("bwrap") / hasBinary("sandbox-exec") must resolve to
    // false via `which` — but the wrapped command itself (a real `node`
    // invocation here) still needs to actually resolve and run, so keep
    // the real PATH and only guarantee neither sandbox tool is reachable
    // by NOT prepending fakeBinDir. This CI environment already has
    // neither bwrap nor sandbox-exec installed (confirmed by the
    // project's own coverage log), so the real, unmodified PATH already
    // exercises this branch.
    const res = runIsolated(["node", "-e", "console.log('unisolated')"], { cwd, writableDir: cwd });
    expect(res.isolation).toBe("none");
    expect(res.stdout).toContain("unisolated");
  });
});
