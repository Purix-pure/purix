// src/cli/commands/lifecycle.ts
import { recordAnchorOutcome } from "@purix/core/verify/anchor_events";
import { partialLinePathsFor } from "@purix/core/verify/partial_line_record";
import { partialLineMessage } from "@purix/core/verify/surface_text";
import { uncoveredLinesNote } from "@purix/core/verify/changed_line_coverage";
import { noteLanded, warnRecordProblems } from "./landed.js";
import type { Command } from "commander";
import { snapshotSavings, printRunSummary, type RunVerification } from "../savings_output.js";
import { addOverrideOptions, resolveGateOverrides, type GateOverrides, type OverrideFlagOptions } from "../override_flags.js";
import { formatChangeLines, formatCoverageLine, formatStopLines, runVerificationOf } from "../change_summary.js";
import { type SecurityNotes, warnIfUnisolated, printRunPartialLine, printNotTested, printNotChecked, printExcludedForSafety, printSecurityNotes, loadLifecycleRuntime, loadCreateRuntime } from "./lifecycle_runtime.js";
import { runIngest } from "./lifecycle_ingest.js";
import { runDelete } from "./lifecycle_delete.js";
export { printRunPartialLine } from "./lifecycle_runtime.js";

export interface CreateOptions {
  /** Original free-text intent when called from `change` (name is then a derived seed). */
  intent?: string;
  dryRun?: boolean;
}

/**
 * IDEA-090: provider, language and type checker are settled before the model is called or anything is written.
 * Before this, `create` printed "Planning...", spent the model call, asked two questions, wrote the files, and only
 * then discovered the compiler was missing and rolled everything back.
 */
async function runCreatePreflight(): Promise<import("../greenfield_preflight.js").PreflightResult> {
  const [{ runGreenfieldPreflight, defaultPreflightDeps }, { promptLine }] = await Promise.all([
    import("../greenfield_preflight.js"),
    import("@purix/core/cli-io/confirm"),
  ]);
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  return runGreenfieldPreflight(process.cwd(), { interactive, ask: promptLine, log: (line) => console.log(line) }, await defaultPreflightDeps());
}

/** Shared by `create` and `change`'s no-match branch. */
export async function runCreate(name: string, opts: CreateOptions = {}): Promise<void> {
  const {
    confirmGated,
    readManifest,
    writeManifestWithLimitCheck,
    linkComponents,
    buildManifestEntry,
    writeScaffold,
    classifyGreenfield,
    readGlobalMemory,
    formatMemoryLines,
    formatChangeSetDiff,
    assertAuthorizedToApprove,
    computeSyncHash,
  } = await loadCreateRuntime();
  // Before anything that opens the project's store (snapshotSavings reads it): a preflight failure should leave a
  // folder with no project in it exactly as it was.
  const preflight = await runCreatePreflight();
  if (!preflight.ok) {
    console.error(`\n🛑 ${preflight.message}`);
    process.exitCode = 1;
    return;
  }
  const savingsBefore = snapshotSavings();
  if (readManifest(name)) {
    console.error(`Component "${name}" already exists in the manifest. Use "purix modify" instead.`);
    process.exitCode = 1;
    return;
  }

  console.log(`Planning "${name}"...`);
  const plan = await classifyGreenfield(name, opts.intent, { language: preflight.language });

  // The LLM chooses plan.component_id, which can differ from `name`. The
  // existence check above only covers `name`, so re-check the id that
  // will actually be written (2026-09-24: otherwise a plan naming an
  // existing component would overwrite its manifest entry).
  if (plan.component_id !== name && readManifest(plan.component_id)) {
    console.error(`The planned component id "${plan.component_id}" already exists in the manifest — nothing written. Use "purix modify" or "purix change --component ${plan.component_id}".`);
    process.exitCode = 1;
    return;
  }

  console.log(`\nProposed component: ${plan.component_id} (${plan.component_type})`);
  for (const f of plan.files) console.log(`  ${f.path} — ${f.purpose}`);
  if (plan.depends_on.length > 0) console.log(`  depends_on: ${plan.depends_on.join(", ")}`);

  // IDEA-090: say now, before the approval prompt and before the approver file is created, that these files
  // cannot be checked here. Approving them used to end in a rollback.
  const { checkPlanPrerequisites } = await import("../greenfield_preflight.js");
  const prerequisites = checkPlanPrerequisites(preflight.language, plan.files, process.cwd());
  if (!prerequisites.ok) {
    console.error(`\n🛑 ${prerequisites.message}`);
    process.exitCode = 1;
    return;
  }

  // §11.1: Repository Memory. A brand new
  // component has no history of its own yet, so this checks the
  // repo-wide conventions log instead ("we decided against X" notes).
  const globalMemory = readGlobalMemory();
  if (globalMemory.length > 0) {
    console.log(`\n  Repository Memory (§11.1) — keep these in mind before picking a package:`);
    for (const line of formatMemoryLines(globalMemory)) console.log(`    ${line}`);
  }

  // Diff-before-approval for create (handoff #5, "not done" item): the
  // confirm below writes real files, so show exactly what will be
  // written. There is no "before" state, so every file renders as new.
  console.log(`\n  Files to be written:`);
  console.log(
    formatChangeSetDiff(plan.files.map((f) => ({ path: f.path, before: null, after: f.starter_content })))
  );

  if (opts.dryRun) {
    console.log("\nDry run — nothing written.");
    return;
  }

  // BUG FIX: assertAuthorizedToApprove is async (it may prompt to
  // bootstrap the sole-approver file) — this was previously called
  // without await, meaning a declined bootstrap couldn't reliably
  // block the write it's supposed to gate. Same fix applied below in
  // "modify" and in escalate.ts.
  try {
    await assertAuthorizedToApprove();
  } catch (err) {
    console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }

  const proceed = await confirmGated(`\nWrite these files and register the component?`, "create_write", name);
  if (!proceed) {
    console.log("Cancelled — nothing written.");
    return;
  }

  await writeScaffold(plan, process.cwd());
  const entry = buildManifestEntry(plan);
  entry.last_synced_hash = computeSyncHash(
    plan.files.map((f) => ({ path: f.path, content: f.starter_content }))
  );
  writeManifestWithLimitCheck(entry);
  await noteLanded({ kind: "create", component_id: entry.component_id, version: entry.current_version, sync_hash: entry.last_synced_hash, operation: "create", source: null });

  if (plan.depends_on.length > 0) {
    const link = linkComponents(entry.component_id, plan.depends_on);
    if (link.skippedNotFound.length > 0) {
      console.log(
        `  ⚠ depends_on referenced unknown component(s), not linked: ${link.skippedNotFound.join(", ")}`
      );
    }
  }

  console.log(`\n✅ "${entry.component_id}" created (v${entry.current_version}).`);
  // create compiles the starter files (and rolls back if that fails) but runs no tests; stored status is "pending".
  const { pendingNotTestedMessage } = await import("@purix/core/verify/outcome");
  console.log(`  ⚠ ${pendingNotTestedMessage()}`);
  // create compiles the starter files but runs no tests, so the heading must not claim a pass.
  printRunSummary(savingsBefore, "partial");
}

export interface ModifyOptions extends OverrideFlagOptions {
  dryRun?: boolean;
}

/** Shared by `modify` and `change` — the full Brownfield node loop. */
export async function runModify(componentId: string, instruction: string, options: ModifyOptions = {}): Promise<void> {
  // F03-09: one reason per gate. Refuse the retired --override and empty reasons before anything runs or costs anything.
  let overrides: GateOverrides;
  try {
    overrides = resolveGateOverrides(options);
  } catch (err) {
    console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  const {
    confirmGated,
    readManifest,
    refineIntent,
    classifyAndCompile,
    scanFilesForInjectionAttempts,
    scanForInjectionAttempts,
    checkDrift,
    getDependents,
    runEscalation,
    auditSecurityPatterns,
    buildMigrationPlan,
    stageMigration,
    assertAuthorizedToApprove,
    recordEvent,
    readRelevantMemory,
    formatMemoryLines,
    computeRequestKey,
    findPriorCommit,
    recordRequestCommit,
    resolveLanguage,
    getLanguageProvider,
    evaluateTrustGate,
    hasTestCoverage,
    checkDeterministicOverrideFloor,
    loadDofPatterns,
    recordTrustGateDecision,
    setBudgetOverride,
    setSecurityOverride,
    recordOverrideAudit,
    resolveVerification,
    commitVersionedChange,
    reVerifyCascadeDependents,
    formatChangeSetDiff,
    countLineChanges,
    readCheckpointAcceptance,
    interpretationPromptSkip,
  } = await loadLifecycleRuntime();
  // A dry run writes nothing and records no override (see the --dry-run note below), so it arms none: it shows the block a real run
  // would meet. Armed only for a real run, and only for the gate that was named.
  if (!options.dryRun) {
    if (overrides.budget !== undefined) setBudgetOverride(overrides.budget);
    if (overrides.security !== undefined) setSecurityOverride(overrides.security);
  } else if (overrides.budget !== undefined || overrides.security !== undefined || overrides.trust !== undefined) {
    console.log(`  --dry-run does not apply overrides: the run below shows what a real run would meet.`);
  }
  try {
    const savingsBefore = snapshotSavings();
  // Node 2: State Resolver
  if (componentId === "purix-codebase-index") {
    console.error(
      `\n"purix-codebase-index" is Purix's internal listing of every indexed file, not a component you can change. ` +
        `To change existing code, register the file first: purix adopt <file-or-symbol>, then purix modify <id> "<instruction>".`
    );
    process.exitCode = 1;
    return;
  }

  const entry = readManifest(componentId);
  if (!entry) {
    console.error(`No manifest entry for "${componentId}". Run "purix create" first, or check the id.`);
    process.exitCode = 1;
    return;
  }

  // Node 2a: Drift Detector — shared convergence point for both paths (§3.2)
  const drift = await checkDrift(entry, process.cwd());
  if (drift.drifted) {
    console.error(
      `\n⚠ "${componentId}" has drifted from its last known state (§7.2).\n` +
        `Someone edited the files outside Purix. Run "purix migration accept-drift ${componentId}" first, ` +
        `then retry this modify.`
    );
    process.exitCode = 1;
    return;
  }
  const originalFiles = drift.liveFiles;
  if (originalFiles.length === 0) {
    console.error(`"${componentId}" has no readable files on disk — nothing to modify.`);
    process.exitCode = 1;
    return;
  }

  // Pre-flight: if the compiler or test runner this component needs is missing, stop BEFORE any model call.
  {
    const { preflightVerification, formatPreflight } = await import("@purix/core/verify/preflight");
    const blocked = formatPreflight(preflightVerification(entry.files ?? [], process.cwd()));
    if (blocked) {
      console.error(`\n🛑 ${blocked}`);
      process.exitCode = 1;
      return;
    }
  }

  // Idempotency key, checked before Node 1 spends anything. Same
  // component + same raw instruction + same file state that already
  // committed once is a no-op repeat, not a second edit.
  const requestKey = computeRequestKey(componentId, instruction, drift.liveHash);
  const priorCommit = findPriorCommit(requestKey);
  if (priorCommit) {
    console.log(`\n  This exact request already committed as v${priorCommit.resultingVersion} — nothing to do (idempotency key match).`);
    return;
  }

  recordEvent("request", { component_id: componentId, detail: { instruction } });

  // §E-DOF: Deterministic Override Floor. Checked here, ahead of both
  // Node 1's and Node 3b's LLM calls, purely deterministic — no
  // confidence, no LLM, path matching only. Honest note on scope: this
  // does NOT skip calling the classifier (compilePatch below still
  // needs a real verdict to produce edits from — there's no way to
  // patch a file without deciding what the patch is). What it DOES
  // guarantee is that a hit here forces human_confirm at the TrustGate
  // decision further down, unconditionally, regardless of whatever
  // confidence the classifier reports. Logged now so you know before
  // spending any LLM cost that this request will need your sign-off
  // no matter what comes back.
  const dofPatterns = loadDofPatterns(process.cwd());
  const dof = checkDeterministicOverrideFloor(entry.files, dofPatterns);
  if (dof.hit) {
    console.log(
      `\n  🛑 Deterministic Override Floor hit: "${dof.matchedPath}" matches protected pattern "${dof.matchedPattern}" (§E-DOF).\n` +
        `     This will require your explicit confirmation regardless of classifier confidence.`
    );
  }

  // §9.3 pre-LLM pass on the raw developer instruction — same
  // discipline the diff-ingest path already applies to diff content,
  // now applied before the instruction ever reaches Node 1
  // (refineIntent) or Node 3b (classifyModification), neither of
  // which previously had any local scan on this string at all.
  const instructionInjectionHits = scanForInjectionAttempts(instruction);
  if (instructionInjectionHits.length > 0) {
    console.log(`\n⚠ Instruction-like text found inside the developer instruction itself (§9.3):`);
    for (const h of instructionInjectionHits) console.log(`    "${h}"`);
    const proceedWithInstruction = await confirmGated(
      `This could be an attempt to redirect the classifier via the instruction text. Send it to the classifier anyway?`,
      "injection_risk_proceed",
      componentId
    );
    if (!proceedWithInstruction) {
      console.error(`\n🛑 Aborted after suspicious content was flagged in the instruction.`);
      process.exitCode = 1;
      return;
    }
  }

  // §9.3 pass over the component's EXISTING file content. The
  // instruction scan above only covers what the developer typed —
  // originalFiles gets pasted into the refineIntent and
  // classifyModification prompts too (filesBlock), and until now
  // nothing scanned that content before it reached the model.
  const fileInjectionFindings = scanFilesForInjectionAttempts(originalFiles);
  if (fileInjectionFindings.length > 0) {
    console.log(`\n⚠ Instruction-like text found inside "${componentId}"'s existing file content (§9.3):`);
    for (const f of fileInjectionFindings) {
      for (const h of f.hits) console.log(`    ${f.path}: "${h}"`);
    }
    const proceedWithFiles = await confirmGated(
      `This could be an attempt to redirect the classifier via content already in the component's files. Send it to the classifier anyway?`,
      "injection_risk_proceed",
      componentId
    );
    if (!proceedWithFiles) {
      console.error(`\n🛑 Aborted after suspicious content was flagged in existing file content.`);
      process.exitCode = 1;
      return;
    }
  }

  // Node 1: Intake / Intent Refinement
  console.log(`Refining intent...`);
  const memory = readRelevantMemory(componentId);
  const refined = await refineIntent(componentId, instruction, originalFiles, formatMemoryLines(memory));
  console.log(`\nInterpreted as: "${refined.explicit_instruction}"`);
  if (refined.assumptions.length > 0) {
    console.log(`Assumptions made:`);
    for (const a of refined.assumptions) console.log(`  - ${a}`);
  }
  // AI-13 (D-AI-2): with no assumptions, and at least 20 recorded human answers accepted 95% of the time, the question adds
  // nothing a person has not already said yes to. Anything else still asks. No answer is recorded when it is skipped, so the
  // acceptance data stops growing rather than feeding on itself.
  const skipCheck = interpretationPromptSkip({ assumptions: refined.assumptions.length, acceptance: readCheckpointAcceptance("intent_refinement") });
  if (skipCheck.skip) console.log(`\n  Interpretation check skipped: ${skipCheck.reason}.`);
  const intentOk = skipCheck.skip ? true : await confirmGated(`\nProceed with this interpretation?`, "intent_refinement", componentId);
  if (!intentOk) {
    console.log("Cancelled — nothing touched.");
    return;
  }

  // Node 3b: Change Classifier (intent-classify mode)
  console.log(`\nClassifying...`);
  // AI-11: classify and compile together, so a first edit that does not apply gets one cheap re-ask before escalation.
  const { verdict, compiled, retried, recoveredByRetry, firstReason } = await classifyAndCompile(componentId, refined.explicit_instruction, originalFiles);
  if (retried) {
    console.log(recoveredByRetry
      ? `  The first edit did not match the file (${(firstReason ?? "").split("\n")[0]}); a second attempt did.`
      : `  The first edit did not match the file; a second attempt did not either.`);
  }
  console.log(`  operation: ${verdict.operation}`);
  console.log(`  contract_changing: ${verdict.contract_changing}`);
  console.log(`  confidence: ${verdict.confidence.toFixed(2)}`);
  console.log(`  reasoning: ${verdict.reasoning}`);
  if (verdict.suspicious_injected_instruction) {
    console.log(`  ⚠ Classifier self-reported suspicious instruction-like content.`);
  }
  recordEvent("classification", {
    component_id: componentId,
    operation: verdict.operation,
    detail: {
      confidence: verdict.confidence,
      contract_changing: verdict.contract_changing,
      suspicious_injected_instruction: verdict.suspicious_injected_instruction,
    },
  });

  // Node 3a: Impact Analysis / Advisory Audit (never blocks)
  const secFindings = auditSecurityPatterns(originalFiles);
  if (secFindings.length > 0) {
    console.log(`\n  Advisory, not applied — ${secFindings.length} pattern finding(s):`);
    for (const f of secFindings) console.log(`    ${f.path}:${f.line} [${f.category}] ${f.message}`);
  }

  const dependents = getDependents(entry);
  if (verdict.contract_changing && dependents.length > 0) {
    console.log(`\n  This is contract-changing — ${dependents.length} dependent(s) will be re-verified after commit.`);
  }

  // Node 4: Patch Compiler
  recordAnchorOutcome(entry.component_id, compiled);
  // F04-04: an anchor that started or ended inside a line kept the rest of that line. Said here, before the diff is shown, so it is not missed.
  const partialLineNote = partialLineMessage(partialLinePathsFor(compiled, false));
  if (partialLineNote) console.log(`\n  ${partialLineNote}`);

  let finalFiles: { path: string; new_content: string }[];
  let fromEscalation = false;
  let notTestedFiles: string[] | undefined;
  let testSearchCutFlag: boolean | undefined;
  let testSearchCutFileList: string[] | undefined;
  let excludedFiles: string[] | undefined;
  let securityNotes: SecurityNotes | undefined;
  let notCheckedFiles: string[] | undefined;
  let verifiedIsolation: string | undefined;
  let verifiedCoverageRatio: number | undefined; // F06-04: share of changed lines a passing run ran; goes to the decision log only
  // What the run summary may say about verification. Stays undefined (neutral heading) unless a verification
  // result was actually seen and passed; a pass with untested files is "partial", never "passed" (C-36, N-06).
  let runVerification: RunVerification | undefined;

  if (!compiled.ok) {
    // No deterministic transform for this operation at all — genuine
    // capability gap, straight to §6.3 rather than pretending a local
    // retry could ever succeed.
    const compileReason = (compiled).reason;
    console.log(`\n  No deterministic transform available: ${compileReason}`);
    const esc = await runEscalation(componentId, verdict.operation, refined.explicit_instruction, originalFiles, compileReason, process.cwd());
    if (!esc.ok) {
      console.error(formatStopLines({ reason: `Escalation failed: ${esc.reason}`, infrastructure: esc.infrastructure }).join("\n"));
      process.exitCode = 1;
      return;
    }
    finalFiles = esc.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
    printRunPartialLine(esc.partialLinePaths);
    fromEscalation = true;
    if (esc.verification?.status === "pass") {
      warnIfUnisolated(esc.verification.isolation);
      verifiedIsolation = esc.verification.isolation;
      verifiedCoverageRatio = esc.verification.changedCoverage?.ratio;
      { const note = uncoveredLinesNote(esc.verification.changedCoverage); if (note) console.log(`  ⚠ ${note}`); }
      notTestedFiles = esc.verification.notTested;
      testSearchCutFlag = esc.verification.testSearchCut;
      testSearchCutFileList = esc.verification.testSearchCutFiles;
      excludedFiles = esc.verification.excludedForSafety;
      securityNotes = { advisories: esc.verification.securityAdvisories, notRead: esc.verification.securityNotRead };
      notCheckedFiles = esc.verification.notChecked;
      runVerification = runVerificationOf({ notTested: notTestedFiles, notChecked: notCheckedFiles });
    }
  } else {
    const candidateFiles = originalFiles.map((f) => {
      const changed = compiled.files.find((c) => c.path === f.path);
      return { path: f.path, new_content: changed ? changed.new_content : f.content };
    });

    const resolved = await resolveVerification(
      componentId,
      verdict.operation,
      originalFiles,
      candidateFiles,
      "direct_patch",
      refined.explicit_instruction,
      process.cwd()
    );
    if (!("finalFiles" in resolved)) {
      console.error(formatStopLines(resolved).join("\n"));
      process.exitCode = 1;
      return;
    }
    finalFiles = resolved.finalFiles;
    printRunPartialLine(resolved.partialLinePaths, partialLinePathsFor(compiled, false));
    fromEscalation = resolved.fromEscalation;
    if (resolved.verification.status === "pass") {
      warnIfUnisolated(resolved.verification.isolation);
      verifiedIsolation = resolved.verification.isolation;
      verifiedCoverageRatio = resolved.verification.changedCoverage?.ratio;
      { const note = uncoveredLinesNote(resolved.verification.changedCoverage); if (note) console.log(`  ⚠ ${note}`); }
      notTestedFiles = resolved.verification.notTested;
      testSearchCutFlag = resolved.verification.testSearchCut;
      testSearchCutFileList = resolved.verification.testSearchCutFiles;
      excludedFiles = resolved.verification.excludedForSafety;
      securityNotes = { advisories: resolved.verification.securityAdvisories, notRead: resolved.verification.securityNotRead };
      notCheckedFiles = resolved.verification.notChecked;
      runVerification = runVerificationOf({ notTested: notTestedFiles, notChecked: notCheckedFiles });
      recordEvent("idiom_findings", { component_id: componentId, operation: verdict.operation, detail: { count: resolved.verification.idiomFindings.length } });
      if (resolved.verification.idiomFindings.length > 0) {
        console.log(`\n  Idiom findings (soft, non-blocking):`);
        for (const f of resolved.verification.idiomFindings) console.log(`    ${f.path}:${f.line} [${f.rule}] ${f.message}`);
      }
    }
  }


  // Node 3c: Test-Integrity Check (§6.4) — deterministic, runs before TrustGate.
  const changedFiles = finalFiles.filter((f) => {
    const orig = originalFiles.find((o) => o.path === f.path);
    return orig ? orig.content !== f.new_content : true;
  });
  const lang = resolveLanguage(componentId, process.cwd());
  const provider = getLanguageProvider(lang);
  const testIntegrityChecker = await provider?.getTestIntegrityChecker?.();
  const testFilesBefore = originalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
  const testFilesAfter = finalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test.")).map((f) => ({ path: f.path, content: f.new_content }));
  const testIntegrity = testIntegrityChecker
    ? testIntegrityChecker.check(testFilesBefore, testFilesAfter)
    : { flagged: true, findings: [{ path: "unknown", reason: `no test integrity checker registered for language ${lang} — failing closed` }] };
  if (testIntegrity.flagged) {
    recordEvent("test_integrity_flag", { component_id: componentId, operation: verdict.operation, detail: { findings: testIntegrity.findings } });
    console.log(`\n  ⚠ Test-integrity check (§6.4): ${testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ")}`);
  }

  const hasCoverage = hasTestCoverage(changedFiles, process.cwd());
  if (!hasCoverage) {
    recordEvent("coverage_gate_flag", { component_id: componentId, operation: verdict.operation, detail: { changed_files: changedFiles.map((f) => f.path) } });
  }
  recordEvent("gate_evaluation", { component_id: componentId, operation: verdict.operation, detail: { path: "instruction" } });

  // TrustGate (§6.2): three independent gates feeding one decision.
  const trustInput = {
    confidence: verdict.confidence,
    contractChanging: verdict.contract_changing,
    injectionSuspected: verdict.suspicious_injected_instruction,
          isolation: verifiedIsolation,
    ...(verifiedCoverageRatio !== undefined ? { changedLineCoverage: verifiedCoverageRatio } : {}),
    hasCoverage,
    testIntegrity: {
      flagged: testIntegrity.flagged,
      reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined,
    },
  };
  let decision = evaluateTrustGate(trustInput);

  // An escalation-authored fix never auto-commits, regardless of the
  // ORIGINAL classifier confidence — that confidence described the
  // classifier's own edits, not the content escalation actually
  // produced after those edits failed. §7.5's checkpoint policy
  // treats this the same as any first-time externally-authored change.
  if (fromEscalation && decision.action === "auto_commit") {
    decision = {
      action: "human_confirm",
      reason: `escalation-authored fix always requires confirmation, regardless of the original classifier confidence`,
    };
  }

  // §E-DOF enforcement point: a deterministic floor overrides an
  // auto_commit outcome the same way the escalation override above
  // does. It does NOT downgrade an "abort" — if the classifier itself
  // rejected this, a protected path doesn't make that safer to proceed
  // past.
  if (dof.hit && decision.action === "auto_commit") {
    decision = {
      action: "human_confirm",
      reason: `touches a Deterministic Override Floor path ("${dof.matchedPath}" matches "${dof.matchedPattern}") — always requires confirmation regardless of confidence (§E-DOF)`,
    };
  }
  // A2a-1: the final decision, with every input it was made from, goes into the audit chain.
  recordTrustGateDecision(trustInput, decision, { source: "instruction", componentIds: [componentId], files: entry.files, floor: dof });

  // A "successful" run that changes no bytes must not mint a new version or
  // an approval prompt: nothing happened, so say so and stop.
  const changedPaths = finalFiles.filter((f) => originalFiles.find((o) => o.path === f.path)?.content !== f.new_content);
  if (changedPaths.length === 0) {
    console.log(`\n  The proposed change leaves every file identical — nothing to apply, no new version created.`);
    return;
  }

  console.log(`\n  TrustGate: ${decision.action} — ${decision.reason}`);

  if (options.dryRun) {
    // --dry-run: everything up to the decision has run (LLM calls,
    // sandbox verification); nothing below — approval, file writes,
    // manifest commit — will. The --override-* flags are not honored (an override writes an
    // audit record). Exit status mirrors what a real run would do.
    console.log(`\n  Diff:`);
    console.log(
      formatChangeSetDiff(
        finalFiles.map((f) => ({
          path: f.path,
          before: originalFiles.find((o) => o.path === f.path)?.content ?? null,
          after: f.new_content,
        }))
      )
    );
    if (decision.action === "abort") {
      console.error(`\n🛑 A real run would stop here: ${decision.reason}`);
      process.exitCode = 1;
    } else {
      console.log(`\nDry run — nothing written. A real run would: ${decision.action}.`);
    }
    await printNotChecked(notCheckedFiles);
    await printNotTested(notTestedFiles, testSearchCutFlag, testSearchCutFileList);
    printExcludedForSafety(excludedFiles);
    printSecurityNotes(securityNotes);
    return;
  }

  if (decision.action === "abort") {
    if (overrides.trust !== undefined) {
      recordOverrideAudit("TrustGate", overrides.trust, decision.reason);
      console.log(`  [override] TrustGate overridden: ${overrides.trust.trim()}`);
      decision = { action: "human_confirm", reason: `Overridden via --override-trust: ${overrides.trust}` };
    } else {
      console.error(`\n🛑 ${decision.reason}`);
      console.error(`  Rephrase the instruction and re-run "purix modify" — no real files were touched.`);
      process.exitCode = 1;
      return;
    }
  }

  if (decision.action === "human_confirm") {
    try {
      await assertAuthorizedToApprove();
    } catch (err) {
      console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
      return;
    }

    // IDEA-078 / handoff finding #5, Decision 1 (unconditional — no
    // suppress flag): every path that reaches this prompt is already
    // a path TrustGate judged needs real human attention, so the
    // diff is always shown here, not gated behind a flag.
    console.log(`\n  Diff:`);
    console.log(
      formatChangeSetDiff(
        finalFiles.map((f) => ({
          path: f.path,
          before: originalFiles.find((o) => o.path === f.path)?.content ?? null,
          after: f.new_content,
        }))
      )
    );

    const checkpointKind = fromEscalation
      ? "escalation_fix"
      : dof.hit
      ? "deterministic_override_floor"
      : verdict.contract_changing
      ? "contract_changing"
      : "trust_gate";
    const proceed = await confirmGated(`\nApply this change to real files now? (${decision.reason})`, checkpointKind, componentId);
    if (!proceed) {
      console.log("Cancelled — no real files touched.");
      return;
    }
  }

  // Node 5: Executor + atomic manifest commit (§7.3/§7.4)
  const beforeSnapshot = originalFiles.map((f) => ({ path: f.path, content: f.content }));
  const result = await commitVersionedChange({
    componentId,
    entry,
    beforeSnapshot,
    finalFiles,
    operation: verdict.operation,
    patchRef: `v${entry.current_version + 1}-${verdict.operation}`,
    contractChanged: verdict.contract_changing,
    provenance: { source_type: "instruction", source_agent: null },
    targetDir: process.cwd(),
    reRunCommandHint: `"purix modify"`,
  });
  if (!result.ok) return;
  const newVersion = result.newVersion;
  recordRequestCommit(requestKey, componentId, newVersion);

  console.log(`\n✅ "${componentId}" now at v${newVersion}.`);
  warnRecordProblems(result.recordProblems);
  // AI-13: an auto-commit showed no diff before the write, so say what changed. (A human_confirm run already printed the diff.)
  if (decision.action === "auto_commit") {
    for (const line of formatChangeLines(changedPaths.map((f) => countLineChanges({ path: f.path, before: originalFiles.find((o) => o.path === f.path)?.content ?? null, after: f.new_content })))) console.log(line);
    console.log(formatCoverageLine({ verification: runVerification, isolation: verifiedIsolation, changedCount: changedPaths.length, notTestedCount: notTestedFiles?.length ?? 0, notCheckedCount: notCheckedFiles?.length ?? 0 }));
  }
  await printNotChecked(notCheckedFiles);
  await printNotTested(notTestedFiles, testSearchCutFlag, testSearchCutFileList);
  printExcludedForSafety(excludedFiles);
  printSecurityNotes(securityNotes);

  // §6.5: cascade re-verification, only on contract-changing. Migration
  // staging is modify-specific — see commit_and_cascade.ts's header for
  // why it isn't folded into the shared helper.
  if (verdict.contract_changing) {
    const plan = buildMigrationPlan(componentId, verdict.operation, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
    const migrationId = stageMigration(componentId, verdict.operation, newVersion - 1, newVersion, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
    console.log(`  Migration record staged: ${migrationId} (${plan.summary})`);
    reVerifyCascadeDependents(entry, process.cwd());
  }
  printRunSummary(savingsBefore, runVerification);
} finally {
  setBudgetOverride(undefined);
  setSecurityOverride(undefined);
}
}

export function registerLifecycleCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // create (§3.3 Greenfield)
  // ---------------------------------------------------------------------------
  program
    .command("create <name>")
    .description("Scaffold a new component (Greenfield, Instruction Path)")
    .option("-n, --dry-run", "Show the plan and the files that would be written, then stop (writes nothing)")
    .action(async (name: string, opts: { dryRun?: boolean }) => {
      await runCreate(name, { dryRun: opts.dryRun });
    });

  

  // ---------------------------------------------------------------------------
  // modify (§3.1 Instruction Path — the full Brownfield node loop)
  // ---------------------------------------------------------------------------
  addOverrideOptions(
    program
      .command("modify <componentId> <instruction>")
      .description("Modify an existing component via the Instruction Path ( Brownfield )")
  )
    .option("-n, --dry-run", "Run planning and verification, show the diff and the gate decision, then stop (writes nothing)")
    .action(async (componentId: string, instruction: string, options: ModifyOptions) => {
      await runModify(componentId, instruction, options);
  });

  // ---------------------------------------------------------------------------
  // ingest (§3.1 Diff Ingestion Path — Node 0)
  // ---------------------------------------------------------------------------
  program
    .command("ingest <componentId> <diffFile>")
    .description("Ingest an external diff (PR patch, pre-commit hook output, agent-authored diff) against a tracked component")
    .option("-a, --agent <name>", "the upstream agent that produced this diff (cursor, claude-code, devin, human, ...)")
    .action(async (componentId: string, diffFile: string, opts: { agent?: string }) => {
      await runIngest(componentId, diffFile, opts);
    });


    // ---------------------------------------------------------------------------
  // delete — previously deleteManifestEntry existed in manifest/store.ts
  // but was never wired to a command. create/modify had a lifecycle end
  // but no exit. Refuses on live dependents unless --force; --force also
  // strips the deleted id out of each dependent's own depends_on list
  // (removeDependencyReference), so nothing is left pointing at a
  // component that no longer resolves via readManifest. Manifest-only by
  // default — files on disk are untouched unless --files is passed.
  // ---------------------------------------------------------------------------
  program
    .command("delete <componentId>")
    .description("Permanently remove a component from the manifest (DESTRUCTIVE)")
    .option("--force", "Delete even if other components still depend on it")
    .option("--files", "Also delete the component's files from disk")
    .action(async (componentId: string, opts: { force?: boolean; files?: boolean }) => {
      await runDelete(componentId, opts);
    });
}