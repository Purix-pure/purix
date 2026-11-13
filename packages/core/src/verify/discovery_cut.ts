// packages/core/src/verify/discovery_cut.ts
//
// F06-05 (re-check, 2026-11-07): test discovery stops after a fixed number of files and sets `truncated`, and nothing downstream read the
// flag. A project past the limit could read "no test covers X" or a clean pass when the test for X sat in the part never looked at.
// This is the one place that words that case, so the JavaScript and Python providers and the sandbox say the same thing.
// (The words "not tested" are reserved for verify/outcome.ts by the single-point check, so they are not used here.)

export const TEST_SEARCH_CUT_NOTE = "the search for tests stopped at its file limit, so a test for this change may exist that was never looked at";

/** The reason, with the cut-off sentence added when the search was cut. Unchanged when it finished. */
export function withCutNote(reason: string, truncated: boolean): string {
  return truncated ? `${reason}. Note: ${TEST_SEARCH_CUT_NOTE}` : reason;
}

/**
 * The part of a verification_pass event's detail that records a cut-off search: `{ test_search_cut: true }`, or nothing when the
 * search finished. Spread into the detail at every place that records a passing verification, so the stored record, `purix check`
 * and the evidence report can say the search was cut instead of "no test is related".
 */
export function searchCutDetail(v: { testSearchCut?: boolean; testSearchCutFiles?: string[] }): { test_search_cut?: true; test_search_cut_files?: string[] } {
  if (!v.testSearchCut) return {};
  // C3: which untested files the cut search covered (one language's search can be cut while another's finished). Absent in records written before this.
  return v.testSearchCutFiles && v.testSearchCutFiles.length > 0 ? { test_search_cut: true, test_search_cut_files: [...v.testSearchCutFiles] } : { test_search_cut: true };
}

/**
 * C4 follow-up: the part of a verification_pass event's detail that records what the security gate saw and did not block
 * (`security_advisories`) and the files its code rules did not read (`security_not_read`), so `purix check` can say so later. Capped; nothing when empty.
 */
export function securityNotesDetail(v: { securityAdvisories?: { path: string; line: number; category: string }[]; securityNotRead?: { path: string }[] }): { security_advisories?: { path: string; line: number; category: string }[]; security_not_read?: string[] } {
  return {
    ...(v.securityAdvisories && v.securityAdvisories.length > 0 ? { security_advisories: v.securityAdvisories.slice(0, 10).map((f) => ({ path: f.path, line: f.line, category: f.category })) } : {}),
    ...(v.securityNotRead && v.securityNotRead.length > 0 ? { security_not_read: v.securityNotRead.slice(0, 20).map((n) => n.path) } : {}),
  };
}

/** The security notes a stored event carries, in the shape securityNotesMessages reads. */
export function detailSecurityNotes(detail: Record<string, unknown> | undefined): { advisories: { path: string; line: number; category: string }[]; notRead: { path: string; reason: string }[] } {
  const adv = detail?.["security_advisories"];
  const unread = detail?.["security_not_read"];
  return {
    advisories: Array.isArray(adv) ? adv.filter((x): x is { path: string; line: number; category: string } => !!x && typeof x === "object" && typeof (x).path === "string" && typeof (x).category === "string").map((x) => ({ path: x.path, line: typeof x.line === "number" ? x.line : 0, category: x.category })) : [],
    notRead: Array.isArray(unread) ? unread.filter((x): x is string => typeof x === "string").map((path) => ({ path, reason: "" })) : [],
  };
}

/** The untested files a stored event's cut search covered, or undefined when the record has no list (then a cut search covers all of its not_tested files). */
export function detailSearchCutFiles(detail: Record<string, unknown> | undefined): string[] | undefined {
  const raw = detail?.["test_search_cut_files"];
  return Array.isArray(raw) && raw.every((x) => typeof x === "string") && raw.length > 0 ? (raw) : undefined;
}

/** True when a stored verification_pass event's detail says its test search was cut. Anything but the boolean `true` is read as "not cut". */
export function detailSaysSearchCut(detail: Record<string, unknown> | undefined): boolean {
  return detail?.["test_search_cut"] === true;
}

/**
 * The changed files a cut-off search cannot vouch for: all of them. Empty when the search finished or there was no discovery.
 * The sandbox adds these to the files reported as not covered, so a change that depended on a cut-off search reads as partial.
 */
export function changedFilesNotVouchedFor(discovery: { truncated: boolean } | undefined, changed: string[]): string[] {
  return discovery?.truncated ? [...changed] : [];
}
