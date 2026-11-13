// src/entrypoints/check.ts
//
// `purix check`: the one canonical check that a developer, a git pre-commit hook, CI and an agent hook adapter
// all call (PURIX-21 D9). It answers one question, with no model and no network: "does what is on disk still
// match what Purix governed, and is the evidence intact?"
//
// Contract, enforced by tests:
//  - Read-only. It never creates, repairs, migrates, locks or appends to anything, and the store file stays
//    byte-identical. The one trace it can leave is SQLite's own empty -wal/-shm sidecar files, which SQLite creates
//    whenever a WAL-mode database is opened, even read-only (opening it "immutable" would avoid that but could read
//    stale data while another Purix process holds unflushed writes, so it is not done).
//  - Deterministic. Same disk, same answer. No LLM call, no network call.
//  - Honest. Uses the single result vocabulary (verify/outcome.ts): a check that did not run is "skipped", never
//    "pass". Nothing governed here is "skipped", not "pass".
//  - Returns data. Printing belongs to the CLI (core printing is ratcheted down, rule R1).
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { Outcome } from "../verify/outcome.js";
import { listFiles, storedStatusLabel, notTestedInline } from "../verify/outcome.js";
import { detailSaysSearchCut, detailSearchCutFiles, detailSecurityNotes } from "../verify/discovery_cut.js";
import { partialLineMessage, securityNotesMessages } from "../verify/surface_text.js";
import { readStoreSnapshot, storeDirectory, type StoreSnapshot } from "../manifest/store.js";
import { describeStoreProblem } from "../platform/disk_full.js";
import { verifyAuditRows, verifyAuditReceipt, loadAuditReceipt, receiptAheadReason, type AuditRow, type AuditCheckpointRow } from "../security/audit_tamper_evidence.js";
import { computeSyncHash } from "../state/hash.js";
import { toolStatus } from "../tools/broker.js";
import { CODEBASE_INDEX_COMPONENT_ID } from "../manifest/adopt.js";
import { verifyLibraryRows } from "../manifest/library_chain.js";
import { LOCK_FILENAME, readLock, verifyFilesAgainstLock, verifyLockAgainstStore, hashGovernedContent, type GovernedLock } from "../state/governed_lock.js";

export type CheckSectionId = "store" | "lock" | "audit-chain" | "pending-operations" | "drift" | "verification" | "tools";

export interface CheckItem {
  outcome: Outcome;
  /** What the finding is about: a component id, a tool id, or the store itself. */
  subject: string;
  message: string;
}

export interface CheckSection {
  id: CheckSectionId;
  title: string;
  outcome: Outcome;
  items: CheckItem[];
}

export interface CheckReport {
  /** Version of this JSON shape; bump it if a field changes meaning. */
  schema: 1;
  outcome: Outcome;
  strict: boolean;
  /** 0 = nothing wrong; 1 = the check found a problem (or, with strict, something not verified). Exit 2 is reserved for "could not run". */
  exitCode: 0 | 1;
  sections: CheckSection[];
  /** One honest sentence a person or an agent can read first. */
  summary: string;
}

export interface CheckOptions {
  /** Project root. Default: the current directory. */
  baseDir?: string;
  /** Treat "skipped" (nothing governed, not synced, pending, not tested) as a failure. CI should set this. */
  strict?: boolean;
}

/** Worst outcome wins: fail > error > skipped > pass. not-applicable never makes anything worse. */
function worst(outcomes: Outcome[]): Outcome {
  for (const o of ["fail", "error", "skipped"] as const) if (outcomes.includes(o)) return o;
  return outcomes.some((o) => o === "pass") ? "pass" : "not-applicable";
}

function section(id: CheckSectionId, title: string, items: CheckItem[], whenEmpty: Outcome = "pass"): CheckSection {
  return { id, title, items, outcome: items.length === 0 ? whenEmpty : worst(items.map((i) => i.outcome)) };
}

/** Reads one governed file for hashing. A path that leaves the project is reported, never read. */
function readGoverned(baseDir: string, rel: string): { ok: true; content: string } | { ok: false; reason: string } {
  const full = resolve(baseDir, rel);
  const r = relative(baseDir, full);
  if (r === "" || r.startsWith("..") || isAbsolute(r)) return { ok: false, reason: "path leaves the project directory" };
  if (!existsSync(full)) return { ok: false, reason: "file is missing" };
  try {
    return { ok: true, content: readFileSync(full, "utf-8") };
  } catch (err) {
    return { ok: false, reason: `unreadable (${err instanceof Error ? err.message : String(err)})` };
  }
}

function driftSection(snapshot: StoreSnapshot, baseDir: string, lock: GovernedLock | null): CheckSection {
  const items: CheckItem[] = [];
  for (const entry of snapshot.manifest) {
    // F05-09: the aggregate index row is Purix's own listing of indexed files, not a governed component. A hand edit to a file it lists is not drift:
    // nothing governs that file, and the hook says so. (An agent's edit to it is named below as an unadopted write.)
    if (entry.component_id === CODEBASE_INDEX_COMPONENT_ID) continue;
    if (entry.last_synced_hash === null) {
      items.push({ outcome: "skipped", subject: entry.component_id, message: "never synced, so edits to its files cannot be detected" });
      continue;
    }
    const files: { path: string; content: string }[] = [];
    const problems: string[] = [];
    for (const rel of entry.files ?? []) {
      const r = readGoverned(baseDir, rel);
      if (r.ok) files.push({ path: rel, content: r.content });
      else problems.push(`${rel}: ${r.reason}`);
    }
    if (problems.length > 0) {
      items.push({ outcome: "fail", subject: entry.component_id, message: `changed outside Purix: ${problems.join("; ")}` });
    } else if (computeSyncHash(files) !== entry.last_synced_hash) {
      // Only a combined hash is stored, so on its own the store cannot say WHICH file changed. When the committed lock
      // matches this component, its per-file hashes can; otherwise say so rather than name files that did not change.
      const locked = lock?.components.find((c) => c.component_id === entry.component_id);
      const trusted = locked !== undefined && locked.last_synced_hash === entry.last_synced_hash;
      const changed = trusted ? files.filter((f) => locked.files.find((l) => l.path === f.path)?.sha256 !== hashGovernedContent(f.content)).map((f) => f.path) : [];
      const detail = changed.length > 0 ? `changed: ${listFiles(changed)}` : `one or more of its files differ; the store keeps one combined hash, so it cannot say which (governed: ${listFiles(entry.files ?? [])})`;
      items.push({ outcome: "fail", subject: entry.component_id, message: `changed outside Purix since its last sync (${detail})` });
    }
    // An unchanged component adds no item: silence is the pass, and the section line counts it.
  }
  // C5: files an agent was allowed to write because no component governed them. Not a failure; not verified either, so "skipped" (strict fails on it).
  // Files that are governed now, or no longer exist, are not named.
  const governedNow = new Set(snapshot.manifest.filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID).flatMap((e) => e.files ?? []));
  const seen = new Map<string, string>();
  for (const w of snapshot.unadoptedWrites ?? []) for (const f of w.files) if (!governedNow.has(f) && existsSync(resolve(baseDir, f))) seen.set(f, w.agent);
  for (const [file, agent] of seen) {
    items.push({ outcome: "skipped", subject: file, message: `written by an agent (${agent}) while no component governed it; not governed by Purix, so Purix did not verify it. \`purix adopt\` brings it under Purix.` });
  }
  return section("drift", "Edits made outside Purix", items);
}

function verificationSection(snapshot: StoreSnapshot): CheckSection {
  // Latest passing verification per component, oldest first so a later pass overwrites an earlier one.
  const notTested = new Map<string, string[]>();
  // F06-05: components whose latest passing verification had its test search cut off at the file limit.
  const searchCut = new Set<string>();
  const searchCutFiles = new Map<string, string[]>();
  const securityNotes = new Map<string, ReturnType<typeof detailSecurityNotes>>();
  for (const e of snapshot.verificationPasses) {
    if (!e.component_id) continue;
    const raw = e.detail["not_tested"];
    const files = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (files.length > 0) notTested.set(e.component_id, files);
    else notTested.delete(e.component_id);
    if (files.length > 0 && detailSaysSearchCut(e.detail)) searchCut.add(e.component_id);
    else searchCut.delete(e.component_id);
    const cf = files.length > 0 ? detailSearchCutFiles(e.detail) : undefined;
    // C4 follow-up: the latest pass per component decides, like not_tested: a later pass that saw nothing erases the earlier note.
    const sec = detailSecurityNotes(e.detail);
    if (sec.advisories.length > 0 || sec.notRead.length > 0) securityNotes.set(e.component_id, sec); else securityNotes.delete(e.component_id);
    if (cf) searchCutFiles.set(e.component_id, cf); else searchCutFiles.delete(e.component_id);
  }
  const items: CheckItem[] = [];
  for (const entry of snapshot.manifest) {
    // F05-09: the index row is Purix's own listing, not a governed component; its status must not read as a failed component.
    if (entry.component_id === CODEBASE_INDEX_COMPONENT_ID) continue;
    if (entry.verification_status === "fail") {
      items.push({ outcome: "fail", subject: entry.component_id, message: "its last verification failed" });
    } else if (entry.verification_status === "pending") {
      items.push({ outcome: "skipped", subject: entry.component_id, message: `${storedStatusLabel("pending")}: no test has run on it` });
    }
    const gap = notTested.get(entry.component_id);
    if (gap && entry.verification_status === "pass") {
      items.push({ outcome: "skipped", subject: entry.component_id, message: notTestedInline(gap, { searchCut: searchCut.has(entry.component_id), ...(searchCutFiles.has(entry.component_id) ? { cutFiles: searchCutFiles.get(entry.component_id)! } : {}) })! });
    }
    // F04-04: a review note, not a failure. The edit was applied and verified; its anchor started or ended inside a line.
    const partial = entry.verification_status === "pass" ? partialLineMessage(snapshot.partialLine?.[entry.component_id]) : undefined;
    if (partial) items.push({ outcome: "pass", subject: entry.component_id, message: partial });
    // C4 follow-up: notes, not failures: the change was verified, and the security gate did not block it.
    const sec = entry.verification_status === "pass" ? securityNotes.get(entry.component_id) : undefined;
    if (sec) for (const m of securityNotesMessages(sec.advisories, sec.notRead)) items.push({ outcome: "pass", subject: entry.component_id, message: m });
  }
  return section("verification", "Verification status", items);
}

function toolsSection(baseDir: string): CheckSection {
  const items: CheckItem[] = [];
  try {
    const s = toolStatus({ baseDir });
    if (s.corrupt) items.push({ outcome: "fail", subject: "tools lock", message: `the tools lock file is unreadable: ${s.corrupt}` });
    // T1: a tools folder carried inside the project is never read. Said once, as information: it is not damage to anything Purix uses.
    if (s.ignoredInProject) items.push({ outcome: "skipped", subject: s.ignoredInProject, message: "found inside the project and not used: Purix keeps its tools in your user folder (run `purix tools install <id>` to install them again)" });
    for (const i of s.installed) {
      // A newer catalog is information, not damage; anything else means the installed tool no longer matches its lock.
      if (i.state === "ok" || i.state === "catalog-changed") continue;
      items.push({ outcome: "fail", subject: i.record.id, message: `${i.state}${i.detail ? ` (${i.detail})` : ""}` });
    }
  } catch (err) {
    items.push({ outcome: "error", subject: "tools", message: `could not read tool status: ${err instanceof Error ? err.message : String(err)}` });
  }
  return section("tools", "Installed tools match their lock", items);
}

/**
 * The audit-chain section. The chain rule alone cannot see records cut off the END of the chain, or a chain emptied altogether: what
 * is left is still internally valid. The head receipt beside the store remembers the newest record, so a receipt that is ahead of
 * the chain is a failure (security review, "an emptied chain reads as no records"). With no receipt, an empty chain under governed
 * components is reported as unverifiable, not as a quiet "nothing yet".
 */
function auditChainItems(rows: AuditRow[], checkpoint: AuditCheckpointRow | null, governedCount: number, baseDir: string): CheckItem[] {
  const chain = verifyAuditRows(rows, checkpoint);
  if (!chain.valid) {
    return [{ outcome: "fail", subject: "audit chain", message: `${chain.reason ?? "verification failed"}${chain.compromisedIndex !== undefined ? ` (record index ${chain.compromisedIndex})` : ""}` }];
  }
  const receipt = loadAuditReceipt(baseDir);
  if (receipt.kind === "ok" && verifyAuditReceipt(rows, checkpoint, receipt.receipt).state === "ahead_of_chain") {
    return [{ outcome: "fail", subject: "audit chain", message: receiptAheadReason(receipt.receipt) }];
  }
  if (receipt.kind === "unreadable") {
    return [{ outcome: "skipped", subject: "audit chain", message: "the chain is consistent, but its head receipt cannot be read, so the end of the chain is not vouched for" }];
  }
  if (chain.recordCount === 0) {
    return [
      governedCount > 0
        ? { outcome: "skipped", subject: "audit chain", message: `empty (0 records) while ${governedCount} component(s) are governed, and there is no head receipt to say whether records were removed: it cannot be told from a store that never recorded anything` }
        : { outcome: "skipped", subject: "audit chain", message: "empty (0 records): nothing to verify yet" },
    ];
  }
  if (receipt.kind === "absent") {
    // Records but no receipt: cutting the tail and deleting the receipt would look exactly like this. Not a failure (a store from before
    // receipts, or one never committed to, has none), but never a quiet pass either.
    return [{ outcome: "skipped", subject: "audit chain", message: `the chain is consistent (${chain.recordCount} records), but there is no head receipt, so the end of the chain is not vouched for` }];
  }
  return [];
}

/**
 * F05-10: the operation library's hash chain. Silent when it holds (the section line counts it) and when there is no library table.
 * A broken chain means an entry was changed or removed outside the library's own functions, or the file was damaged.
 */
function libraryChainItems(snapshot: StoreSnapshot): CheckItem[] {
  const rows = snapshot.libraryRows ?? [];
  if (rows.length === 0) return [];
  const v = verifyLibraryRows(rows);
  if (v.valid) return [];
  return [{ outcome: "fail", subject: "operation library", message: `${v.reason ?? "its hash chain is broken"}${v.language ? ` (language ${v.language})` : ""}: a saved fix was changed or removed outside Purix` }];
}

/** Runs every check and returns the report. Never throws for a damaged or absent store; those are reported. */
export function runCheck(opts: CheckOptions = {}): CheckReport {
  const baseDir = resolve(opts.baseDir ?? process.cwd());
  const strict = opts.strict === true;
  const sections: CheckSection[] = [];

  const read = readStoreSnapshot();
  const lockRead = readLock(baseDir);
  const lock = lockRead.state === "ok" ? lockRead.lock : null;
  const lockDamaged: CheckItem[] = lockRead.state === "damaged" ? [{ outcome: "fail", subject: LOCK_FILENAME, message: `unreadable (${lockRead.detail}). Run "purix lock" to write it again.` }] : [];
  let lockOnly = false;
  if (read.state === "absent") {
    if (lock !== null) {
      // A fresh checkout (CI) has no local store. The committed lock is what there is to check against.
      lockOnly = true;
      sections.push(section("store", "Purix state", [{ outcome: "pass", subject: "store", message: `no local store here (normal in a fresh checkout); checked against ${LOCK_FILENAME} instead` }]));
      sections.push(
        section(
          "lock",
          `Governed files match ${LOCK_FILENAME}`,
          lock.components.length === 0 ? [{ outcome: "skipped", subject: LOCK_FILENAME, message: "it lists no components: nothing is governed, so nothing was checked" }] : verifyFilesAgainstLock(lock, baseDir)
        )
      );
      sections.push(section("audit-chain", "Audit chain", [{ outcome: "not-applicable", subject: "audit chain", message: "it lives in the local store, which is not part of a checkout, so it was not checked here" }]));
    } else if (lockDamaged.length > 0) {
      sections.push(section("store", "Purix state", [{ outcome: "skipped", subject: "store", message: "no Purix state here: nothing is governed, so nothing was checked" }]));
      sections.push(section("lock", `Governed files match ${LOCK_FILENAME}`, lockDamaged));
    } else {
      sections.push(section("store", "Purix state", [{ outcome: "skipped", subject: "store", message: `no Purix state here: nothing is governed, so nothing was checked. To check a fresh checkout (CI), run "purix lock" where the work was done and commit ${LOCK_FILENAME}` }]));
    }
  } else if (read.state === "damaged") {
    sections.push(section("store", "Purix state", [{ outcome: "error", subject: "store", message: `${describeStoreProblem(read.detail, storeDirectory())} Nothing was changed or rebuilt.` }]));
  } else {
    const snap = read.snapshot;
    const governedCount = snap.manifest.filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID).length;
    // A store with no components governs nothing; "pass" over zero components would be a vacuous pass.
    sections.push(
      section("store", "Purix state", [...(governedCount === 0 ? [{ outcome: "skipped" as const, subject: "store", message: "no components are registered: nothing is governed, so nothing was checked" }] : []), ...libraryChainItems(snap)], "pass")
    );

    if (lockDamaged.length > 0) sections.push(section("lock", `Governed files match ${LOCK_FILENAME}`, lockDamaged));
    else if (lock !== null) sections.push(section("lock", `${LOCK_FILENAME} is current`, verifyLockAgainstStore(lock, snap.manifest)));

    sections.push(section("audit-chain", "Audit chain", auditChainItems(snap.auditRows, snap.auditCheckpoint, governedCount, baseDir)));

    sections.push(
      section(
        "pending-operations",
        "Interrupted operations",
        snap.pending.map((p) => ({ outcome: "fail" as const, subject: p.component_id, message: `${p.operation} (${p.id}) started ${p.created_at} and never finished` }))
      )
    );

    sections.push(driftSection(snap, baseDir, lock));
    sections.push(verificationSection(snap));
    sections.push(toolsSection(baseDir));
  }

  const outcome = worst(sections.map((s) => s.outcome));
  const failing = outcome === "fail" || outcome === "error";
  const exitCode: 0 | 1 = failing || (strict && outcome === "skipped") ? 1 : 0;

  const count = (o: Outcome) => sections.reduce((n, s) => n + s.items.filter((i) => i.outcome === o).length, 0);
  const governed = read.state === "ok" ? read.snapshot.manifest.filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID).length : lockOnly && lock ? lock.components.length : 0;
  let summary: string;
  if (lockOnly && !failing && outcome !== "skipped") summary = `Check passed: ${governed} governed component(s) match ${LOCK_FILENAME}. The audit chain and verification status live in the local store and were not checked here.`;
  else if (lockOnly && failing) summary = `Check failed: ${count("fail") + count("error")} problem(s) across ${governed} governed component(s) listed in ${LOCK_FILENAME}.`;
  else if (lockOnly) summary = `Nothing wrong found, but not everything was verified: ${count("skipped")} item(s) skipped.`;
  else if (read.state === "absent" && lockDamaged.length > 0) summary = `Check failed: ${LOCK_FILENAME} is unreadable.`;
  else if (read.state === "absent") summary = "Nothing was checked: no Purix state in this directory.";
  else if (read.state === "damaged") {
    const problem = describeStoreProblem(read.detail, storeDirectory());
    summary = /damaged/.test(problem) ? "Could not check: the local store is damaged. Nothing was changed." : `Could not check: ${problem} Nothing was changed.`;
  }
  else if (governed === 0 && !failing) summary = "Nothing was checked: the store has no registered components.";
  else if (failing) summary = `Check failed: ${count("fail") + count("error")} problem(s) across ${governed} governed component(s).`;
  else if (outcome === "skipped") summary = `Nothing wrong found, but not everything was verified: ${count("skipped")} item(s) skipped across ${governed} governed component(s).`;
  else summary = `Check passed: ${governed} governed component(s) match what Purix recorded, and the audit chain is intact.`;

  return { schema: 1, outcome, strict, exitCode, sections, summary };
}

/** Exposed for tests and for the CLI's `--json`: the stable ordering of sections. The "lock" section is extra: it appears (after "store") only when the project keeps a purix.lock.json. */
export const CHECK_SECTION_ORDER: CheckSectionId[] = ["store", "audit-chain", "pending-operations", "drift", "verification", "tools"];
