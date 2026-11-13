// packages/core/src/tools/consent.ts
//
// ADR-060 D6: consent for installs, and the pending-request store an agent can write to.
//
// An agent can ASK (writes a pending file). Only a human at an interactive prompt can APPROVE.
// There is deliberately no --yes and no environment bypass: the gate below does not use
// cli-io/confirm.ts's NODE_ENV=test/AUTO_CONFIRM shortcut. Tests inject a fake gate instead.
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { promptLine } from "../cli-io/confirm.js";
import { readJsonFile, writeFileAtomic } from "../platform/atomic_write.js";
import { toolDir, toolsDir, pendingDir } from "./state.js";
import type { CatalogEntry, PendingRequest } from "./types.js";

export interface InstallSummary {
  id: string;
  package: string;
  version: string;
  method: CatalogEntry["method"];
  license: string;
  releasedAt: string;
  lockSha256: string;
  installDir: string;
  stateDir: string;
  downloadsFrom: string;
  willRun: string[];
  origin: "cli" | "agent";
  requestReason?: string;
}

export interface ConsentGate {
  confirmInstall(summary: InstallSummary): Promise<boolean>;
}

export function describeInstall(entry: CatalogEntry, baseDir: string, origin: "cli" | "agent", requestReason?: string): InstallSummary {
  const pip = entry.method === "pip-venv";
  return {
    id: entry.id,
    package: entry.package,
    version: entry.version,
    method: entry.method,
    license: entry.license,
    releasedAt: entry.releasedAt,
    lockSha256: entry.lockSha256,
    installDir: toolDir(baseDir, entry.id),
    stateDir: toolsDir(baseDir),
    downloadsFrom: pip ? "pypi.org / files.pythonhosted.org" : "registry.npmjs.org",
    willRun: pip
      ? ["python -m venv", "pip install --require-hashes --only-binary :all: --no-deps -r requirements.txt"]
      : ["npm ci --ignore-scripts --no-audit --no-fund"],
    origin,
    ...(requestReason ? { requestReason } : {}),
  };
}

export function formatInstallSummary(s: InstallSummary): string {
  const lines = [
    `Install ${s.id} (${s.package} ${s.version}, ${s.license}, released ${s.releasedAt.slice(0, 10)})`,
    `  into:       ${s.installDir}`,
    `  downloads:  ${s.downloadsFrom}`,
    `  will run:   ${s.willRun.join("  then  ")}`,
    `  integrity:  every package must match the hashes in the catalog lock (sha256 of lock: ${s.lockSha256.slice(0, 16)}...)`,
    `  scripts:    package install scripts do not run`,
    `  writes:     nothing outside ${s.stateDir}`,
  ];
  if (s.origin === "agent") {
    lines.push(`  requested by an AI agent${s.requestReason ? ` — its stated reason (untrusted text): "${s.requestReason}"` : ""}`);
  }
  return lines.join("\n");
}

/** Only an explicit yes. Empty, garbage, or "no input" is no. */
export function isAffirmative(answer: string | null): boolean {
  if (answer === null) return false;
  const a = answer.trim().toLowerCase();
  return a === "y" || a === "yes";
}

export function createHumanGate(ask: (question: string) => Promise<string | null> = promptLine): ConsentGate {
  return {
    async confirmInstall(summary) {
      const answer = await ask(`${formatInstallSummary(summary)}\nInstall this tool? [y/N] `);
      return isAffirmative(answer);
    },
  };
}

// ---------------------------------------------------------------- pending requests

const REQUEST_ID = /^req-[0-9a-f]{12}$/;
const MAX_REASON = 200;

/** Agent-supplied text is untrusted: cap its length, drop control characters, collapse whitespace. */
export function sanitizeReason(raw: string | undefined): string {
  if (!raw) return "";
   
  return raw.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_REASON);
}

export function isValidRequestId(id: string): boolean {
  return REQUEST_ID.test(id);
}

export function createPending(baseDir: string, toolId: string, origin: "cli" | "agent", reason: string | undefined, now: Date): PendingRequest {
  const req: PendingRequest = {
    id: `req-${randomBytes(6).toString("hex")}`,
    toolId,
    requestedAt: now.toISOString(),
    origin,
    reason: sanitizeReason(reason),
    status: "pending",
  };
  mkdirSync(pendingDir(baseDir), { recursive: true });
  writeFileAtomic(join(pendingDir(baseDir), `${req.id}.json`), JSON.stringify(req, null, 2) + "\n");
  return req;
}

export function readPending(baseDir: string, id: string): PendingRequest | null {
  if (!isValidRequestId(id)) return null; // never build a path from unvalidated text
  const r = readJsonFile<PendingRequest>(join(pendingDir(baseDir), `${id}.json`));
  if (r.kind !== "ok") return null;
  const v = r.value;
  if (v.id !== id || typeof v.toolId !== "string" || v.status !== "pending") return null;
  return v;
}

export function listPending(baseDir: string): PendingRequest[] {
  const dir = pendingDir(baseDir);
  if (!existsSync(dir)) return [];
  const out: PendingRequest[] = [];
  for (const f of readdirSync(dir)) {
    const id = f.replace(/\.json$/, "");
    const req = readPending(baseDir, id);
    if (req) out.push(req);
  }
  return out.sort((a, b) => a.requestedAt.localeCompare(b.requestedAt));
}

export function deletePending(baseDir: string, id: string): void {
  if (!isValidRequestId(id)) return;
  try {
    unlinkSync(join(pendingDir(baseDir), `${id}.json`));
  } catch {
    // already gone
  }
}
