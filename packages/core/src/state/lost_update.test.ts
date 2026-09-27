// packages/core/src/state/lost_update.test.ts
//
// Regression test for GAPS-REPORT-2 §6 (see config.ts's set()/delete()
// comment): config.json is a single JSON file, so a naive
// read-modify-write set() is a classic lost-update race — two processes
// writing DIFFERENT keys at the same time can still clobber each other if
// the second process's write lands from a copy of the file read BEFORE the
// first process's write completed. config.ts guards set()/delete() with a
// cross-process lock specifically to prevent this; this test spawns two
// real OS processes, each hammering a different key, and checks that both
// keys' final values survive intact.
//
// PRE-EXISTING FILE NOTE: this file previously existed as an untracked,
// syntactically invalid scratch script (escaped `\`` instead of real
// template-literal backticks, a duplicate `join` import, and an in-test
// process.exit() call) that broke `tsc --noEmit`/`pnpm test` for the whole
// repo. It also wrote its worker's source as a string to a hand-built temp
// .js file and fork()'d that, instead of following this project's own
// convention (a real .ts worker file, spawned via the pinned tsx binary —
// see config_hot_reload.test.ts). Rewritten from scratch below to match
// that convention; the underlying test idea (two concurrent writers on
// different keys, checking for lost updates) is kept, since
// config_hot_reload.test.ts only covers a single writer's atomicity under
// SIGKILL, not this scenario.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createConfigStore } from "./config.js";
import { resolveTsxCommand } from "../test-support/real_node_modules.js";
import { safeRmSync } from "../platform/fs_retry.js";

const tsxCommand = resolveTsxCommand();
const workerPath = join(import.meta.dirname, "lost_update_worker.ts");

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-lost-update-"));
});

afterEach(() => {
  safeRmSync(dir);
});

function runWorker(baseDir: string, key: string, valuePrefix: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const commandParts = [...tsxCommand, workerPath, baseDir, key, valuePrefix];
    const [command, ...args] = commandParts;
    if (!command) throw new Error("empty spawn command");
    const child = spawn(command, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code: number | null) => (code === 0 ? resolvePromise() : reject(new Error(stderr))));
  });
}

describe("config set() — concurrent writers on different keys don't lose updates", () => {
  it("both keys' final values survive when two processes write concurrently", async () => {
    await Promise.all([runWorker(dir, "alpha", "valA"), runWorker(dir, "beta", "valB")]);

    const store = createConfigStore(dir);
    // Each worker calls set() 50 times in a loop, so the last write for
    // each key should be index 49 — a lost update would show up either as
    // the OTHER key's value (clobbered entirely) or an earlier index
    // (overwritten by a stale read racing back in).
    expect(store.get("alpha")).toBe("valA49");
    expect(store.get("beta")).toBe("valB49");
  });
});
