// packages/core/src/state/config.ts
//
// Part 2: a generic project-local key-value config store. Nothing like
// this exists elsewhere in the repo — tier-config.json, secrets.enc.json,
// and authorized_operators.json are each single-purpose files with their
// own bespoke read/write code. This backs `purix config set/get/delete`,
// the milestone-upsell rate-limit timestamp, and the milestone threshold
// override — none of it sensitive, so plain JSON, no encryption.
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";

export type ConfigValue = string | number | boolean;
type ConfigData = Record<string, ConfigValue>;

const WINDOWS_RENAME_RETRIES = 8;
const WINDOWS_RENAME_RETRY_DELAY_MS = 25;

function waitSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameConfigFile(tmpPath: string, finalPath: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(tmpPath, finalPath);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      const retryable = process.platform === "win32" && (code === "EPERM" || code === "EACCES");
      if (!retryable || attempt >= WINDOWS_RENAME_RETRIES) throw err;
      waitSync(WINDOWS_RENAME_RETRY_DELAY_MS);
    }
  }
}

function configPath(baseDir: string): string {
  return join(baseDir, ".purix", "config.json");
}

function readAll(baseDir: string): ConfigData {
  try {
    const p = configPath(baseDir);
    if (!existsSync(p)) return {};
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    // A corrupted or hand-edited config.json degrades to "no overrides
    // set" rather than crashing every command that happens to touch it —
    // nothing stored here is load-bearing for correctness, only for
    // convenience (quiet-mode persistence, throttling, threshold tuning).
    return {};
  }
}

// Hot-reload note (Part 2): readAll() above already re-reads from disk on
// every call — there is no in-memory cache to invalidate — so a config
// change made by one process becomes visible to any other process's next
// get()/all() with no restart needed. The one thing that WAS unsafe for
// that scenario was this function: a plain writeFileSync() truncates the
// destination file before writing the new bytes, so a reader (or a crash
// mid-write, e.g. disk full or the process being killed) could observe a
// truncated/empty/half-written config.json — readAll()'s JSON.parse would
// then throw and silently degrade to "no overrides set" (see readAll's own
// comment), which is a real data-loss/flicker risk for a file two
// processes read and write concurrently. Fixed with the standard
// write-temp-then-rename pattern: write the full new content to a sibling
// temp file, then rename() it over the real path. POSIX and Windows both
// guarantee rename() is atomic with respect to concurrent readers/writers
// on the same filesystem — a reader either sees the old complete file or
// the new complete file, never a partial one.
function writeAll(baseDir: string, data: ConfigData): void {
  const dir = dirname(configPath(baseDir));
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const finalPath = configPath(baseDir);
  const tmpPath = join(dir, `.config.json.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  writeFileSync(tmpPath, JSON.stringify(data, null, 2));
  try {
    renameConfigFile(tmpPath, finalPath);
  } catch (err) {
    try {
      unlinkSync(tmpPath);
    } catch {}
    throw err;
  }
}

export interface ConfigStore {
  get(key: string): ConfigValue | undefined;
  set(key: string, value: ConfigValue): void;
  delete(key: string): void;
  all(): ConfigData;
}

/**
 * Bound to a specific project directory (normally process.cwd()) — pass an
 * explicit baseDir in tests so they don't read/write the real repo's
 * .purix/config.json.
 */
export function createConfigStore(baseDir: string): ConfigStore {
  return {
    get(key) {
      return readAll(baseDir)[key];
    },
    set(key, value) {
      const data = readAll(baseDir);
      data[key] = value;
      writeAll(baseDir, data);
    },
    delete(key) {
      const data = readAll(baseDir);
      delete data[key];
      writeAll(baseDir, data);
    },
    all() {
      return readAll(baseDir);
    },
  };
}

/** Default instance, bound to the current project (process.cwd()). */
export const config: ConfigStore = createConfigStore(process.cwd());
