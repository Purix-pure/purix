// packages/core/src/tools/broker.ts
//
// ADR-060: the one door. Every command, and any agent adapter, asks THIS module for tools.
// It prints nothing. CLI and MCP render its results.
//
// What an adapter may call:
//   read-only, anyone (agents included): listCatalog, planNeeds, planForLanguages, toolStatus, getToolBinary
//   asks for an install (writes a pending file only): requestInstall
//   changes the machine, human gate required: installTool, approveRequest, removeTool
// The MCP adapter must import only the first two groups; a test in mcp-server enforces that.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { chainAuditSink, type AuditSink } from "./audit.js";
import { filterCatalog, findEntry, hashLockFiles, shippedCatalog, type ListFilter } from "./catalog.js";
import { createPending, deletePending, describeInstall, readPending, type ConsentGate } from "./consent.js";
import { defaultRunner, installEntry, preflight, type Runner } from "./installer.js";
import { detectProjectSignals, guessLanguages } from "./project_signals.js";
import { matchPurpose } from "./purpose.js";
import { planNeeds as resolvePlan } from "./resolver.js";
import { acquireInstallLock, hasLegacyProjectTools, legacyProjectToolsDir, readLock, removeRecord, toolDir, toolsDir, writeRecord } from "./state.js";
import type { CatalogEntry, Capability, LockRecord, PendingRequest, Platform, PlanResult, RefusalReason, ToolNeed } from "./types.js";

export interface BrokerDeps {
  baseDir: string;
  catalog?: readonly CatalogEntry[];
  platform?: Platform;
  now?: () => Date;
  runner?: Runner;
  audit?: AuditSink;
  consent?: ConsentGate;
  /** Default 7 (ADR-060 D4). */
  minReleaseAgeDays?: number;
  /** Hard stop for each install command. Default INSTALL_DEADLINE_MS (installer.ts). Mostly a test seam. */
  installDeadlineMs?: number;
}

export const DEFAULT_MIN_RELEASE_AGE_DAYS = 7;

function resolved(deps: BrokerDeps) {
  return {
    baseDir: deps.baseDir,
    catalog: deps.catalog ?? shippedCatalog(),
    platform: deps.platform ?? (process.platform as Platform),
    now: (deps.now ?? (() => new Date()))(),
    runner: deps.runner ?? defaultRunner,
    audit: deps.audit ?? chainAuditSink,
    consent: deps.consent,
    minReleaseAgeDays: deps.minReleaseAgeDays ?? DEFAULT_MIN_RELEASE_AGE_DAYS,
    installDeadlineMs: deps.installDeadlineMs,
  };
}

export type BrokerFailure = { ok: false; reason: RefusalReason; message: string; hint?: string };
export type BrokerInstallResult = { ok: true; record: LockRecord; alreadyInstalled: boolean; warning?: string } | BrokerFailure;

function failure(reason: RefusalReason, message: string, hint?: string): BrokerFailure {
  return { ok: false, reason, message, ...(hint ? { hint } : {}) };
}

// ------------------------------------------------------------ read-only

export function listCatalog(deps: BrokerDeps, filter: ListFilter = {}): CatalogEntry[] {
  return filterCatalog(resolved(deps).catalog, filter);
}

function installedIdSet(baseDir: string): { ids: Set<string>; corrupt?: string } {
  const lock = readLock(baseDir);
  if (lock.kind === "corrupt") return { ids: new Set(), corrupt: lock.error };
  return { ids: new Set(lock.lock.records.map((r) => r.id)) };
}

/** Read-only: creates nothing, writes nothing, spawns nothing. */
export function planNeeds(deps: BrokerDeps, needs: readonly ToolNeed[]): PlanResult & { warning?: string } {
  const d = resolved(deps);
  const installed = installedIdSet(d.baseDir);
  const signals = detectProjectSignals(d.baseDir, d.catalog);
  const plan = resolvePlan(needs, signals, installed.ids, d.catalog);
  return installed.corrupt ? { ...plan, warning: `The install records in ${toolsDir(d.baseDir)} are unreadable (${installed.corrupt}); showing the plan as if nothing were installed.` } : plan;
}

const STANDARD_CAPABILITIES: Capability[] = ["type-check", "run-tests", "lint", "dep-audit"];

/** Languages the folder looks like it uses; empty when no marker file exists. Read-only. */
export function detectLanguages(deps: BrokerDeps): string[] {
  return guessLanguages(deps.baseDir);
}

export function planForLanguages(deps: BrokerDeps, languages: readonly string[]): PlanResult & { warning?: string } {
  const needs: ToolNeed[] = [];
  for (const language of languages) for (const capability of STANDARD_CAPABILITIES) needs.push({ capability, language });
  return planNeeds(deps, needs);
}

export type InstalledState = "ok" | "missing-binary" | "bin-path-unsafe" | "catalog-changed" | "lock-file-modified" | "unknown-tool";

export interface InstalledStatus {
  record: LockRecord;
  state: InstalledState;
  detail?: string;
}

/**
 * True when `binRelPath` names a file inside `dir` and nothing else. A record is data; a path in it must not be able to point
 * anywhere else on the machine (`../x`, an absolute path, a Windows drive path), even if a file exists there.
 */
export function binPathInside(dir: string, binRelPath: string): boolean {
  if (binRelPath === "" || binRelPath.includes("\0")) return false;
  const parts = binRelPath.split(/[\\/]/);
  if (parts.some((p) => p === ".." || p === "")) return false;
  if (isAbsolute(binRelPath) || /^[a-zA-Z]:/.test(binRelPath)) return false;
  const rel = relative(resolve(dir), resolve(dir, ...parts));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** What `toolStatus` adds when a pre-T1 tools folder is found inside the project: it is never read. */
const IGNORED_IN_PROJECT_NOTE = (baseDir: string): string => relative(baseDir, legacyProjectToolsDir(baseDir));

export function toolStatus(deps: BrokerDeps): { installed: InstalledStatus[]; corrupt?: string; ignoredInProject?: string } {
  const d = resolved(deps);
  // T1: a tools folder inside the project is never trusted. It is only noticed, so the person is told it is not used.
  const ignoredInProject = hasLegacyProjectTools(d.baseDir) ? IGNORED_IN_PROJECT_NOTE(d.baseDir) : undefined;
  const lock = readLock(d.baseDir);
  if (lock.kind === "corrupt") return { installed: [], corrupt: lock.error, ...(ignoredInProject ? { ignoredInProject } : {}) };
  const installed = lock.lock.records.map((record): InstalledStatus => {
    const entry = findEntry(d.catalog, record.id);
    if (!entry) return { record, state: "unknown-tool", detail: "no longer in this release's catalog" };
    const dir = toolDir(d.baseDir, record.id);
    if (!binPathInside(dir, record.binRelPath)) return { record, state: "bin-path-unsafe", detail: "the recorded binary path points outside the tool's folder" };
    if (!existsSync(join(dir, ...record.binRelPath.split("/")))) return { record, state: "missing-binary", detail: record.binRelPath };
    // The lock files written next to the install must still hash to what was recorded.
    const onDisk: Record<string, string> = {};
    for (const name of Object.keys(entry.files)) {
      try {
        onDisk[name] = readFileSync(join(dir, name), "utf-8");
      } catch {
        return { record, state: "lock-file-modified", detail: `${name} is missing` };
      }
    }
    if (hashLockFiles(onDisk) !== record.lockSha256) return { record, state: "lock-file-modified", detail: "files next to the install differ from what was installed" };
    if (entry.lockSha256 !== record.lockSha256) return { record, state: "catalog-changed", detail: `installed ${record.version}, catalog now has ${entry.version}` };
    return { record, state: "ok" };
  });
  return { installed, ...(ignoredInProject ? { ignoredInProject } : {}) };
}

/** For consumers (verify, lang, ...): absolute path of an installed, intact tool binary, or null. Read-only. */
export function getToolBinary(deps: BrokerDeps, id: string): string | null {
  const s = toolStatus(deps).installed.find((i) => i.record.id === id);
  if (!s || (s.state !== "ok" && s.state !== "catalog-changed")) return null;
  return join(toolDir(deps.baseDir, id), ...s.record.binRelPath.split("/"));
}

// ------------------------------------------------------------ one answer for "where is the tool?"

export interface ToolLocation {
  id: string;
  /** Argument prefix that runs the tool: [binary], or [node, script] for a project's own tsc. */
  command: string[];
  /** "project": the project's own copy (node_modules). "purix": the pinned, hash-checked copy under the tools folder. */
  source: "project" | "purix";
  /**
   * Real folder that must stay readable for `command` to run when the caller uses a sandbox.
   * Set for Purix-installed tools only; a project's copy lives under the project's node_modules,
   * which callers already bind.
   */
  toolHome?: string;
}

/** Scripts a project's npm tool can be run through directly (kept from the previous tsc lookup). */
const PROJECT_NODE_SCRIPT: Record<string, readonly string[]> = { typescript: ["typescript", "bin", "tsc"] };

/**
 * The single answer to "where is this tool, so I can run it?" for verify, tests, idiom and the
 * language providers. Project-provided copy first (it is what the project already uses; Purix does
 * not install a second one), then the Purix-installed copy. There is no PATH search on purpose:
 * an unpinned global binary is not something Purix vouches for. Read-only: creates nothing, spawns
 * nothing. Returns null when neither exists; call missingToolHint for what to tell the user.
 */
export function locateTool(deps: BrokerDeps, id: string): ToolLocation | null {
  const d = resolved(deps);
  const entry = findEntry(d.catalog, id);
  if (!entry) return null;

  if (entry.method === "npm-ci") {
    const modules = join(d.baseDir, "node_modules");
    const script = PROJECT_NODE_SCRIPT[entry.id];
    if (script && existsSync(join(modules, ...script))) {
      return { id, command: ["node", join(modules, ...script)], source: "project" };
    }
    for (const name of [entry.bin, `${entry.bin}.cmd`]) {
      const bin = join(modules, ".bin", name);
      if (existsSync(bin)) return { id, command: [bin], source: "project" };
    }
  }

  const installed = getToolBinary(deps, id);
  if (installed) {
    let home = toolDir(d.baseDir, id);
    try {
      home = realpathSync(home);
    } catch {
      // keep the unresolved path; the existence check above already passed
    }
    return { id, command: [installed], source: "purix", toolHome: home };
  }
  return null;
}

/** What to tell someone when locateTool found nothing. One sentence, always names the command. */
export function missingToolHint(deps: BrokerDeps, id: string): string {
  const d = resolved(deps);
  const entry = findEntry(d.catalog, id);
  if (!entry) return `${id} is not in the Purix tool catalog. See: purix tools list`;
  const declared = entry.method === "npm-ci" && detectProjectSignals(d.baseDir, d.catalog).declaredIds.has(id);
  return declared
    ? `${entry.displayName} is declared by your project but is not installed. Install your project's dependencies, or run: purix tools install ${id}`
    : `Run: purix tools install ${id}`;
}

// ------------------------------------------------------------ `purix tools "<purpose>"`

export type PurposeState = "installed" | "project-provided" | "missing";

export interface PurposeResult {
  purpose: string;
  matches: Array<{ entry: CatalogEntry; reasons: string[]; state: PurposeState }>;
}

/** Catalog tools that fit free text, with each one's state here. Offline and read-only. */
export function searchPurpose(deps: BrokerDeps, purpose: string): PurposeResult {
  const d = resolved(deps);
  const signals = detectProjectSignals(d.baseDir, d.catalog);
  const matches = matchPurpose(purpose, d.catalog).map((m) => {
    const state: PurposeState = getToolBinary(deps, m.entry.id)
      ? "installed"
      : signals.projectBinaryIds.has(m.entry.id)
      ? "project-provided"
      : "missing";
    const declared = signals.declaredIds.has(m.entry.id);
    return { entry: m.entry, reasons: declared ? [...m.reasons, "your project already declares it"] : m.reasons, state, declared, score: m.score };
  });
  // Best fit first; among tools that fit equally well, the one the project already uses comes first
  // (same rule as `plan`). A tool the user named always outranks one the project merely declares.
  const ordered = matches
    .map((m, i) => ({ m, i }))
    .sort((a, b) => b.m.score - a.m.score || Number(b.m.declared) - Number(a.m.declared) || a.i - b.i)
    .map(({ m: { declared: _declared, score: _score, ...rest } }) => rest);
  return { purpose, matches: ordered };
}

const PURPOSE_STATE_LABEL: Record<PurposeState, string> = {
  installed: "installed",
  "project-provided": "your project has its own",
  missing: "not installed",
};

/**
 * Plain text for a PurposeResult, one rendering for the CLI and for MCP. `agent: true` words the next
 * step the way an agent may act on it: ask for an install, never run one (ADR-060 D6).
 */
export function formatPurposeResult(result: PurposeResult, opts: { agent?: boolean } = {}): string {
  if (result.matches.length === 0) {
    return [
      `Nothing in the Purix catalog matches "${result.purpose}".`,
      `The catalog only holds the tools Purix itself runs. See all of them: ${opts.agent ? "purix_tools_plan" : "purix tools list"}`,
    ].join("\n");
  }
  const lines = [`Tools in the Purix catalog for "${result.purpose}" (matched offline, nothing was downloaded):`];
  for (const m of result.matches) {
    const e = m.entry;
    const next = m.state === "missing" ? (opts.agent ? `, ask for it with purix_tools_request_install (toolId: ${e.id})` : `, install with: purix tools install ${e.id}`) : "";
    lines.push(`  ${e.id.padEnd(11)} ${e.version.padEnd(8)} ${e.description}`);
    lines.push(`  ${" ".repeat(11)} ${PURPOSE_STATE_LABEL[m.state]}${next}`);
    lines.push(`  ${" ".repeat(11)} why: ${m.reasons.join("; ")}`);
  }
  lines.push("", `See what this project needs: ${opts.agent ? "purix_tools_plan" : "purix tools plan"}`);
  return lines.join("\n");
}

// ------------------------------------------------------------ agent path: ask only

export type RequestResult = { ok: true; request: PendingRequest } | BrokerFailure;

/** Writes one pending file and one audit entry. Installs nothing. Safe to expose to agents. */
export function requestInstall(deps: BrokerDeps, id: string, reason?: string, origin: "agent" | "cli" = "agent"): RequestResult {
  const d = resolved(deps);
  const entry = findEntry(d.catalog, id);
  if (!entry) return failure("unknown-tool", `"${id}" is not in the shipped tool catalog. Run "purix tools list" to see what is.`);
  const refused = preflight(entry, d);
  if (refused && !refused.ok) return failure(refused.reason, refused.message, refused.hint);
  const request = createPending(d.baseDir, id, origin, reason, d.now);
  try {
    d.audit.record({ action: "request", toolId: id, origin, version: entry.version, lockSha256: entry.lockSha256, requestId: request.id, ...(request.reason ? { reason: request.reason } : {}) });
  } catch (err) {
    deletePending(d.baseDir, request.id);
    return failure("audit-unavailable", `The audit chain could not be written (${err instanceof Error ? err.message : String(err)}); nothing was requested.`);
  }
  return { ok: true, request };
}

// ------------------------------------------------------------ human path

function bestEffortAudit(audit: AuditSink, event: Parameters<AuditSink["record"]>[0]): void {
  try {
    audit.record(event);
  } catch {
    // The caller is already reporting a refusal or failure; a second failure must not hide the first.
  }
}

export async function installTool(
  deps: BrokerDeps,
  id: string,
  origin: "cli" | "agent" = "cli",
  extra: { requestId?: string; requestReason?: string } = {}
): Promise<BrokerInstallResult> {
  const d = resolved(deps);
  const entry = findEntry(d.catalog, id);
  if (!entry) return failure("unknown-tool", `"${id}" is not in the shipped tool catalog. Run "purix tools list" to see what is.`);

  const lock = readLock(d.baseDir);
  if (lock.kind === "corrupt") {
    return failure("state-corrupt", `The install records in ${toolsDir(d.baseDir)} are unreadable (${lock.error}).`, "Move the damaged file aside (it only records installs) and run this again.");
  }
  const existing = lock.lock.records.find((r) => r.id === id);
  if (existing) {
    const status = toolStatus(deps).installed.find((s) => s.record.id === id);
    if (status?.state === "ok") return { ok: true, record: existing, alreadyInstalled: true };
  }

  const base = { toolId: id, origin, version: entry.version, lockSha256: entry.lockSha256, ...(extra.requestId ? { requestId: extra.requestId } : {}) };

  const refused = preflight(entry, d);
  if (refused && !refused.ok) {
    bestEffortAudit(d.audit, { ...base, action: "refused", reason: refused.reason });
    return failure(refused.reason, refused.message, refused.hint);
  }

  if (!d.consent) {
    bestEffortAudit(d.audit, { ...base, action: "refused", reason: "no-consent-gate" });
    return failure("no-consent-gate", "No human consent gate is available; installs are never done without one.");
  }
  const approved = await d.consent.confirmInstall(describeInstall(entry, d.baseDir, origin, extra.requestReason));
  if (!approved) {
    bestEffortAudit(d.audit, { ...base, action: "refused", reason: "consent-declined" });
    return failure("consent-declined", "Not installed: you did not confirm.");
  }

  try {
    d.audit.record({ ...base, action: "approval" });
  } catch (err) {
    return failure("audit-unavailable", `The audit chain could not be written (${err instanceof Error ? err.message : String(err)}); nothing was installed.`);
  }

  // One installer per tool. The human prompt above can take minutes, so the lock is taken only now, for the install itself.
  const held = acquireInstallLock(d.baseDir, id, { now: d.now });
  if (!held.ok) {
    bestEffortAudit(d.audit, { ...base, action: "refused", reason: "install-in-progress" });
    return failure("install-in-progress", held.message, "Wait for it to finish, then run this again.");
  }
  let outcome: ReturnType<typeof installEntry>;
  try {
    // Someone else may have finished this tool while we waited for the prompt or the lock.
    const nowRecorded = readLock(d.baseDir);
    const done = nowRecorded.kind === "ok" ? nowRecorded.lock.records.find((r) => r.id === id) : undefined;
    if (done && toolStatus(deps).installed.find((s) => s.record.id === id)?.state === "ok") return { ok: true, record: done, alreadyInstalled: true };
    outcome = installEntry(entry, { ...d, ...(d.installDeadlineMs ? { deadlineMs: d.installDeadlineMs } : {}) });
    if (outcome.ok) writeRecord(d.baseDir, outcome.record);
  } finally {
    held.release();
  }
  if (!outcome.ok) {
    bestEffortAudit(d.audit, { ...base, action: "install_failed", reason: outcome.reason });
    return failure(outcome.reason, outcome.message, outcome.hint);
  }
  let warning: string | undefined;
  try {
    d.audit.record({ ...base, action: "install" });
  } catch (err) {
    warning = `Installed, but the audit chain could not be written (${err instanceof Error ? err.message : String(err)}).`;
  }
  return { ok: true, record: outcome.record, alreadyInstalled: false, ...(warning ? { warning } : {}) };
}

/** Human approves a request an agent made. Same gate, same checks as installTool. */
export async function approveRequest(deps: BrokerDeps, requestId: string): Promise<BrokerInstallResult> {
  const d = resolved(deps);
  const req = readPending(d.baseDir, requestId);
  if (!req) return failure("unknown-request", `No pending request "${requestId}".`);
  const result = await installTool(deps, req.toolId, req.origin, { requestId: req.id, ...(req.reason ? { requestReason: req.reason } : {}) });
  if (result.ok || result.reason === "consent-declined") deletePending(d.baseDir, req.id);
  return result;
}

export type RemoveResult = { ok: true; removed: boolean } | BrokerFailure;

export function removeTool(deps: BrokerDeps, id: string): RemoveResult {
  const d = resolved(deps);
  const lock = readLock(d.baseDir);
  if (lock.kind === "corrupt") return failure("state-corrupt", `The install records in ${toolsDir(d.baseDir)} are unreadable (${lock.error}).`);
  const record = lock.lock.records.find((r) => r.id === id);
  const dir = toolDir(d.baseDir, id);
  if (!record && !existsSync(dir)) return { ok: true, removed: false };
  try {
    d.audit.record({ action: "remove", toolId: id, origin: "cli", ...(record ? { version: record.version, lockSha256: record.lockSha256 } : {}) });
  } catch (err) {
    return failure("audit-unavailable", `The audit chain could not be written (${err instanceof Error ? err.message : String(err)}); nothing was removed.`);
  }
  const held = acquireInstallLock(d.baseDir, id, { now: d.now });
  if (!held.ok) return failure("install-in-progress", held.message.replace("install of", "install or removal of"), "Wait for it to finish, then run this again.");
  try {
    safeRmSync(dir);
    removeRecord(d.baseDir, id);
  } finally {
    held.release();
  }
  return { ok: true, removed: true };
}
