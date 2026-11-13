// packages/core/src/verify/surface_text.ts
//
// Release 1 surface (completion audit, "next job"): the words the CLI and the MCP server print when a check did NOT simply pass or fail.
// Core already produces these results (A1 kinds, A4-1 sandbox failures, A8-1 stops, A10a-1 unsupported language); until now neither front door
// printed them, so a Go file or a missing tool read the same as a clean run. Both front doors call this one module so they say the same thing.
//
// Rules: a "not checked" file is never called compiled, clean or passed. "Could not check" is never called a failure of the code.
// The words "not tested" are NOT written here (single-point rule R7); they stay in outcome.ts.
import type { InfrastructureKind } from "./outcome.js";

const WHY: Record<InfrastructureKind, string> = {
  not_installed: "a tool it needs is not installed",
  timeout: "the check ran past its time limit",
  output_limit: "the check printed more than its output limit",
  sandbox_unavailable: "the sandbox could not be used",
  resource_limit: "the machine ran out of a resource (memory, file handles or processes)",
  unsupported_language: "Purix has no checker for this language",
};

/** The one-line headline for a change that was stopped because the check could not run. Says it is not a failure of the code. */
export function couldNotCheckHeadline(kind: InfrastructureKind | undefined): string {
  if (kind === "unsupported_language") return "Not checked: unsupported language. Purix could not check this change, and that is not a failure of your code.";
  const why = kind ? WHY[kind] : "the check could not run";
  return `Could not check: ${why}. This is not a failure of your code, and nothing was repaired.`;
}

/** The sentence for a pass that left some changed files unchecked (unsupported language). Never "passed" for those files. */
export function partialPassLine(opts: { checkedAny: boolean; isolation: string | undefined }): string {
  const where = opts.isolation === undefined ? "" : ` (isolation: ${opts.isolation})`;
  return opts.checkedAny
    ? `Verification passed in the sandbox${where} for the files Purix supports. The files listed as not checked were not verified.`
    : `Nothing was verified${where}.`;
}

/**
 * F04-04 (research 04, finding 4): an exact anchor that starts or ends in the middle of a line replaces only the matched part, so the
 * rest of that line stays. A truncated anchor looks exactly like this (145 of 145 trials applied and left the tail), and so does a
 * legitimate edit inside a line; Purix cannot tell them apart, so it says so and does not block. Undefined when no edit was partial.
 */
export function partialLineMessage(paths: readonly string[] | undefined): string | undefined {
  if (!paths || paths.length === 0) return undefined;
  const shown = paths.slice(0, 3).join(", ");
  const more = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  return `Edited inside a line in ${shown}${more}: the text to replace started or ended partway through a line, so the rest of that line was kept. Check those lines still read as intended.`;
}

/**
 * C4: what the security gate saw and did not block, in one or two lines: findings that did not block (an old finding, an unreadable manifest,
 * an over-long line) and the files its code rules did not read (documentation, data, configuration). The secret scan reads every file.
 * Empty when there is nothing to say.
 */
export function securityNotesMessages(
  advisories: readonly { path: string; line: number; category: string }[] | undefined,
  notRead: readonly { path: string; reason: string }[] | undefined,
): string[] {
  const out: string[] = [];
  // F03-02: the dependency notes get their own wording. "Dependency Check in package.json:1" says nothing to a reader; what matters is that
  // the dependencies this change adds were NOT checked (not that they are clean), or that one has known advisories.
  const depNot = (advisories ?? []).filter((f) => f.category === "Dependency Check");
  const depKnown = (advisories ?? []).filter((f) => f.category === "Known Vulnerability");
  const rest = (advisories ?? []).filter((f) => f.category !== "Dependency Check" && f.category !== "Known Vulnerability");
  if (rest.length > 0) {
    const shown = rest.slice(0, 3).map((f) => `${f.category} in ${f.path}:${f.line}`).join(", ");
    const more = rest.length > 3 ? ` and ${rest.length - 3} more` : "";
    out.push(`Security advisories (did not block): ${rest.length} — ${shown}${more}.`);
  }
  if (depKnown.length > 0) {
    const files = [...new Set(depKnown.map((f) => f.path))].slice(0, 3).join(", ");
    out.push(`Dependencies this change adds have known vulnerabilities (${depKnown.length}) in ${files}. The change was not blocked; check them before relying on it.`);
  }
  if (depNot.length > 0) {
    const files = [...new Set(depNot.map((f) => f.path))].slice(0, 3).join(", ");
    out.push(`Dependencies this change adds or changes were not checked for known vulnerabilities (${files}). That is not a clean result: run \`purix audit\` before relying on them.`);
  }
  if (notRead && notRead.length > 0) {
    const shown = notRead.slice(0, 5).map((n) => n.path).join(", ");
    const more = notRead.length > 5 ? ` and ${notRead.length - 5} more` : "";
    out.push(`Security code rules did not read ${notRead.length} file(s): ${shown}${more} (documentation, data or configuration). Secrets are still scanned in every file.`);
  }
  return out;
}

/**
 * F01-06 / C3: files that looked like credentials (.env, .npmrc, *.pem, ...) are left out of the copy a change is verified in. A build or
 * test that needs one of them ran without it, so a pass does not cover that. Before, this reached a person only inside a FAILURE reason.
 * Undefined when nothing was left out.
 */
export function excludedForSafetyMessage(files: readonly string[] | undefined): string | undefined {
  if (!files || files.length === 0) return undefined;
  const shown = files.slice(0, 5).join(", ");
  const more = files.length > 5 ? ` and ${files.length - 5} more` : "";
  return `Left out of the verification copy for safety: ${shown}${more} (credential-looking files). A build or test that needs one of them ran without it, so this pass does not cover that.`;
}

