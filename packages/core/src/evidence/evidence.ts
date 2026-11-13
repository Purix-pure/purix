// src/evidence/evidence.ts
//
// G10: evidence a reviewer can use without trusting Purix or reading the session. Three outputs, one source:
//   1. a bundle (the audit chain rows plus a per-component summary), checked by the standalone verifier
//      (packages/cli/verifier/purix-evidence-verify.mjs), which shares no code with Purix;
//   2. a git trailer block, so a commit carries the chain head it was made under (the anchor);
//   3. a pull-request report in Markdown.
//
// What this proves, stated plainly (the report repeats it):
//   - The audit chain was not altered or cut back after the head hash in the trailer was published.
//   - It does NOT prove the tests were meaningful, that the model was right, or who wrote a line.
//   - Someone who can rewrite the whole local store can rewrite the whole chain. The trailer is what stops that:
//     once the commit is pushed, the head hash is held by git history, not by the local store.
//
// Read-only: it uses readStoreSnapshot (no writes, no migration, no model, no network).
import { CODEBASE_INDEX_COMPONENT_ID } from "../manifest/adopt.js";
import { readStoreSnapshot, type StoreSnapshot } from "../manifest/store.js";
import { verifyAuditRows, type AuditVerification } from "../security/audit_tamper_evidence.js";
import { notTestedMessage, notTestedValue, storedStatusLabel, type Outcome } from "../verify/outcome.js";
import { detailSaysSearchCut, detailSearchCutFiles } from "../verify/discovery_cut.js";
import { partialLineMessage } from "../verify/surface_text.js";

export const EVIDENCE_SCHEMA = "purix.evidence/1" as const;
export const GENESIS_HASH = "0".repeat(64);

export interface EvidenceComponent {
  id: string;
  version: number | string;
  /** Stored verification status: pass, fail or pending. */
  status: string;
  files: string[];
  /** Files the latest passing verification left untested (empty when none or unknown). */
  not_tested: string[];
  /** F06-05: present (true) only when the latest passing verification's search for tests stopped at its file limit, so `not_tested` may include files that do have a test. Absent otherwise. */
  test_search_cut?: true;
  /** C3: with test_search_cut, which of `not_tested` the cut search covered. Absent means all of them (and in bundles from before this field). */
  test_search_cut_files?: string[];
  /** F04-04: present only when the latest passing verification followed an edit whose anchor started or ended inside a line, so the rest of that line was kept. A review note: it does not change the outcome. Lists the files. */
  partial_line?: string[];
}

export interface EvidenceBundle {
  schema: typeof EVIDENCE_SCHEMA;
  generated_at: string;
  chain: {
    rows: StoreSnapshot["auditRows"];
    checkpoint: StoreSnapshot["auditCheckpoint"];
  };
  /** Hash of the newest chain record, or the genesis hash for an empty chain. */
  head: { hash: string; record_count: number };
  components: EvidenceComponent[];
}

export type EvidenceResult =
  | { state: "ok"; bundle: EvidenceBundle }
  | { state: "absent" }
  | { state: "damaged"; detail: string };

function latestNotTested(snapshot: StoreSnapshot): { gaps: Map<string, string[]>; cut: Set<string>; cutFiles: Map<string, string[]> } {
  const m = new Map<string, string[]>();
  const cut = new Set<string>();
  const cutFiles = new Map<string, string[]>();
  for (const e of snapshot.verificationPasses) {
    if (!e.component_id) continue;
    const raw = e.detail["not_tested"];
    const files = Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
    if (files.length > 0) m.set(e.component_id, files);
    else m.delete(e.component_id);
    if (files.length > 0 && detailSaysSearchCut(e.detail)) cut.add(e.component_id);
    else cut.delete(e.component_id);
    const cf = files.length > 0 ? detailSearchCutFiles(e.detail) : undefined;
    if (cf) cutFiles.set(e.component_id, cf); else cutFiles.delete(e.component_id);
  }
  return { gaps: m, cut, cutFiles };
}

export function bundleFromSnapshot(snapshot: StoreSnapshot, now: Date = new Date()): EvidenceBundle {
  const { gaps, cut, cutFiles } = latestNotTested(snapshot);
  const rows = snapshot.auditRows;
  return {
    schema: EVIDENCE_SCHEMA,
    generated_at: now.toISOString(),
    chain: { rows, checkpoint: snapshot.auditCheckpoint },
    head: { hash: rows.length > 0 ? rows[rows.length - 1]!.hash : GENESIS_HASH, record_count: rows.length },
    // F05-09: the index row lists files; it is not a governed component, so its status does not enter the bundle.
    components: snapshot.manifest
      .filter((e) => e.component_id !== CODEBASE_INDEX_COMPONENT_ID)
      .map((e) => ({
        id: e.component_id,
        version: e.current_version,
        status: e.verification_status,
        files: [...(e.files ?? [])],
        not_tested: e.verification_status === "pass" ? (gaps.get(e.component_id) ?? []) : [],
        ...(e.verification_status === "pass" && cut.has(e.component_id) ? { test_search_cut: true as const } : {}),
        ...(e.verification_status === "pass" && cut.has(e.component_id) && cutFiles.has(e.component_id) ? { test_search_cut_files: [...cutFiles.get(e.component_id)!] } : {}),
        ...(e.verification_status === "pass" && (snapshot.partialLine?.[e.component_id]?.length ?? 0) > 0 ? { partial_line: [...snapshot.partialLine![e.component_id]!] } : {}),
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  };
}

/** Builds the bundle from the project's store, read-only. */
export function buildEvidenceBundle(now: Date = new Date()): EvidenceResult {
  const r = readStoreSnapshot();
  if (r.state !== "ok") return r;
  return { state: "ok", bundle: bundleFromSnapshot(r.snapshot, now) };
}

/** Worst outcome across components: fail > skipped (pending or untested files) > pass; nothing governed is not-applicable. */
export function overallOutcome(components: EvidenceComponent[]): Outcome {
  if (components.length === 0) return "not-applicable";
  if (components.some((c) => c.status === "fail")) return "fail";
  if (components.some((c) => c.status === "pending" || c.not_tested.length > 0)) return "skipped";
  return "pass";
}

export function verifyBundleChain(bundle: EvidenceBundle): AuditVerification {
  return verifyAuditRows(bundle.chain.rows, bundle.chain.checkpoint);
}

/** Git trailer lines for a commit message. The head hash is the anchor the independent verifier checks. */
export function trailerLines(bundle: EvidenceBundle): string[] {
  const outcome = overallOutcome(bundle.components);
  const untested = new Set(bundle.components.flatMap((c) => c.not_tested.map((f) => `${c.id}:${f}`)));
  const lines = [
    `Purix-Evidence: sha256:${bundle.head.hash}`,
    `Purix-Records: ${bundle.head.record_count}`,
    `Purix-Verified: ${outcome}`,
  ];
  if (untested.size > 0) lines.push(`Purix-Not-Tested: ${notTestedValue([...untested])}`);
  return lines;
}

const TRAILER_KEYS = ["Purix-Evidence", "Purix-Records", "Purix-Verified", "Purix-Not-Tested"];

/**
 * Returns the commit message with exactly one set of Purix trailers: earlier Purix trailers are replaced, other trailers
 * are kept, and the block goes in the message's last paragraph as git expects. Idempotent.
 */
export function applyTrailers(message: string, lines: string[]): string {
  const eol = message.includes("\r\n") ? "\r\n" : "\n";
  const kept = message.replace(/\r\n/g, "\n").split("\n").filter((l) => !TRAILER_KEYS.some((k) => l.startsWith(`${k}:`)));
  while (kept.length > 0 && kept[kept.length - 1]!.trim() === "") kept.pop();
  if (kept.length === 0) return lines.join(eol) + eol;
  // Comment lines (git's template) are not part of the message body for trailer purposes; keep them where they are.
  const lastBlockStart = (() => {
    let i = kept.length - 1;
    while (i >= 0 && kept[i]!.trim() !== "") i--;
    return i + 1;
  })();
  const lastBlock = kept.slice(lastBlockStart);
  const isTrailerBlock = lastBlock.length > 0 && lastBlockStart > 0 && lastBlock.every((l) => /^[A-Za-z][A-Za-z0-9-]*:\s/.test(l));
  const body = isTrailerBlock ? [...kept, ...lines] : [...kept, "", ...lines];
  return body.join(eol) + eol;
}

function md(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

/** The pull-request report. Plain Markdown, left-aligned, no HTML. */
export function renderPrReport(bundle: EvidenceBundle, verification: AuditVerification): string {
  const outcome = overallOutcome(bundle.components);
  const out: string[] = [];
  out.push("## Purix verification report", "");
  const headline: Record<Outcome, string> = {
    pass: "Every governed component passed verification, and no file was left untested.",
    fail: "At least one governed component failed its last verification.",
    skipped: "Something was not verified: a component is pending, or a file compiled but no test exercised it.",
    error: "A check could not run.",
    "not-applicable": "Purix governs no components in this project, so nothing here was verified.",
  };
  out.push(`**Result: ${outcome}.** ${headline[outcome]}`, "");
  if (bundle.components.length > 0) {
    out.push("| Component | Version | Status | Files |", "|---|---|---|---|");
    for (const c of bundle.components) {
      out.push(`| ${md(c.id)} | ${c.version} | ${md(storedStatusLabel(c.status))} | ${c.files.length} |`);
    }
    out.push("");
  }
  const gaps = bundle.components.filter((c) => c.not_tested.length > 0);
  const pending = bundle.components.filter((c) => c.status === "pending");
  if (gaps.length > 0 || pending.length > 0) {
    out.push("### Not verified", "");
    for (const c of pending) out.push(`- \`${c.id}\`: no test has run on it (status: pending).`);
    for (const c of gaps) out.push(`- \`${c.id}\`: ${notTestedMessage(c.not_tested, { searchCut: c.test_search_cut === true, ...(c.test_search_cut_files ? { cutFiles: c.test_search_cut_files } : {}) })}`);
    out.push("");
  }
  const partialLine = bundle.components.filter((c) => (c.partial_line?.length ?? 0) > 0);
  if (partialLine.length > 0) {
    out.push("### Review notes", "");
    for (const c of partialLine) out.push(`- \`${c.id}\`: ${partialLineMessage(c.partial_line)}`);
    out.push("");
  }
  out.push("### Evidence", "");
  out.push(`- Audit chain: ${verification.valid ? `intact, ${verification.recordCount ?? bundle.head.record_count} record(s)` : `**not intact**: ${verification.reason ?? "unknown reason"}`}`);
  out.push(`- Chain head: \`${bundle.head.hash}\``);
  out.push(`- Generated: ${bundle.generated_at}`);
  out.push("", "To check this without trusting Purix, run the standalone verifier on the exported bundle and the commit:", "");
  out.push("```", "node purix-evidence-verify.mjs bundle.json --commit HEAD", "```", "");
  out.push("### What this does and does not show", "");
  out.push("- It shows the local audit record was not altered after the chain head above was committed.");
  out.push("- It does not show the tests were meaningful, the code is correct, or who wrote a given line.");
  out.push("- A person with access to the store could rewrite the whole chain; the head hash in the commit is what makes that visible.");
  return out.join("\n") + "\n";
}
