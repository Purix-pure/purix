// packages/core/src/state/config_race_worker.ts
//
// Worker process for config_hot_reload.test.ts (Part 2). Writes to the
// SAME shared config.json as fast as it can, forever, until killed —
// deliberately no exit condition — so the test can send SIGKILL at an
// arbitrary moment mid-write and check that config.json is never observed
// in a truncated/partial state, only ever "old complete" or "new
// complete". A worker that exited on its own would give the test no
// control over WHEN the kill lands relative to a write.
import { createConfigStore } from "./config.js";

const baseDir = process.argv[2];
if (!baseDir) {
  console.error("usage: config_race_worker.ts <baseDir>");
  process.exit(1);
}

const store = createConfigStore(baseDir);
let i = 0;
// Real finding from testing this: the test process itself, if killed by
// an OUTER timeout/harness before its own afterEach/finally cleanup runs,
// never gets the chance to send this worker the SIGKILL that normally
// stops it — and this loop, as originally written with no exit condition
// at all, would then run forever as an orphan (confirmed: found three
// such orphans, each burning a full CPU core, after interrupted manual
// test runs during development of this fix). Since the whole point of
// this worker is "run indefinitely until an external kill lands," it
// can't have a normal exit condition — but it CAN have a hard safety cap
// so a lost kill signal costs a few seconds of CPU instead of running
// forever. Production code has no such loop; this is test-fixture-only.
const HARD_SAFETY_CAP_MS = 30_000;
const deadline = Date.now() + HARD_SAFETY_CAP_MS;
while (Date.now() < deadline) {
  // A bigger payload than a single key makes the write take measurably
  // longer than an instant syscall, which widens the window a kill signal
  // has to land mid-write — makes the atomicity test meaningful rather
  // than lucky.
  store.set("counter", i);
  store.set("payload", "x".repeat(2000));
  i++;
}
