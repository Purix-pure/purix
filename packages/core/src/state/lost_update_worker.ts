// packages/core/src/state/lost_update_worker.ts
//
// Worker process for lost_update.test.ts. Writes to ONE key in the shared
// config store, repeatedly, then exits normally. Standin for two separate
// `purix config set` invocations (or two components' state writers)
// touching DIFFERENT keys in the same config.json at the same time — the
// test spawns two of these, on different keys, and checks that both keys'
// final values survive, proving concurrent-but-non-conflicting writers
// don't clobber each other's key via a stale whole-file read-modify-write.
import { writeSync } from "node:fs";
import { createConfigStore } from "./config.js";

const baseDir = process.argv[2];
const key = process.argv[3];
const valuePrefix = process.argv[4];
if (!baseDir || !key || valuePrefix === undefined) {
  writeSync(2, "usage: lost_update_worker.ts <baseDir> <key> <valuePrefix>\n");
  process.exit(1);
}

const store = createConfigStore(baseDir);
for (let i = 0; i < 50; i++) {
  store.set(key, `${valuePrefix}${i}`);
}
