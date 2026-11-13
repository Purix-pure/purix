// packages/core/src/approvals/pending.ts
//
// Pending approvals for MCP clients that cannot ask a person themselves (C-30, D-20).
//
// When a gated tool is called and the client has no working MCP elicitation, Purix does not act. It writes a
// request here and returns its id. A person answers with `purix approve <id>` / `purix deny <id>` in a terminal.
// The agent can read the state (`purix_approval_status`) but nothing on the MCP surface can change it.
//
// Properties, each covered by pending.test.ts:
//  - Signed: every record carries an HMAC-SHA256 over its own content. The key lives in the user folder
//    (~/.purix, or PURIX_USER_DIR), outside the project, so a file written into <project>/.purix/approvals
//    by anything that cannot read that key does not verify and is never used.
//  - Single use: the first call that consumes an approval claims it with an exclusive-create marker; a second
//    call, even a concurrent one, finds the marker and gets "used".
//  - Bound to the call: the record is found by a hash of tool + checkpoint + component + canonical arguments.
//    An approval for one call never covers a different one.
//  - Short-lived: 30 minutes (APPROVAL_TTL_MS). After that the request reads as "expired".
//
// Honest limit, as written in D-20: an agent that runs as the same operating-system user can read the key
// and a real terminal. The hook rule `human-only` and the terminal requirement in `purix approve` raise the cost of
// that; they do not remove it.
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { createFileExclusive, readJsonFile, writeFileAtomic, writeJsonAtomic } from "../platform/atomic_write.js";
import { purixDir } from "../platform/layout.js";
import { userStateDir } from "../usage/consent.js";
import { recordGovernanceEvent } from "../security/audit_events.js";

export const APPROVAL_TTL_MS = 30 * 60 * 1000;
/** Finished records are kept this long after they expire, so `purix approve --list --all` and status lookups still work. */
const KEEP_AFTER_EXPIRY_MS = 24 * 60 * 60 * 1000;
const ID_PATTERN = /^apr-[0-9a-f]{12}$/;

export type StoredStatus = "pending" | "approved" | "denied";
export type ApprovalState = "pending" | "approved" | "denied" | "used" | "expired" | "invalid";

export interface ApprovalCall {
  tool: string;
  checkpointKind: string;
  componentId: string | null;
  args: unknown;
}

export interface ApprovalRequestInput extends ApprovalCall {
  /** One line for `purix approve --list`. */
  summary: string;
  /** The full text the person reads before answering. */
  message: string;
  /** What the person is approving, kept so the approved call runs exactly this and not a fresh model answer. */
  payload?: unknown;
  client?: string | null;
}

export interface ApprovalRecord {
  schema: 1;
  id: string;
  tool: string;
  checkpointKind: string;
  componentId: string | null;
  /** Hash of tool, checkpoint, component and canonical arguments. */
  actionKey: string;
  /** Hash of the text the person was shown. */
  messageHash: string;
  summary: string;
  message: string;
  payload?: unknown;
  client: string | null;
  status: StoredStatus;
  createdAt: string;
  expiresAt: string;
  decidedAt?: string;
  sig: string;
}

export interface ApprovalView {
  id: string;
  state: ApprovalState;
  tool?: string;
  componentId?: string | null;
  summary?: string;
  createdAt?: string;
  expiresAt?: string;
}

export type RequestOutcome = { state: "pending" | "approved" | "denied"; record: ApprovalRecord };

// ---------------------------------------------------------------------------------------------------------------------
// Storage and signing

function approvalsDir(baseDir: string): string {
  return join(purixDir(baseDir), "approvals");
}
function recordPath(baseDir: string, id: string): string {
  return join(approvalsDir(baseDir), `${id}.json`);
}
function usedMarker(baseDir: string, id: string): string {
  return join(approvalsDir(baseDir), `${id}.used`);
}

/** The signing key: 32 random bytes, created on first use, readable only by the user where the platform allows. */
function signingKey(): Buffer {
  const dir = userStateDir();
  const path = join(dir, "approval.key");
  if (existsSync(path)) {
    const text = readFileSync(path, "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
  }
  mkdirSync(dir, { recursive: true });
  const fresh = randomBytes(32).toString("hex");
  // Exclusive create: two processes starting together end up with one key, not two.
  if (!createFileExclusive(path, `${fresh}\n`, { mode: 0o600 })) {
    const text = readFileSync(path, "utf-8").trim();
    if (/^[0-9a-f]{64}$/.test(text)) return Buffer.from(text, "hex");
    writeFileAtomic(path, `${fresh}\n`, { mode: 0o600 });
  }
  return Buffer.from(fresh, "hex");
}

/** JSON with object keys sorted at every level, so the same value always hashes and signs the same way. */
export function canonicalJson(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function actionKeyFor(call: ApprovalCall): string {
  return sha256(canonicalJson([call.tool, call.checkpointKind, call.componentId, call.args]));
}

function sign(record: Omit<ApprovalRecord, "sig">): string {
  return createHmac("sha256", signingKey()).update(canonicalJson(record)).digest("hex");
}

function verifies(record: ApprovalRecord): boolean {
  if (typeof record.sig !== "string" || !/^[0-9a-f]{64}$/.test(record.sig)) return false;
  const { sig, ...rest } = record;
  const expected = Buffer.from(sign(rest), "hex");
  const given = Buffer.from(sig, "hex");
  return expected.length === given.length && timingSafeEqual(expected, given);
}

function save(baseDir: string, record: Omit<ApprovalRecord, "sig">): ApprovalRecord {
  const full: ApprovalRecord = { ...record, sig: sign(record) };
  mkdirSync(approvalsDir(baseDir), { recursive: true });
  writeJsonAtomic(recordPath(baseDir, record.id), full, { mode: 0o600 });
  return full;
}

type Loaded = { kind: "missing" } | { kind: "invalid" } | { kind: "ok"; record: ApprovalRecord };

function load(baseDir: string, id: string): Loaded {
  if (!ID_PATTERN.test(id)) return { kind: "missing" };
  const read = readJsonFile<ApprovalRecord>(recordPath(baseDir, id));
  if (read.kind === "missing") return { kind: "missing" };
  if (read.kind === "corrupt") return { kind: "invalid" };
  const r = read.value;
  const shapeOk =
    r !== null &&
    typeof r === "object" &&
    r.schema === 1 &&
    r.id === id &&
    typeof r.tool === "string" &&
    typeof r.actionKey === "string" &&
    typeof r.expiresAt === "string" &&
    (r.status === "pending" || r.status === "approved" || r.status === "denied");
  if (!shapeOk || !verifies(r)) return { kind: "invalid" };
  return { kind: "ok", record: r };
}

function stateOf(baseDir: string, record: ApprovalRecord, now: Date): ApprovalState {
  if (existsSync(usedMarker(baseDir, record.id))) return "used";
  if (now.getTime() > Date.parse(record.expiresAt)) return "expired";
  return record.status;
}

function listIds(baseDir: string): string[] {
  const dir = approvalsDir(baseDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .filter((id) => ID_PATTERN.test(id));
}

function cleanup(baseDir: string, now: Date): void {
  for (const id of listIds(baseDir)) {
    const loaded = load(baseDir, id);
    const expiry = loaded.kind === "ok" ? Date.parse(loaded.record.expiresAt) : NaN;
    // Unreadable or forged records are left in place: they are evidence, and `--list --all` reports them.
    if (loaded.kind === "ok" && now.getTime() > expiry + KEEP_AFTER_EXPIRY_MS) {
      for (const p of [recordPath(baseDir, id), usedMarker(baseDir, id)]) {
        try {
          unlinkSync(p);
        } catch {
          // already gone
        }
      }
    }
  }
}

/** The newest live record for this exact call, or null. "Live" means not used and not expired. */
function findLive(baseDir: string, call: ApprovalCall, now: Date): ApprovalRecord | null {
  const key = actionKeyFor(call);
  let best: ApprovalRecord | null = null;
  for (const id of listIds(baseDir)) {
    const loaded = load(baseDir, id);
    if (loaded.kind !== "ok" || loaded.record.actionKey !== key) continue;
    const state = stateOf(baseDir, loaded.record, now);
    if (state !== "pending" && state !== "approved" && state !== "denied") continue;
    if (!best || loaded.record.createdAt > best.createdAt) best = loaded.record;
  }
  return best;
}

// ---------------------------------------------------------------------------------------------------------------------
// Called by the MCP server

/**
 * A2a-1: requests, answers and uses go into the audit chain. Hashes only: never the message the person read or the arguments.
 * Best effort by design: a full disk must not stop a person from answering an approval, and the signed record file is still the
 * authority for whether a call may run. Skipped when `baseDir` is not the project whose store this process has open.
 */
function auditApproval(baseDir: string, state: "requested" | "approved" | "denied" | "consumed", r: ApprovalRecord, at: Date): void {
  recordGovernanceEvent(
    "approval",
    {
      state,
      approval_id: r.id,
      tool: r.tool,
      checkpoint_kind: r.checkpointKind,
      component_id: r.componentId,
      action_key: r.actionKey,
      message_hash: r.messageHash,
      client: r.client,
      at: at.toISOString(),
    },
    { baseDir },
  );
}

/**
 * Looks for a decision on this exact call.
 *  - approved and unused: claims it (one call only) and returns state "approved";
 *  - denied: returns "denied" until it expires;
 *  - still waiting: returns the same request again, so repeated calls never pile up requests;
 *  - nothing live: creates a new request and returns it as "pending".
 */
export function requestOrConsume(baseDir: string, input: ApprovalRequestInput, now: Date = new Date()): RequestOutcome {
  const live = findLive(baseDir, input, now);
  if (live) {
    const state = stateOf(baseDir, live, now);
    if (state === "approved") {
      // Exclusive create is the single-use guarantee: only the first caller gets true.
      mkdirSync(approvalsDir(baseDir), { recursive: true });
      if (createFileExclusive(usedMarker(baseDir, live.id), `${now.toISOString()}\n`)) {
        auditApproval(baseDir, "consumed", live, now);
        return { state: "approved", record: live };
      }
    } else if (state === "denied") {
      return { state: "denied", record: live };
    } else if (state === "pending") {
      return { state: "pending", record: live };
    }
    // Claimed by someone else a moment ago: fall through and make a fresh request.
  }
  cleanup(baseDir, now);
  const record = save(baseDir, {
    schema: 1,
    id: `apr-${randomBytes(6).toString("hex")}`,
    tool: input.tool,
    checkpointKind: input.checkpointKind,
    componentId: input.componentId,
    actionKey: actionKeyFor(input),
    messageHash: sha256(input.message),
    summary: input.summary,
    message: input.message,
    ...(input.payload !== undefined ? { payload: input.payload } : {}),
    client: input.client ?? null,
    status: "pending",
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + APPROVAL_TTL_MS).toISOString(),
  });
  auditApproval(baseDir, "requested", record, now);
  return { state: "pending", record };
}

/**
 * Read-only look at the live record for this exact call: pending, approved (not yet used) or denied.
 * Creates nothing and consumes nothing. AI-09 uses it to answer a repeated call without redoing model work,
 * and to find an approved stored result to apply. Null when nothing live exists (none, used or expired).
 */
export function peekRequest(baseDir: string, call: ApprovalCall, now: Date = new Date()): RequestOutcome | null {
  const live = findLive(baseDir, call, now);
  if (!live) return null;
  const state = stateOf(baseDir, live, now);
  return state === "pending" || state === "approved" || state === "denied" ? { state, record: live } : null;
}

/** Returns the approved, unused record for this exact call without consuming it, or null. Used to reuse the approved plan. */
export function peekApproved(baseDir: string, call: ApprovalCall, now: Date = new Date()): ApprovalRecord | null {
  const live = findLive(baseDir, call, now);
  return live && stateOf(baseDir, live, now) === "approved" ? live : null;
}

/** What the agent is allowed to see. Never includes the signature or the full message. */
export function approvalStatus(baseDir: string, id: string, now: Date = new Date()): ApprovalView | null {
  const loaded = load(baseDir, id);
  if (loaded.kind === "missing") return null;
  if (loaded.kind === "invalid") return { id, state: "invalid" };
  const r = loaded.record;
  return {
    id: r.id,
    state: stateOf(baseDir, r, now),
    tool: r.tool,
    componentId: r.componentId,
    summary: r.summary,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Called by `purix approve` / `purix deny`

/** The record a person is about to answer, with `status` showing its current state. Null if missing or it fails its check. */
export function loadApprovalForReview(baseDir: string, id: string, now: Date = new Date()): (Omit<ApprovalRecord, "status"> & { status: ApprovalState }) | null {
  const loaded = load(baseDir, id);
  if (loaded.kind !== "ok") return null;
  return { ...loaded.record, status: stateOf(baseDir, loaded.record, now) };
}

export function decideApproval(
  baseDir: string,
  id: string,
  decision: "approved" | "denied",
  now: Date = new Date()
): { ok: true } | { ok: false; reason: string } {
  const loaded = load(baseDir, id);
  if (loaded.kind === "missing") return { ok: false, reason: "no such request" };
  if (loaded.kind === "invalid") return { ok: false, reason: "the request failed its integrity check" };
  const state = stateOf(baseDir, loaded.record, now);
  if (state !== "pending") return { ok: false, reason: `the request is already ${state}` };
  const { sig: _sig, ...rest } = loaded.record;
  const saved = save(baseDir, { ...rest, status: decision, decidedAt: now.toISOString() });
  auditApproval(baseDir, decision, saved, now);
  return { ok: true };
}

export interface ApprovalListRow {
  id: string;
  state: ApprovalState;
  tool: string;
  componentId: string | null;
  expiresAt: string;
  summary: string;
}

export function listApprovals(baseDir: string, now: Date = new Date()): ApprovalListRow[] {
  const rows: ApprovalListRow[] = [];
  for (const id of listIds(baseDir)) {
    const loaded = load(baseDir, id);
    if (loaded.kind === "invalid") {
      rows.push({ id, state: "invalid", tool: "?", componentId: null, expiresAt: "-", summary: "failed its integrity check and is not used" });
    } else if (loaded.kind === "ok") {
      const r = loaded.record;
      rows.push({ id: r.id, state: stateOf(baseDir, r, now), tool: r.tool, componentId: r.componentId, expiresAt: r.expiresAt, summary: r.summary });
    }
  }
  return rows.sort((a, b) => (a.expiresAt < b.expiresAt ? 1 : -1));
}
