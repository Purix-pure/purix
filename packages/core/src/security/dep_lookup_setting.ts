// src/security/dep_lookup_setting.ts
//
// The stored answer to "may Purix look up the packages a change adds?" (decision 3 of the plan status, researched 2026-11-24).
//
// What the lookup sends (see dep_lookup.ts): package names and exact versions, to the package registry (registry.npmjs.org or pypi.org) and to
// api.osv.dev. No file content, no file paths, no project name. Those services can log the sender's IP address and the request; Purix does not
// claim they do not.
//
// Why a one-time, remembered question and not a default: a silent default of "on" would break the README promise that nothing leaves this
// machine without being asked, and a plain "off" would leave the check that catches invented package names unused. So: off until the person
// says yes, asked once in a terminal (at the end of `purix connect`), remembered here in the user folder, changeable at any time with
// `purix lookup on|off`. It never asks in CI or without a terminal, and the setting is ignored in CI (CI must name the variable on purpose).
// PURIX_DEP_LOOKUP, when set, always wins over the stored answer, including a value that turns it off.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readJsonFile, writeJsonAtomic } from "../platform/atomic_write.js";
import { envSnapshot, purixEnv } from "../platform/env.js";
import { userDir } from "../platform/user_dir.js";

export type LookupChoice = "unset" | "on" | "off";

export interface LookupSettingFile {
  schema: 1;
  state: LookupChoice;
  decidedAt?: string;
}

/** Said to the person when they are asked, and by `purix lookup status`. One text, so the question and the documentation cannot drift apart. */
export const LOOKUP_DISCLOSURE =
  "Purix can check the packages a change adds. It sends package names (and exact versions, for the vulnerability check) to registry.npmjs.org or pypi.org and to api.osv.dev. " +
  "Your code, file paths and project name are not sent. Those services may log your IP address and the request. " +
  "It is off until you turn it on, and you can change it any time with `purix lookup on` or `purix lookup off`.";

function filePath(dir: string): string {
  return join(dir, "dep_lookup.json");
}

export function readLookupSetting(dir: string = userDir()): LookupSettingFile {
  const read = readJsonFile<LookupSettingFile>(filePath(dir));
  if (read.kind === "ok" && read.value.schema === 1 && (read.value.state === "on" || read.value.state === "off" || read.value.state === "unset")) {
    return { schema: 1, state: read.value.state, ...(typeof read.value.decidedAt === "string" ? { decidedAt: read.value.decidedAt } : {}) };
  }
  return { schema: 1, state: "unset" };
}

export function hasLookupChoice(dir: string = userDir()): boolean {
  return existsSync(filePath(dir)) && readLookupSetting(dir).state !== "unset";
}

export function setLookupSetting(state: "on" | "off", dir: string = userDir(), now: Date = new Date()): LookupSettingFile {
  const value: LookupSettingFile = { schema: 1, state, decidedAt: now.toISOString() };
  writeJsonAtomic(filePath(dir), value);
  return value;
}

function truthy(v: string | undefined): boolean {
  return v !== undefined && v !== "" && v !== "0" && v.toLowerCase() !== "false";
}

/** A question may be asked only in a terminal, outside CI, when nothing has been decided and the variable is not already deciding. */
export function mayAskLookup(opts: { isTTY: boolean; stored: boolean; env?: NodeJS.ProcessEnv }): boolean {
  const env = opts.env ?? envSnapshot();
  const variableSet = (purixEnv("PURIX_DEP_LOOKUP") ?? "").trim() !== "";
  return opts.isTTY && !opts.stored && !truthy(env["CI"]) && !variableSet;
}

export type LookupSource = "variable" | "setting" | "default";

/** Whether the stored answer applies now. It does not in CI: there the variable has to be named on purpose. */
export function storedLookupApplies(env: NodeJS.ProcessEnv = envSnapshot(), dir: string = userDir()): boolean {
  return !truthy(env["CI"]) && readLookupSetting(dir).state === "on";
}
