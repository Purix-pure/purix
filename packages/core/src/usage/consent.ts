// packages/core/src/usage/consent.ts
//
// Telemetry consent state (Purix 4, section 6). Default is OFF: the state
// starts "unset", which behaves as off. DO_NOT_TRACK=1 forces off. CI never
// uploads. The state lives in the user directory (~/.purix), not the
// project, and is keyed by a random install id, never by account or email.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { envSnapshot, purixEnv } from "../platform/env.js";
import { purixDir } from "../platform/layout.js";

export type ConsentState = "unset" | "on" | "off";

export interface TelemetryFile {
  schema: 1;
  state: ConsentState;
  /** Tier 2: redacted crash diagnostics. Separate switch, off by default. */
  crashDiagnostics: boolean;
  installId: string;
  decidedAt?: string;
}

export function userStateDir(): string {
  return purixEnv("PURIX_USER_DIR") ?? purixDir(homedir());
}

function statePath(dir: string): string {
  return join(dir, "telemetry.json");
}

function fresh(): TelemetryFile {
  return { schema: 1, state: "unset", crashDiagnostics: false, installId: randomUUID() };
}

export function readTelemetry(dir: string = userStateDir()): TelemetryFile {
  const read = readJsonFile<TelemetryFile>(statePath(dir));
  if (read.kind === "ok") {
    const v = read.value;
    const okState = v.state === "unset" || v.state === "on" || v.state === "off";
    if (v.schema === 1 && okState && typeof v.installId === "string" && v.installId.length > 0) {
      return { ...v, crashDiagnostics: v.crashDiagnostics === true };
    }
  }
  // Missing or unreadable: behave as off, with a new random install id.
  return fresh();
}

function save(dir: string, value: TelemetryFile): TelemetryFile {
  writeJsonAtomic(statePath(dir), value);
  return value;
}

export function hasStoredChoice(dir: string = userStateDir()): boolean {
  return existsSync(statePath(dir));
}

export function setConsent(state: "on" | "off", dir: string = userStateDir(), now: Date = new Date()): TelemetryFile {
  return save(dir, { ...readTelemetry(dir), state, decidedAt: now.toISOString() });
}

export function setCrashDiagnostics(on: boolean, dir: string = userStateDir()): TelemetryFile {
  return save(dir, { ...readTelemetry(dir), crashDiagnostics: on });
}

/** New random install id. The old one is forgotten locally. */
export function resetInstallId(dir: string = userStateDir()): TelemetryFile {
  return save(dir, { ...readTelemetry(dir), installId: randomUUID() });
}

export type ConsentEnv = Record<string, string | undefined>;

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

export interface EffectiveConsent {
  upload: boolean;
  reason: "enabled" | "not_enabled" | "do_not_track" | "ci";
}

/** Whether usage aggregates may ever be uploaded right now. Local recording is unaffected. */
export function effectiveConsent(state: ConsentState, env: ConsentEnv = envSnapshot()): EffectiveConsent {
  if (truthy(env.DO_NOT_TRACK)) return { upload: false, reason: "do_not_track" };
  if (truthy(env.CI)) return { upload: false, reason: "ci" };
  if (state !== "on") return { upload: false, reason: "not_enabled" };
  return { upload: true, reason: "enabled" };
}

/** A one-time consent prompt is allowed only in an interactive terminal, outside CI, with no DNT, and no stored choice. */
export function mayPrompt(opts: { isTTY: boolean; env?: ConsentEnv; stored: boolean }): boolean {
  const env = opts.env ?? envSnapshot();
  return opts.isTTY && !opts.stored && !truthy(env.DO_NOT_TRACK) && !truthy(env.CI);
}
