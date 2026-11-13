// src/verify/impact.ts
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema.js";
import { readManifest, writeManifest } from "../manifest/store.js";
import { getLanguageProvider, languageForFile } from "../language/registry.js";
import { recordEvent } from "../manifest/events.js";
import { makeVerificationCopy } from "../sandbox/sandbox.js";
import type { InfrastructureKind } from "./outcome.js";

export interface DependentImpact {
  component_id: string;
  files: string[];
}

export function getDependents(entry: ManifestEntry): DependentImpact[] {
  return (entry.depended_on_by ?? [])
    .map((id) => readManifest(id))
    .filter((e): e is ManifestEntry => e !== null)
    .map((e) => ({ component_id: e.component_id, files: e.files ?? [] }));
}

export interface CascadeResult {
  component_id: string;
  status: "pass" | "fail";
  reason?: string;
  /**
   * N3 (F02-03 remainder): set when the dependent was NOT shown to fail but could not be re-checked (its test run was stopped at its output
   * or resource limit, or a tool was missing). `status` is still "fail" for a reader that only knows the old two values, but the dependent's
   * recorded status is left as it was and callers should say "could not be re-verified", not "now FAILS". Absent means the code failed.
   */
  infrastructure?: InfrastructureKind;
  /** C3: on a pass, the dependent's files no test exercised (compiled only). Absent when every file was covered. */
  notTested?: string[];
  /** C3 (F06-05): true when notTested is partly because the search for tests stopped at its file limit. */
  testSearchCut?: true;
}

/**
 * Re-checks each dependent after a change has landed. The compiler and the tests run in a throwaway copy of the project (A4), not
 * in the real folder: before, the real project was both their working and their writable directory, so a test that wrote files or
 * a build that emitted left them behind. Manifest status is still written for the real project.
 */
export function reVerifyDependents(
  dependents: DependentImpact[],
  targetDir: string = process.cwd()
): CascadeResult[] {
  // Nothing to copy (and nothing worth the cost of a copy) when no dependent can be run: the recognised-language checks below
  // still report, in that case against the real folder's paths, without running any tool.
  if (dependents.length === 0) return [];
  const copy = makeVerificationCopy(targetDir);
  try {
    return reVerifyIn(dependents, copy.dir);
  } finally {
    copy.dispose();
  }
}

function reVerifyIn(dependents: DependentImpact[], runDir: string): CascadeResult[] {
  const results: CascadeResult[] = [];
  for (const dep of dependents) {
    const absolutePaths = dep.files.map((f) => join(runDir, f));
    const firstFile = dep.files[0];
    const lang = firstFile === undefined ? undefined : languageForFile(firstFile);
    if (lang === undefined) {
      // Never default an unrecognized file to TypeScript: its toolchain would
      // judge a language it was not written for (ADR-017, false-pass defect).
      results.push({ component_id: dep.component_id, status: "fail", reason: `no registered language for ${firstFile ?? "(no files)"}, so it could not be re-verified` });
      continue;
    }
    const provider = getLanguageProvider(lang);
    if (!provider) {
      results.push({ component_id: dep.component_id, status: "fail", reason: `no provider for language ${lang}` });
      continue;
    }

    const compileResult = provider.verify(absolutePaths, runDir);

    let finalStatus: "pass" | "fail" = compileResult.status === "pass" ? "pass" : "fail";
    let finalReason: string | undefined = compileResult.status === "fail" || compileResult.status === "not_installed" ? (compileResult as any).reason : undefined;
    // A check that could not run is not a failure of the dependent: a missing tool (the repo's own mapping, checkKindOfVerification), or a
    // stage that labelled its failure (output limit, resource limit, no sandbox). A timeout is deliberately left unlabelled, see failureOfStoppedRun.
    let infrastructure: InfrastructureKind | undefined =
      compileResult.status === "not_installed" ? "not_installed" : compileResult.status === "fail" && !compileResult.policyBlock ? compileResult.infrastructure : undefined;

    let notTested: string[] | undefined;
    let testSearchCut = false;
    if (compileResult.status === "pass") {
      const testResult = provider.runTests(dep.component_id, dep.files, runDir);
      // C3: what no test exercised stays on the record. A pass event without this erases the earlier record (the latest pass wins).
      if (testResult.status === "no_tests" || testResult.status === "pass") {
        const uncovered = testResult.discovery?.uncovered ?? [];
        const cut = testResult.discovery?.truncated === true;
        const files = cut ? [...dep.files] : testResult.status === "no_tests" && uncovered.length === 0 ? [...dep.files] : [...uncovered];
        if (files.length > 0) { notTested = [...new Set(files)]; testSearchCut = cut; }
      }
      if (testResult.status === "fail" || testResult.status === "not_installed") {
        finalStatus = "fail";
        finalReason = testResult.reason;
        infrastructure = testResult.status === "not_installed" ? "not_installed" : testResult.infrastructure;
      }
      recordEvent(testResult.status === "fail" || testResult.status === "not_installed" ? "verification_failure" : "verification_pass", {
        component_id: dep.component_id,
        operation: "cascade_reverify",
        detail: {
          stage: "cascade_dependent_tests", test_status: testResult.status, reason: testResult.reason, ...(infrastructure ? { infrastructure } : {}),
          ...(notTested && testResult.status !== "fail" && testResult.status !== "not_installed" ? { not_tested: notTested } : {}),
          ...(notTested && testSearchCut && testResult.status !== "fail" && testResult.status !== "not_installed" ? { test_search_cut: true } : {}),
        },
      });
    }

    // Only a result about the code is written to the dependent's record. When the check could not run, the record keeps what it had:
    // writing "fail" would make `purix check` report a dependent that was never shown to fail.
    if (!infrastructure) {
      const entry = readManifest(dep.component_id);
      if (entry) {
        entry.verification_status = finalStatus;
        writeManifest(entry);
      }
    }

    results.push(
      finalStatus === "pass"
        ? { component_id: dep.component_id, status: "pass", ...(notTested ? { notTested } : {}), ...(notTested && testSearchCut ? { testSearchCut: true as const } : {}) }
        : { component_id: dep.component_id, status: "fail", reason: finalReason, ...(infrastructure ? { infrastructure } : {}) }
    );
  }
  return results;
}
