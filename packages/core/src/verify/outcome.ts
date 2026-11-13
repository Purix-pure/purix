// src/verify/outcome.ts
//
// One vocabulary for "how did a check go", and one wording for "this was not tested".
//
// Today the code speaks several dialects: verification says pass / fail / not_installed, the test
// runner says pass / fail / no_tests / not_installed, the manifest stores pass / fail / pending, and the
// gate has its own actions. A report that mixes them has to guess, and a guess that rounds "skipped" up
// to "pass" is exactly the false confidence this project exists to prevent.
//
// This module is also the ONLY place the words "not tested" are written for a person (ratchet rule R7 enforces it).
//
// This module defines the target vocabulary (see docs/ADR-DRAFT-result-vocabulary.md, status: Proposed)
// and maps today's values onto it for DISPLAY. It changes nothing that is stored: events and manifest
// rows keep their current values until the ADR is ratified.
//
// The one rule: a check that was skipped or errored never renders as passing.
import type { VerificationResult } from "./verify.js";
import type { TestRunResult } from "./tests.js";
import type { SpawnStop, SpawnSyncResult } from "../platform/spawn_sync.js";

export type Outcome = "pass" | "fail" | "skipped" | "error" | "not-applicable";

// ---------------------------------------------------------------------------------------------------------------------
// A1 shared rail: the result KINDS the other phases consume. Additive: nothing stored changes, and no existing union grows.
//
// Why: today a missing tool, a timeout, an output overflow and an unsupported language all travel as "the code failed" (research
// 07 rule B, research 02, research 10), so the repair loop spends model calls on a problem no edit can fix. These kinds separate
// "your code failed" from "Purix could not run the check". The producers (sandbox, runners, repair loop) adopt them in their own
// phases (A4, A6, A8, A10); A1 only defines them and maps today's values onto them, so a phase that has not landed is not broken.
// ---------------------------------------------------------------------------------------------------------------------

/** Purix could not run the check. Never a failure of the code, so never worth a repair attempt. */
export type InfrastructureKind = "not_installed" | "timeout" | "output_limit" | "sandbox_unavailable" | "resource_limit" | "unsupported_language";

/**
 * pass: the check ran and the code satisfied it.
 * fail: the check ran and the CODE failed it. The only kind a repair can act on.
 * infrastructure: Purix could not run the check (InfrastructureKind says why).
 * not_run: the check was never attempted (for example, no provider claims the file's language).
 * no_tests_ran / all_skipped: a test runner started and exercised nothing, whatever its exit code said. A6 produces these.
 */
export type CheckKind = "pass" | "fail" | "infrastructure" | "not_run" | "no_tests_ran" | "all_skipped";

export type CheckResult =
  | { kind: "pass" }
  | { kind: "fail"; reason: string }
  | { kind: "infrastructure"; infrastructure: InfrastructureKind; reason: string; actionHint?: string }
  | { kind: "not_run"; reason: string }
  | { kind: "no_tests_ran"; reason?: string }
  | { kind: "all_skipped"; skipped?: number; reason?: string };

/** Only a failure of the code is worth a repair. Everything else, including "no tests ran", is not something an edit can fix. */
export function isRepairEligibleKind(kind: CheckKind): boolean {
  return kind === "fail";
}

/**
 * How a spawn ended -> the infrastructure kind. A start that failed for any other reason counts as "not_installed": the tool could not be started.
 * A child ended by a signal has NO kind: nothing observed says whether the machine or the code ended it, so it is not labelled.
 */
export function infrastructureKindOfStop(stopped: SpawnStop): InfrastructureKind | undefined {
  switch (stopped) {
    case "signal": return undefined;
    case "timeout": return "timeout";
    case "output_limit": return "output_limit";
    case "resource_limit": return "resource_limit";
    case "not_found": return "not_installed";
    case "spawn_error": return "not_installed";
  }
}

/**
 * The infrastructure result for a spawn that was stopped, or undefined when it ended normally (whatever its exit code). `what`
 * names the thing that was running, for the message ("TypeScript compile", "pytest").
 */
export function infrastructureResultOfSpawn(result: Pick<SpawnSyncResult, "stopped">, what: string): Extract<CheckResult, { kind: "infrastructure" }> | undefined {
  if (!result.stopped) return undefined;
  const infrastructure = infrastructureKindOfStop(result.stopped);
  if (infrastructure === undefined) return undefined;
  const reason =
    infrastructure === "timeout" ? `${what} was stopped because it ran past its time limit. This is not a failure of your code.`
    : infrastructure === "output_limit" ? `${what} was stopped because it printed more than its output limit. This is not a failure of your code.`
    : infrastructure === "resource_limit" ? `${what} could not run because the machine was out of a resource (memory, file handles or processes). This is not a failure of your code.`
    : `${what} could not be started. This is not a failure of your code.`;
  return { kind: "infrastructure", infrastructure, reason };
}

/**
 * What a stopped run means for the person, or undefined when the run ended normally (whatever its exit code). F02-03.
 *
 * A timeout is deliberately NOT labelled infrastructure. The machine may be slow, but new code can also loop forever, and a label would
 * tell the repair loop "this is not your change" and stop it for good. Left unlabelled, its words ("timed out") reach the loop's existing
 * rule for an ambiguous timeout (recovery/resolve_verification.ts), which confirms against the original code before deciding. An output
 * overflow, a resource limit and a program that could not start say nothing about the change, so those are labelled and never repaired.
 */
export function failureOfStoppedRun(result: Pick<SpawnSyncResult, "stopped" | "signal">, what: string): { reason: string; infrastructure?: InfrastructureKind } | undefined {
  if (!result.stopped) return undefined;
  if (result.stopped === "timeout") {
    return { reason: `${what} timed out: it was stopped after it ran past its time limit. Purix cannot tell from this whether the machine is slow or the code never finishes.` };
  }
  if (result.stopped === "signal") {
    // Like a timeout, not labelled: an outside kill (for example the machine's memory limit) and code that ends its own process look the
    // same from here. The words say so, and make no claim about whose fault it is.
    const sig = (result as { signal?: string }).signal;
    return { reason: `${what} was ended by a signal${sig ? ` (${sig})` : ""} before it finished. Purix cannot tell from this whether something outside (for example the machine running out of memory) or the code itself did it.` };
  }
  const infra = infrastructureResultOfSpawn(result, what)!;
  return { reason: infra.reason, infrastructure: infra.infrastructure };
}

/** Today's verification result -> kind. A pass stays "pass" here (the "checked but unexercised" wording is verificationOutcome's job). */
export function checkKindOfVerification(v: Pick<VerificationResult, "status"> & { infrastructure?: InfrastructureKind }): CheckKind {
  switch (v.status) {
    case "pass": return "pass";
    case "not_installed": return "infrastructure";
    case "fail": return v.infrastructure ? "infrastructure" : "fail";
  }
}

/** Today's test-run status -> kind. "no_tests" is "no_tests_ran": nothing was exercised, so it is neither a pass nor a code failure. */
export function checkKindOfTestRun(status: TestRunResult["status"]): CheckKind {
  switch (status) {
    case "pass": return "pass";
    case "fail": return "fail";
    case "no_tests": return "no_tests_ran";
    case "not_installed": return "infrastructure";
  }
}

/**
 * Should the repair loop try to fix this verification result? Only a code failure that is not a security block. A policy block
 * is a deliberate stop (no model call can fix it), and an infrastructure failure is not about the code.
 * NOTE: recovery/resolve_verification.ts does not use this yet (A8 owns it), so today a missing tool still reaches repair.
 */
export function isRepairEligibleVerification(v: VerificationResult): boolean {
  if (v.status !== "fail") return false;
  if (v.policyBlock) return false;
  return checkKindOfVerification(v) === "fail";
}

/** Test-runner status -> outcome. "no_tests" is a skip (nothing exercised the code), never a pass. */
export function testRunOutcome(status: TestRunResult["status"]): Outcome {
  switch (status) {
    case "pass": return "pass";
    case "fail": return "fail";
    case "no_tests": return "skipped";
    case "not_installed": return "error";
  }
}

/**
 * Overall verification -> outcome. A pass that left changed files with no related test is "skipped":
 * the code compiled, but a required check (the tests) did not run on it. The caller decides what to do
 * with that (today: commit proceeds, as before); the word it must show is not "pass".
 */
export function verificationOutcome(v: Pick<VerificationResult, "status"> & { notTested?: string[]; notChecked?: string[]; infrastructure?: InfrastructureKind }): Outcome {
  switch (v.status) {
    case "fail": return v.infrastructure ? "error" : "fail";
    case "not_installed": return "error";
    case "pass": return (v.notTested && v.notTested.length > 0) || (v.notChecked && v.notChecked.length > 0) ? "skipped" : "pass";
  }
}

const MAX_LISTED = 5;

/** "a.ts, b.ts and 3 more", so a long list cannot bury the line that carries it. */
export function listFiles(files: string[]): string {
  const unique = [...new Set(files)];
  if (unique.length <= MAX_LISTED) return unique.join(", ");
  return `${unique.slice(0, MAX_LISTED).join(", ")} and ${unique.length - MAX_LISTED} more`;
}

/**
 * The one sentence for "no test exercised these files". The word is "not tested", never "clean" or
 * "verified": the files compiled, and that is all that is known.
 */
export function notTestedMessage(files: string[] | undefined, opts?: { searchCut?: boolean; cutFiles?: readonly string[] }): string | undefined {
  if (!files || files.length === 0) return undefined;
  // C3: a cut search can cover only some files (one language's search was cut, another's finished). Say each group in its own words.
  if (opts?.searchCut && opts.cutFiles && opts.cutFiles.length > 0) {
    const cut = new Set(opts.cutFiles);
    const unique = [...new Set(files)];
    const cutPart = unique.filter((f) => cut.has(f));
    const plainPart = unique.filter((f) => !cut.has(f));
    if (plainPart.length > 0 && cutPart.length > 0) {
      return `${notTestedMessage(plainPart)} ${notTestedMessage(cutPart, { searchCut: true })}`;
    }
  }
  // F06-05: when the search for tests hit its file limit, "no test is related" would be a claim nobody checked. Say what happened.
  if (opts?.searchCut) {
    return `Not tested: the search for tests stopped at its file limit, so no test could be shown to cover ${listFiles(files)}. It compiled, but nothing was shown to exercise it.`;
  }
  return `Not tested: no test is related to ${listFiles(files)}. It compiled, but nothing exercised it.`;
}

/**
 * A10a-1: the one sentence for files in a language Purix has no provider for. Unlike "not tested", nothing ran on them at all:
 * no compiler, no tests. The word is "not checked"; it never says "compiled", "clean" or "passed".
 */
export function notCheckedMessage(files: string[] | undefined): string | undefined {
  if (!files || files.length === 0) return undefined;
  return `Unsupported language, not checked: Purix has no checker for ${listFiles(files)}. Nothing was compiled or tested.`;
}

/** The same sentence, lower-cased, for use inside a report line (`purix check`) rather than as a sentence of its own. */
export function notTestedInline(files: string[] | undefined, opts?: { searchCut?: boolean; cutFiles?: readonly string[] }): string | undefined {
  const m = notTestedMessage(files, opts);
  return m === undefined ? undefined : m.charAt(0).toLowerCase() + m.slice(1);
}

/** The one sentence for a component that was only created: compiled, no test run, stored status "pending". */
export function pendingNotTestedMessage(): string {
  return "Not tested: the starter files compile, but no test has run on them (status: pending).";
}

/** The value of the Purix-Not-Tested git trailer: how many distinct files compiled but were never exercised. */
export function notTestedValue(files: string[]): string {
  return `${new Set(files).size} file(s)`;
}

/** A short marker for list views (`purix status`), so a green-looking row still says a gap exists. */
export function notTestedBadge(files: string[], opts?: { searchCut?: boolean; cutFiles?: string[] }): string {
  const all = new Set(files);
  // C3: when the record says which files the cut covered and that is only some of them, say how many instead of implying all.
  const cutCount = opts?.cutFiles ? [...all].filter((f) => opts.cutFiles!.includes(f)).length : all.size;
  const cutWords = !opts?.searchCut || cutCount === 0 ? "" : cutCount < all.size ? `, search for tests stopped at its file limit for ${cutCount} of them` : ", search for tests stopped at its file limit";
  return `not tested: ${all.size} file(s)${cutWords}`;
}

/**
 * Display label for a stored manifest status. "pending" is written by create (a compile check only) and
 * adopt (registers existing files, runs nothing): in both, no test has run, and the label says so.
 */
export function storedStatusLabel(status: string): string {
  return status === "pending" ? "pending, not tested" : status;
}
