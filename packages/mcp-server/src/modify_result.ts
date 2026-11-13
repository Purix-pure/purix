// packages/mcp-server/src/modify_result.ts
//
// AI-09 (PURIX-33): helpers for "approve the result, then apply the stored result" over MCP.
//
// purix_modify used to ask a person to approve an instruction sentence before any work existed, then ran a fresh
// model call that produced something nobody had seen. Now the server does the work first (classification, compile,
// sandbox verification, TrustGate; nothing is written to the project), files the result for approval, and applies
// exactly that stored result once a person has approved it.
//
// This module holds the pure parts: what the person is shown, what is stored, and the staleness check that stops a
// stored result from landing on files that moved since it was built. server.ts does the I/O.
import { createHash } from "node:crypto";
import { formatChangeSetDiff, formatFileDiff } from "@purix/core/cli-io/diff_format";
import { notCheckedMessage, notTestedMessage } from "@purix/core/verify/outcome";
import type { InfrastructureKind } from "@purix/core/verify/outcome";
import { couldNotCheckHeadline, excludedForSafetyMessage, partialLineMessage, partialPassLine, securityNotesMessages } from "@purix/core/verify/surface_text";

/** Largest stored result (final files plus diff text) the MCP path will file. Bigger changes go through the CLI. */
export const MAX_MODIFY_PAYLOAD_BYTES = 1_000_000;
/** Diff lines shown in the approval message; `purix approve --show <id>` prints all of them. */
export const APPROVAL_DIFF_LINES = 120;

export interface StoredOriginal {
  path: string;
  /** SHA-256 of the file content the result was built from. */
  sha256: string;
}

export interface ModifyResultPayload {
  kind: "mcp_modify_result";
  v: 1;
  componentId: string;
  /** The component's version when the result was built. */
  baseVersion: number;
  operation: string;
  contractChanged: boolean;
  fromEscalation: boolean;
  isolation: string | null;
  notTested: string[];
  /** F06-05: true when the search for tests stopped at its file limit, so a file in notTested may have a test that was never looked at. Absent when the search finished and in results stored before this field existed. */
  testSearchCut?: boolean;
  /** C3: which of notTested the cut search covered. Absent means all of them (and in results stored before this field existed). */
  testSearchCutFiles?: string[];
  /** Files in a language Purix has no checker for. Absent in results stored before this field existed. */
  notChecked?: string[];
  /** F01-06 / C3: credential-looking files left out of the verification copy. Absent when none, and in results stored before this field existed. */
  excludedForSafety?: string[];
  /** C4: findings that did not block, and files the security code rules did not read. */
  securityNotes?: { advisories?: { path: string; line: number; category: string }[]; notRead?: { path: string; reason: string }[] };
  /** F04-04: files where an edit's anchor started or ended inside a line, so the rest of that line was kept. Absent when none, and in results stored before this field existed. */
  partialLinePaths?: string[];
  decision: { action: "human_confirm" | "auto_commit"; reason: string };
  originals: StoredOriginal[];
  /** Files the result writes. A path not in `originals` is a new file. */
  finalFiles: { path: string; new_content: string }[];
  /** The complete diff text, so the CLI can show all of it. */
  diff: string;
  /** SHA-256 of `diff`. Recorded with the approval event. */
  diffHash: string;
}

export interface FileContent {
  path: string;
  content: string;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** Added and removed line counts for one file's diff, read off the rendered diff rows. */
function countChanges(rendered: string): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const line of rendered.split("\n")) {
    if (line.startsWith("+ ")) added++;
    else if (line.startsWith("- ")) removed++;
  }
  return { added, removed };
}

export interface BuildInput {
  agentId: string;
  componentId: string;
  instruction: string;
  baseVersion: number;
  operation: string;
  contractChanged: boolean;
  fromEscalation: boolean;
  isolation: string | undefined;
  notTested: string[] | undefined;
  /** F06-05: see ModifyResultPayload.testSearchCut. */
  testSearchCut?: boolean | undefined;
  /** C3: which of notTested the cut search covered; absent = all. */
  testSearchCutFiles?: string[] | undefined;
  notChecked?: string[] | undefined;
  /** F01-06 / C3: credential-looking files left out of the verification copy. */
  excludedForSafety?: string[] | undefined;
  /** C4: see ModifyResultPayload.securityNotes. */
  securityNotes?: { advisories?: { path: string; line: number; category: string }[] | undefined; notRead?: { path: string; reason: string }[] | undefined } | undefined;
  /** F04-04: see ModifyResultPayload.partialLinePaths. */
  partialLinePaths?: string[] | undefined;
  hasCoverage: boolean;
  decision: { action: "human_confirm" | "auto_commit"; reason: string };
  originalFiles: FileContent[];
  finalFiles: { path: string; new_content: string }[];
}

export interface BuiltResult {
  payload: ModifyResultPayload;
  /** Full text a person reads before answering (diff cut at APPROVAL_DIFF_LINES). */
  message: string;
  /** The short form: paths with counts, gate decision, coverage, hash. Returned to the agent. */
  summary: string;
  changedPaths: string[];
}

export function buildModifyResult(input: BuildInput): BuiltResult {
  const originalOf = (path: string) => input.originalFiles.find((o) => o.path === path)?.content ?? null;
  const changed = input.finalFiles.filter((f) => originalOf(f.path) !== f.new_content);
  const rows = changed.map((f) => ({ path: f.path, before: originalOf(f.path), after: f.new_content }));
  const diff = formatChangeSetDiff(rows);
  const diffHash = sha256Hex(diff);

  const fileLines = rows.map((r) => {
    const { added, removed } = countChanges(formatFileDiff(r));
    return `  ${r.path} (${r.before === null ? "new file, " : ""}+${added} / -${removed})`;
  });

  const notCheckedFiles = input.notChecked ?? [];
  const verification =
    input.isolation === undefined
      ? "Verification: no sandbox result was recorded."
      : notCheckedFiles.length > 0
        ? `Verification: ${partialPassLine({ checkedAny: input.finalFiles.some((f) => !notCheckedFiles.includes(f.path)), isolation: input.isolation })}`
        : `Verification: passed in a sandbox (isolation: ${input.isolation}).` +
          (input.isolation === "none" ? " Warning: this check ran without sandbox containment." : "");
  const unchecked = notCheckedMessage(notCheckedFiles);
  // One wording for "no test exercised this", shared with every other front door (single-point rule R7).
  const untested = notTestedMessage(input.notTested, { searchCut: input.testSearchCut === true, ...(input.testSearchCutFiles ? { cutFiles: input.testSearchCutFiles } : {}) });
  const partial = partialLineMessage(input.partialLinePaths);
  const excluded = excludedForSafetyMessage(input.excludedForSafety);
  const securityLines = securityNotesMessages(input.securityNotes?.advisories, input.securityNotes?.notRead);
  const coverage = input.hasCoverage ? "Tests cover the changed files." : "No test coverage was found for the changed files.";

  const summaryLines = [
    `Result for "${input.componentId}" (${input.operation}${input.contractChanged ? ", contract-changing" : ""}${input.fromEscalation ? ", escalation-authored" : ""}), built and checked; nothing is written yet:`,
    ...fileLines,
    `TrustGate: ${input.decision.action} — ${input.decision.reason}`,
    verification,
    ...(unchecked === undefined ? [] : [unchecked]),
    ...(untested === undefined ? [] : [untested]),
    ...(partial === undefined ? [] : [partial]),
    ...(excluded === undefined ? [] : [excluded]),
    ...securityLines,
    coverage,
    `Diff hash: ${diffHash.slice(0, 12)}`,
  ];
  const summary = summaryLines.join("\n");

  const diffLines = diff.split("\n");
  const shown = diffLines.slice(0, APPROVAL_DIFF_LINES);
  const more = diffLines.length - shown.length;
  const message =
    `MCP Agent "${input.agentId}" asked: "${input.instruction}"\n${summary}\n\n` +
    `Diff${more > 0 ? ` (first ${APPROVAL_DIFF_LINES} of ${diffLines.length} lines; "purix approve --show <id>" prints all of it)` : ""}:\n${shown.join("\n")}\n\n` +
    `Apply exactly this change to "${input.componentId}"?`;

  const payload: ModifyResultPayload = {
    kind: "mcp_modify_result",
    v: 1,
    componentId: input.componentId,
    baseVersion: input.baseVersion,
    operation: input.operation,
    contractChanged: input.contractChanged,
    fromEscalation: input.fromEscalation,
    isolation: input.isolation ?? null,
    notTested: input.notTested ?? [],
    ...(input.testSearchCut === true ? { testSearchCut: true } : {}),
    ...(input.testSearchCut === true && input.testSearchCutFiles ? { testSearchCutFiles: input.testSearchCutFiles } : {}),
    ...(notCheckedFiles.length > 0 ? { notChecked: notCheckedFiles } : {}),
    ...(input.excludedForSafety && input.excludedForSafety.length > 0 ? { excludedForSafety: input.excludedForSafety } : {}),
    ...(securityLines.length > 0 ? { securityNotes: { ...(input.securityNotes?.advisories?.length ? { advisories: input.securityNotes.advisories } : {}), ...(input.securityNotes?.notRead?.length ? { notRead: input.securityNotes.notRead } : {}) } } : {}),
    ...(input.partialLinePaths && input.partialLinePaths.length > 0 ? { partialLinePaths: input.partialLinePaths } : {}),
    decision: input.decision,
    originals: input.originalFiles.map((f) => ({ path: f.path, sha256: sha256Hex(f.content) })),
    finalFiles: input.finalFiles.map((f) => ({ path: f.path, new_content: f.new_content })),
    diff,
    diffHash,
  };
  return { payload, message, summary, changedPaths: changed.map((f) => f.path) };
}

/** The not-tested sentence printed when a stored result is applied, worded for a cut-off search when the stored result says so. Empty when nothing was left untested. */
export function appliedNotTestedLine(stored: Pick<ModifyResultPayload, "notTested" | "testSearchCut" | "testSearchCutFiles">): string {
  return stored.notTested.length ? (notTestedMessage(stored.notTested, { searchCut: stored.testSearchCut === true, ...(stored.testSearchCutFiles ? { cutFiles: stored.testSearchCutFiles } : {}) }) ?? "") : "";
}

/** Bytes the stored result takes (what the 1 MB limit is measured on). */
export function payloadBytes(payload: ModifyResultPayload): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf-8");
}

/** Reads a stored payload back, returning null for anything that is not exactly the shape written above. */
export function parseModifyResultPayload(value: unknown): ModifyResultPayload | null {
  if (value === null || typeof value !== "object") return null;
  const p = value as Partial<ModifyResultPayload>;
  const isStr = (x: unknown): x is string => typeof x === "string";
  if (p.kind !== "mcp_modify_result" || p.v !== 1) return null;
  if (!isStr(p.componentId) || typeof p.baseVersion !== "number" || !isStr(p.operation)) return null;
  if (typeof p.contractChanged !== "boolean" || typeof p.fromEscalation !== "boolean") return null;
  if (p.isolation !== null && !isStr(p.isolation)) return null;
  if (!Array.isArray(p.notTested) || !p.notTested.every(isStr)) return null;
  if (p.testSearchCut !== undefined && typeof p.testSearchCut !== "boolean") return null;
  if (p.testSearchCutFiles !== undefined && !(Array.isArray(p.testSearchCutFiles) && p.testSearchCutFiles.every((x) => typeof x === "string"))) return null;
  if (p.notChecked !== undefined && (!Array.isArray(p.notChecked) || !p.notChecked.every(isStr))) return null;
  if (p.excludedForSafety !== undefined && (!Array.isArray(p.excludedForSafety) || !p.excludedForSafety.every(isStr))) return null;
  if (p.partialLinePaths !== undefined && (!Array.isArray(p.partialLinePaths) || !p.partialLinePaths.every(isStr))) return null;
  if (!p.decision || (p.decision.action !== "human_confirm" && p.decision.action !== "auto_commit") || !isStr(p.decision.reason)) return null;
  if (!Array.isArray(p.originals) || !p.originals.every((o) => o && isStr(o.path) && isStr(o.sha256))) return null;
  if (!Array.isArray(p.finalFiles) || p.finalFiles.length === 0 || !p.finalFiles.every((f) => f && isStr(f.path) && isStr(f.new_content))) return null;
  if (!isStr(p.diff) || !isStr(p.diffHash) || sha256Hex(p.diff) !== p.diffHash) return null;
  return p as ModifyResultPayload;
}

/**
 * Null when the project still matches what the result was built from; otherwise the reason it no longer does.
 * `currentVersion` is the manifest version now, `current` the component files as they are on disk now, and
 * `exists` tells whether a path that the result would create already exists.
 */
export function staleReason(payload: ModifyResultPayload, currentVersion: number, current: FileContent[], exists: (path: string) => boolean): string | null {
  if (currentVersion !== payload.baseVersion) return `the component is now at v${currentVersion}, the result was built on v${payload.baseVersion}`;
  for (const o of payload.originals) {
    const now = current.find((c) => c.path === o.path);
    if (!now) return `${o.path} is no longer on disk`;
    if (sha256Hex(now.content) !== o.sha256) return `${o.path} changed after the result was built`;
  }
  for (const f of payload.finalFiles) {
    if (!payload.originals.some((o) => o.path === f.path) && exists(f.path)) return `${f.path} now exists, but the result would create it`;
  }
  return null;
}

/**
 * What an agent is told when the change was stopped. A check that could not run (tool missing, timeout, unsupported language) is said
 * in those words, not as "verification and escalation both failed", which would send the agent off to fix code that is not broken.
 * `codeFailureLead` is the old lead-in, kept for a real failure of the code.
 */
export function verificationFailureText(codeFailureLead: string, f: { reason?: string; infrastructure?: { kind: InfrastructureKind; actionHint?: string } }): string {
  const reason = f.reason ?? "unknown reason";
  if (!f.infrastructure) return `${codeFailureLead}: ${reason}. No real files were touched.`;
  const hint = f.infrastructure.actionHint && !reason.includes(f.infrastructure.actionHint) ? `\n${f.infrastructure.actionHint}` : "";
  return `${couldNotCheckHeadline(f.infrastructure.kind)}\n${reason}${hint}\nNo real files were touched.`;
}
