// src/cli/commands/lifecycle_ingest.ts
//
// H2: `purix ingest` (the Diff Ingestion Path, §3.1), moved out of registerLifecycleCommands unchanged so lifecycle.ts holds only create and modify.
import { warnRecordProblems } from "./landed.js";
import { formatStopLines } from "../change_summary.js";
import { type SecurityNotes, warnIfUnisolated, printNotTested, printNotChecked, printExcludedForSafety, printSecurityNotes, loadIngestRuntime } from "./lifecycle_runtime.js";

export async function runIngest(componentId: string, diffFile: string, opts: { agent?: string }): Promise<void> {
  const {
    confirmGated,
    readManifest,
    classifyDiff,
    scanDiffForInjectionAttempts,
    checkDrift,
    recordEvent,
    ingestDiffFromFile,
    planDeletions,
    holdDeletionForHuman,
    resolveLanguage,
    getLanguageProvider,
    evaluateTrustGate,
    hasTestCoverage,
    checkDeterministicOverrideFloor,
    loadDofPatterns,
    recordTrustGateDecision,
    assertAuthorizedToApprove,
    resolveVerification,
    commitVersionedChange,
    reVerifyCascadeDependents,
    formatChangeSetDiff,
  } = await loadIngestRuntime();
  const sourceAgent = opts.agent ?? null;

  // Node 2: State Resolver — identical requirement as the Instruction Path.
  const entry = readManifest(componentId);
  if (!entry) {
    console.error(`No manifest entry for "${componentId}". This diff needs a component to land against — run "purix create" first, or link it under the right one.`);
    process.exitCode = 1;
    return;
  }

  // Node 2a: Drift Detector — shared convergence point (§3.2).
  const drift = await checkDrift(entry, process.cwd());
  if (drift.drifted) {
    console.error(`\n⚠ "${componentId}" has drifted from its last known state. Run "purix migration accept-drift ${componentId}" first, then retry this ingest.`);
    process.exitCode = 1;
    return;
  }
  const originalFiles = drift.liveFiles;

  {
    const { preflightVerification, formatPreflight } = await import("@purix/core/verify/preflight");
    const blocked = formatPreflight(preflightVerification(entry.files ?? [], process.cwd()));
    if (blocked) {
      console.error(`\n🛑 ${blocked}`);
      process.exitCode = 1;
      return;
    }
  }

  // Node 0: Diff Ingestion
  const ingested = await ingestDiffFromFile(diffFile, sourceAgent, process.cwd());
  if (!ingested.ok) {
    const ingestReason = (ingested).reason;
    console.error(`\n🛑 Diff didn't apply: ${ingestReason}`);
    process.exitCode = 1;
    return;
  }

  // A diff may delete files of this component (never a test file, never the last file); it always needs a person's confirmation.
  const deleteChecker = await getLanguageProvider(resolveLanguage(componentId, process.cwd()))?.getTestIntegrityChecker?.();
  const deletionPlan = planDeletions({
    ingested: ingested.files,
    tracked: entry.files,
    originalFiles,
    isTestFile: (p: string) => deleteChecker?.isTestFile(p) ?? /\.(test|spec)\.|(^|\/)(tests?|__tests__)\//.test(p),
  });
  if (!deletionPlan.ok) {
    console.error(`\n🛑 Refused: ${deletionPlan.reason}`);
    process.exitCode = 1;
    return;
  }
  const deletedPaths = deletionPlan.deletedPaths;

  const trackedPaths = new Set(entry.files);
  const untrackedModified = ingested.files.filter((f) => f.status === "modified" && !trackedPaths.has(f.path));
  if (untrackedModified.length > 0) {
    console.error(
      `\n🛑 This diff modifies file(s) not tracked by "${componentId}": ${untrackedModified.map((f) => f.path).join(", ")}. ` +
        `Refusing to guess which component owns them — link the right component first.`
    );
    process.exitCode = 1;
    return;
  }

  const newPaths = ingested.files.filter((f) => f.status === "added").map((f) => f.path);

  // §9.3 pre-LLM pass, same discipline runEscalation applies to
  // neighbor context — cheap, local, runs before the diff content
  // ever reaches the classifier.
  const injectionFindings = scanDiffForInjectionAttempts(
    ingested.files.map((f) => ({ path: f.path, old_content: null, new_content: f.new_content, status: f.status }))
  );
  if (injectionFindings.length > 0) {
    console.log(`\n⚠ Instruction-like text found in the ingested diff content (§9.3):`);
    for (const finding of injectionFindings) {
      for (const h of finding.hits) console.log(`    ${finding.path}: "${h}"`);
    }
    const proceed = await confirmGated(
      `This could be an attempt to redirect the classifier via untrusted diff content. Send it to the classifier anyway?`,
      "injection_risk_proceed",
      componentId
    );
    if (!proceed) {
      console.error(`\n🛑 Aborted after suspicious content was flagged in the ingested diff.`);
      process.exitCode = 1;
      return;
    }
  }

  console.log(`\nIngested diff from ${sourceAgent ?? "(unknown source)"}: ${ingested.files.length} file(s) touched.`);
  for (const f of ingested.files) console.log(`  ${f.status}: ${f.path}`);

  // Node 3b: Change Classifier, diff-classify mode (§3.2). Same
  // structured verdict shape the Instruction Path's intent-classify
  // produces, fed by the diff itself instead of a developer
  // instruction — this is what finally lets TrustGate below run the
  // real evaluateTrustGate instead of the always-confirm placeholder.
  console.log(`\nClassifying diff...`);
  const diffVerdict = await classifyDiff(
    componentId,
    sourceAgent,
    ingested.files.map((f) => ({
      path: f.path,
      old_content: f.status === "added" ? null : originalFiles.find((o) => o.path === f.path)?.content ?? null,
      new_content: f.new_content,
      status: f.status,
    }))
  );
  console.log(`  operation: ${diffVerdict.operation}`);
  console.log(`  contract_changing: ${diffVerdict.contract_changing}`);
  console.log(`  confidence: ${diffVerdict.confidence.toFixed(2)}`);
  console.log(`  reasoning: ${diffVerdict.reasoning}`);

  if (diffVerdict.suspicious_injected_instruction) {
    console.log(`  ⚠ Classifier self-reported suspicious instruction-like content inside the diff.`);
  }

  recordEvent("classification", {
    component_id: componentId,
    operation: diffVerdict.operation,
    detail: { confidence: diffVerdict.confidence, contract_changing: diffVerdict.contract_changing, path: "diff" },
  });

  const finalFiles = [
    ...originalFiles.filter((f) => !deletedPaths.includes(f.path)).map((f) => {
      const changed = ingested.files.find((c) => c.path === f.path);
      return { path: f.path, new_content: changed ? changed.new_content : f.content };
    }),
    ...ingested.files.filter((f) => f.status === "added").map((f) => ({ path: f.path, new_content: f.new_content })),
  ];

  // §3.2 Node 6: identical Verifier every path converges on.
  const resolved = await resolveVerification(
    componentId,
    "diff_ingest",
    originalFiles,
    finalFiles,
    "direct_ingest",
    `apply ingested diff from ${sourceAgent ?? "unknown source"}`,
    process.cwd(),
    {},
    deletedPaths
  );
  if (!("finalFiles" in resolved)) {
    console.error(formatStopLines(resolved).join("\n"));
    process.exitCode = 1;
    return;
  }
  const workingFiles = resolved.finalFiles;
  const fromEscalation = resolved.fromEscalation;
  let ingestNotTested: string[] | undefined;
  let ingestSearchCut: boolean | undefined;
  let ingestCutFiles: string[] | undefined;
  let ingestExcluded: string[] | undefined;
  let ingestSecurity: SecurityNotes | undefined;
  let ingestNotChecked: string[] | undefined;
  if (resolved.verification.status === "pass") {
    warnIfUnisolated(resolved.verification.isolation);
    ingestNotTested = resolved.verification.notTested;
    ingestSearchCut = resolved.verification.testSearchCut;
    ingestCutFiles = resolved.verification.testSearchCutFiles;
    ingestExcluded = resolved.verification.excludedForSafety;
    ingestSecurity = { advisories: resolved.verification.securityAdvisories, notRead: resolved.verification.securityNotRead };
    ingestNotChecked = resolved.verification.notChecked;
    if (resolved.verification.idiomFindings.length > 0) {
      console.log(`\n  Idiom findings (soft, non-blocking):`);
      for (const f of resolved.verification.idiomFindings) console.log(`    ${f.path}:${f.line} [${f.rule}] ${f.message}`);
    }
  }

  // Node 3c: Test-Integrity Check — identical gate, same as the Instruction Path.
  const changedFiles = workingFiles.filter((f) => {
    const orig = originalFiles.find((o) => o.path === f.path);
    return orig ? orig.content !== f.new_content : true;
  });
  const lang = resolveLanguage(componentId, process.cwd());
  const provider = getLanguageProvider(lang);
  const testIntegrityChecker = await provider?.getTestIntegrityChecker?.();
  const testFilesBefore = originalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
  const testFilesAfter = workingFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test.")).map((f) => ({ path: f.path, content: f.new_content }));
  const testIntegrity = testIntegrityChecker
    ? testIntegrityChecker.check(testFilesBefore, testFilesAfter)
    : { flagged: true, findings: [{ path: "unknown", reason: `no test integrity checker registered for language ${lang} — failing closed` }] };
  if (testIntegrity.flagged) {
    recordEvent("test_integrity_flag", { component_id: componentId, operation: "diff_ingest", detail: { findings: testIntegrity.findings } });
    console.log(`\n  ⚠ Test-integrity check (§6.4): ${testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ")}`);
  }

  const hasCoverage = hasTestCoverage(changedFiles, process.cwd());
  if (!hasCoverage) {
    recordEvent("coverage_gate_flag", { component_id: componentId, operation: "diff_ingest", detail: { changed_files: changedFiles.map((f) => f.path) } });
  }
  recordEvent("gate_evaluation", { component_id: componentId, operation: "diff_ingest", detail: { path: "diff" } });

  // TrustGate (§6.2) — now fed a real classifier confidence via
  // diff-classify (Node 3b's second mode) instead of the old
  // always-confirm placeholder (evaluateTrustGateForDiff). Every path
  // converges on the identical evaluateTrustGate the Instruction Path
  // uses, per Principle 12 (author-agnostic verification: nothing
  // downstream gets a special case for "this came from a diff").
  const trustInput = {
    confidence: diffVerdict.confidence,
    contractChanging: diffVerdict.contract_changing,
    injectionSuspected: diffVerdict.suspicious_injected_instruction,
      isolation: resolved.verification.status === "pass" ? resolved.verification.isolation : undefined,
    ...(resolved.verification.status === "pass" && resolved.verification.changedCoverage?.ratio !== undefined ? { changedLineCoverage: resolved.verification.changedCoverage.ratio } : {}),
    hasCoverage,
    testIntegrity: {
      flagged: testIntegrity.flagged,
      reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined,
    },
  };
  let decision = evaluateTrustGate(trustInput);

  // Same rule the Instruction Path applies (§7.5): an escalation-
  // authored fix never auto-commits on the strength of a confidence
  // score that described the ORIGINAL diff, not what escalation
  // actually produced after that diff failed verification.
  if (fromEscalation && decision.action === "auto_commit") {
    decision = {
      action: "human_confirm",
      reason: `escalation-authored fix always requires confirmation, regardless of the original diff-classify confidence`,
    };
  }

  // A2a-1: the Deterministic Override Floor now applies to a diff too. It was checked on the instruction path only, so a
  // diff that touched a protected path (an agent-authored change to CI, CODEOWNERS or an auth folder) could auto-commit.
  // Same rule as the instruction path: it holds an auto-commit for a person and never softens an abort.
  decision = holdDeletionForHuman(decision, deletedPaths);
  const diffDof = checkDeterministicOverrideFloor(
    ingested.files.map((f) => f.path),
    loadDofPatterns(process.cwd())
  );
  if (diffDof.hit && decision.action === "auto_commit") {
    decision = {
      action: "human_confirm",
      reason: `touches a Deterministic Override Floor path ("${diffDof.matchedPath}" matches "${diffDof.matchedPattern}") — always requires confirmation regardless of confidence (§E-DOF)`,
    };
  }
  recordTrustGateDecision(trustInput, decision, { source: "diff", componentIds: [componentId], files: ingested.files.map((f) => f.path), floor: diffDof });

  console.log(`\n  TrustGate: ${decision.action} — ${decision.reason}`);

  if (decision.action === "abort") {
    console.error(`\n🛑 ${decision.reason}`);
    console.error(`  No real files were touched — the diff was not applied.`);
    process.exitCode = 1;
    return;
  }

  if (decision.action === "human_confirm") {
    try {
      await assertAuthorizedToApprove();
    } catch (err) {
      console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    // IDEA-078 / handoff finding #5, Decision 1 (unconditional).
    console.log(`\n  Diff:`);
    console.log(
      formatChangeSetDiff([
        ...workingFiles.map((f) => ({
          path: f.path,
          before: originalFiles.find((o) => o.path === f.path)?.content ?? null,
          after: f.new_content,
        })),
        ...deletedPaths.map((path: string) => ({ path, before: originalFiles.find((o) => o.path === path)?.content ?? null, after: null as string | null })),
      ])
    );

    const checkpointKind = fromEscalation ? "escalation_fix" : "diff_ingest";
    const proceed = await confirmGated(`\nApply this ingested diff to real files now? (${decision.reason})`, checkpointKind, componentId);
    if (!proceed) {
      console.log("Cancelled — no real files touched.");
      return;
    }
  }

  // Node 5: Executor + atomic manifest commit
  const beforeSnapshot = originalFiles.map((f) => ({ path: f.path, content: f.content }));
  // Previously always hardcoded to true — the conservative worst-case
  // default drift.ts's acceptDrift still uses for the same reason
  // (genuinely unknown, so don't guess "safe"). diff-classify (Node
  // 3b's second mode) now supplies a real verdict for ingested diffs,
  // so this uses that instead of guessing.
  const contractChanged = diffVerdict.contract_changing;

  const result = await commitVersionedChange({
    componentId,
    entry,
    beforeSnapshot,
    finalFiles: workingFiles,
    operation: "diff_ingest",
    patchRef: `v${entry.current_version + 1}-diff-ingest`,
    contractChanged,
    provenance: { source_type: "external_diff", source_agent: sourceAgent },
    targetDir: process.cwd(),
    reRunCommandHint: `"purix ingest"`,
    newFilePaths: newPaths,
    deletedPaths,
  });
  if (!result.ok) return;
  const newVersion = result.newVersion;

  console.log(`\n✅ "${componentId}" now at v${newVersion} (ingested from ${sourceAgent ?? "unknown source"}).`);
  if (deletedPaths.length > 0) console.log(`   Deleted: ${deletedPaths.join(", ")}`);
  warnRecordProblems(result.recordProblems);
  await printNotChecked(ingestNotChecked);
  await printNotTested(ingestNotTested, ingestSearchCut, ingestCutFiles);
  printExcludedForSafety(ingestExcluded);
  printSecurityNotes(ingestSecurity);

  if (contractChanged || deletedPaths.length > 0) {
    reVerifyCascadeDependents(entry, process.cwd(), contractChanged ? " — diff-classify flagged this as contract-changing." : " — this change deleted file(s).");
  }
}
