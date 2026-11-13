// packages/core/src/usage/ledger.ts
//
// The local usage ledger: always on, local only, closed schema (schema.ts).
// `purix stats` and `purix telemetry show` read it. It is NOT the audit
// chain: the chain is evidence, this is product data. Writing never throws.
import { appendFileSync, mkdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../platform/atomic_write.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { PURIX_VERSION } from "../version.js";
import { readTelemetry, userStateDir } from "./consent.js";
import { validateUsageEvent, type UsageEvent, type UsageEventName } from "./schema.js";

const FILE = "usage-ledger.jsonl";
const COMPACT_ABOVE_BYTES = 512 * 1024;
const MAX_DAYS = 90;

function ledgerPath(dir: string): string {
  return join(dir, FILE);
}

export function utcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/**
 * C-22: read-only and setup commands must leave the user's HOME untouched. A `command_run` row for
 * one of these would create `~/.purix/usage-ledger.jsonl` as a side effect of looking at something
 * (or of wiring an agent). The command path in the dimension uses "_" for spaces ("tools_list").
 * Exact names plus two prefixes: every `config ...` and `connect ...` form.
 */
const SKIP_COMMANDS = new Set(["status", "check", "stats", "tools_list", "help", "version"]);
const SKIP_COMMAND_PREFIXES = ["config", "connect"];

export function isSkippedCommandRun(ev: { event: string; dimension: string }): boolean {
  if (ev.event !== "command_run") return false;
  const command = ev.dimension.split(":")[0] ?? "";
  return SKIP_COMMANDS.has(command) || SKIP_COMMAND_PREFIXES.some((p) => command === p || command.startsWith(p + "_"));
}

export function recordUsage(
  ev: { event: UsageEventName; dimension: string; count?: number },
  opts: { dir?: string; now?: Date } = {},
): boolean {
  try {
    if (isSkippedCommandRun(ev)) return false; // nothing is written, and no directory is created
    const dir = opts.dir ?? userStateDir();
    const checked = validateUsageEvent({ day: utcDay(opts.now), event: ev.event, dimension: ev.dimension, count: ev.count ?? 1 });
    if (!checked.ok) return false;
    mkdirSync(dir, { recursive: true });
    appendFileSync(ledgerPath(dir), JSON.stringify(checked.event) + "\n", "utf-8");
    const size = statSync(ledgerPath(dir)).size;
    if (size > COMPACT_ABOVE_BYTES) compactLedger(dir, opts.now);
    return true;
  } catch {
    return false; // product data must never break a command
  }
}

export function readLedger(dir: string = userStateDir()): UsageEvent[] {
  const p = ledgerPath(dir);
  if (!existsSync(p)) return [];
  const out: UsageEvent[] = [];
  for (const line of readFileSync(p, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const v = validateUsageEvent(JSON.parse(line));
      if (v.ok) out.push(v.event);
    } catch {
      // skip a damaged line
    }
  }
  return out;
}

export function aggregate(events: UsageEvent[]): UsageEvent[] {
  const map = new Map<string, UsageEvent>();
  for (const e of events) {
    const key = `${e.day}|${e.event}|${e.dimension}`;
    const prior = map.get(key);
    if (prior) prior.count = Math.min(100_000, prior.count + e.count);
    else map.set(key, { ...e });
  }
  return [...map.values()].sort((a, b) => (a.day + a.event + a.dimension).localeCompare(b.day + b.event + b.dimension));
}

export function compactLedger(dir: string = userStateDir(), now: Date = new Date()): void {
  const cutoff = utcDay(new Date(now.getTime() - MAX_DAYS * 86_400_000));
  const rows = aggregate(readLedger(dir)).filter((r) => r.day >= cutoff);
  writeFileAtomic(ledgerPath(dir), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : ""));
}

export function osName(platform: string = process.platform): "linux" | "macos" | "windows" | "other" {
  if (platform === "linux") return "linux";
  if (platform === "darwin") return "macos";
  if (platform === "win32") return "windows";
  return "other";
}

export interface UploadPayload {
  installId: string;
  clientVersion: string;
  os: "linux" | "macos" | "windows" | "other";
  rows: UsageEvent[];
}

/** The exact payload a future upload would send. Keyed by install id only: no email, account, project or path. */
export function buildNextPayload(dir: string = userStateDir()): UploadPayload {
  return {
    installId: readTelemetry(dir).installId,
    clientVersion: PURIX_VERSION,
    os: osName(),
    rows: aggregate(readLedger(dir)),
  };
}

export function eraseLedger(dir: string = userStateDir()): void {
  safeRmSync(ledgerPath(dir));
}
