// src/verify/impact.ts
import { join } from "node:path";
import type { ManifestEntry } from "../manifest/schema.js";
import { readManifest, writeManifest } from "../manifest/store.js";
import { getLanguageProvider } from "../language/registry.js";
import { recordEvent } from "../manifest/events.js";

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
}

export function reVerifyDependents(
  dependents: DependentImpact[],
  targetDir: string = process.cwd()
): CascadeResult[] {
  const results: CascadeResult[] = [];
  for (const dep of dependents) {
    const absolutePaths = dep.files.map((f) => join(targetDir, f));
    const lang = dep.files.length > 0 && dep.files[0]!.endsWith(".py") ? "python" : "typescript";
    const provider = getLanguageProvider(lang);
    if (!provider) {
      results.push({ component_id: dep.component_id, status: "fail", reason: `no provider for language ${lang}` });
      continue;
    }

    const compileResult = provider.verify(absolutePaths, targetDir);

    let finalStatus: "pass" | "fail" = compileResult.status === "pass" ? "pass" : "fail";
    let finalReason: string | undefined = compileResult.status === "fail" || compileResult.status === "not_installed" ? (compileResult as any).reason : undefined;

    if (compileResult.status === "pass") {
      const testResult = provider.runTests(dep.component_id, dep.files, targetDir);
      if (testResult.status === "fail" || testResult.status === "not_installed") {
        finalStatus = "fail";
        finalReason = testResult.reason;
      }
      recordEvent(testResult.status === "fail" || testResult.status === "not_installed" ? "verification_failure" : "verification_pass", {
        component_id: dep.component_id,
        operation: "cascade_reverify",
        detail: { stage: "cascade_dependent_tests", test_status: testResult.status, reason: testResult.reason },
      });
    }

    const entry = readManifest(dep.component_id);
    if (entry) {
      entry.verification_status = finalStatus;
      writeManifest(entry);
    }

    results.push(
      finalStatus === "pass"
        ? { component_id: dep.component_id, status: "pass" }
        : { component_id: dep.component_id, status: "fail", reason: finalReason }
    );
  }
  return results;
}
