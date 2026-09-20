// packages/core/src/state/config_write_once_worker.ts
//
// Writes a single key/value into the config store at the given baseDir,
// then exits. Standin for "another OS process/CLI invocation ran `purix
// config set ...`" in config_hot_reload.test.ts.
import { writeSync } from "node:fs";
import { createConfigStore } from "./config.js";

const baseDir = process.argv[2];
const key = process.argv[3];
const rawValue = process.argv[4];
if (!baseDir || !key || rawValue === undefined) {
  // LIFECYCLE FIX (parity with budget_race_worker.ts): synchronous write
  // ahead of process.exit() — see that file's comment for why.
  writeSync(2, "usage: config_write_once_worker.ts <baseDir> <key> <value>\n");
  process.exit(1);
}

// Mirrors how a real `purix config set` CLI command would parse a raw
// string argument into the actual typed value ConfigStore expects —
// callers of this worker pass CLI-flag-shaped strings ("false", "15"),
// not JS literals, so this parsing isn't optional scaffolding.
function parseValue(raw: string): string | number | boolean {
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (raw !== "" && !Number.isNaN(Number(raw))) return Number(raw);
  return raw;
}

createConfigStore(baseDir).set(key, parseValue(rawValue));
