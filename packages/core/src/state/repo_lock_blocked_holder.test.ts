// A2b-1 (research 11): the repository lock must survive a holder whose main thread is blocked.
//
// Verification runs through spawnSync, which blocks the main thread for as long as the child runs. The lock's heartbeat was
// a timer on that thread, so a verification longer than the staleness window (30 s) stopped the heartbeat, a second
// process judged the lock abandoned, took it, and ran reconcile over the first process's live operation. Timings are
// shortened here (stale 1.5 s, beat every 0.3 s) so the test takes seconds; the mechanism is the same.
import { describe, it, afterEach } from "node:test";
import { expect } from "expect";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { acquireRepoLock, releaseRepoLock, setLockTimingForTests } from "./repo_lock";
import { safeRmSync } from "../platform/fs_retry.js";

const LOCK_MODULE = pathToFileURL(join(import.meta.dirname, "repo_lock.ts")).href;
const STALE_MS = 1500;
const BEAT_MS = 300;

// The holder is started with -e and --input-type=module on purpose: a heartbeat worker that inherits that flag is parsed as an
// ES module, and one written with require() then dies at start-up without a word. This holder takes the lock with shortened
// timings, then blocks its main thread (as a synchronous verification does) so no timer on that thread can run.
const holderSource = (dir: string, blockMs: number): string => `
import { acquireRepoLock, setLockTimingForTests } from ${JSON.stringify(LOCK_MODULE)};
setLockTimingForTests({ staleMs: ${STALE_MS}, heartbeatMs: ${BEAT_MS} });
acquireRepoLock(${JSON.stringify(dir)});
console.log("ready");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
`;

function startHolder(dir: string, blockMs: number): Promise<ChildProcess> {
  return new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", holderSource(dir, blockMs)], { stdio: ["ignore", "pipe", "inherit"] });
    c.once("error", reject);
    c.stdout.on("data", (d: Buffer) => String(d).includes("ready") && resolve(c));
    c.once("close", () => reject(new Error("the holder exited before it took the lock")));
  });
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("repository lock with a blocked holder", { timeout: 60_000 }, () => {
  const dirs: string[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const c of children.splice(0)) c.kill("SIGKILL");
    releaseRepoLock(dirs[0] ?? process.cwd());
    setLockTimingForTests({ staleMs: 30_000, heartbeatMs: 10_000 });
    for (const d of dirs.splice(0)) safeRmSync(d);
  });

  it("a second process cannot take the lock while its holder is alive, even with the holder's main thread blocked for longer than the staleness window", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-lock-blocked-"));
    dirs.push(dir);
    const holder = await startHolder(dir, 5000);
    children.push(holder);
    await sleep(STALE_MS * 2 + 200); // well past the window: three times the beat interval has also passed many times over
    setLockTimingForTests({ staleMs: STALE_MS });
    expect(() => acquireRepoLock(dir)).toThrow(/already locked by active process PID/);
  });

  it("a holder that dies is still reclaimed: the heartbeat does not outlive its process", async () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-lock-dead-"));
    dirs.push(dir);
    const holder = await startHolder(dir, 20_000);
    children.push(holder);
    holder.kill("SIGKILL");
    await new Promise((r) => holder.once("close", r));
    await sleep(STALE_MS + 300);
    setLockTimingForTests({ staleMs: STALE_MS });
    expect(() => acquireRepoLock(dir)).not.toThrow();
    releaseRepoLock(dir);
    expect(existsSync(join(dir, ".purix", "repo.lock"))).toBe(false);
  });
});
