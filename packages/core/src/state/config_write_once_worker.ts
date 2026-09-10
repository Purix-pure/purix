// packages/core/src/state/config_write_once_worker.ts
//
// Writes a single key/value into the config store at the given baseDir,
// then exits. Standin for "another OS process/CLI invocation ran `purix
// config set ...`" in config_hot_reload.test.ts.
import { createConfigStore } from "./config.js";

const baseDir = process.argv[2];
const key = process.argv[3];
const rawValue = process.argv[4];
if (!baseDir || !key || rawValue === undefined) {
  console.error("usage: config_write_once_worker.ts <baseDir> <key> <value>");
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
