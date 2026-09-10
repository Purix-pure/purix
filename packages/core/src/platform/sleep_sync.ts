// src/platform/sleep_sync.ts
//
// Runtime migration (ADR-009): `Bun.sleepSync(ms)` was a Bun global with
// no direct Node equivalent. Node has no built-in synchronous sleep —
// `setTimeout` is always async — but `Atomics.wait` blocking on a scratch
// SharedArrayBuffer is the standard, well-established technique for one:
// it blocks the calling thread for exactly `ms`, same as Bun's version.
//
// This is only correct off the main thread's event loop in the sense
// that it truly blocks — same tradeoff Bun.sleepSync had. Its one caller
// (llm/sqlite_retry.ts) wants exactly that: a real synchronous blocking
// wait between retries of a synchronous SQLite write, not a `setTimeout`
// that would require making the whole retry helper async.
const scratch = new Int32Array(new SharedArrayBuffer(4));

export function sleepSync(ms: number): void {
  Atomics.wait(scratch, 0, 0, ms);
}
