// src/cli/commands/lifecycle_runtime.ts
//
// H2: the pieces of lifecycle.ts that are not a command: the lines a run prints about what was not tested, not checked or left out, and the
// loaders that pull in the heavy core modules only when a command that needs them runs (so `purix --help` stays fast). Moved out unchanged.
import { partialLineMessage, excludedForSafetyMessage, securityNotesMessages } from "@purix/core/verify/surface_text";


// BUG FIX (GAPS-REPORT §2.3): verifyInSandbox() now reports the real
// isolation level a "pass" ran under, and a "pass" reached with
// isolation: "none" (no bwrap/sandbox-exec available, or — always, for
// TypeScript's tsc step specifically — a check that never runs through
// the sandbox layer at all) is a materially weaker guarantee than one
// reached under real containment. Surfacing it here, at the one place
// both "direct patch" and "diff ingest" verification passes print their
// result, is what makes that difference visible to a person instead of
// silently identical either way.
export function warnIfUnisolated(isolation: string | undefined): void {
  if (isolation === "none") {
    console.log(`  ⚠ verification passed with no sandbox isolation (isolation: none) — see .purix docs on execution isolation`);
  }
}

// "Not tested" must show wherever a run ends in a success line, or a green check reads as "verified".
// The wording lives in core (verify/outcome.ts) so CLI, MCP and status say the same thing.
/** C3: the partial-line note for anchors written by repair or escalation during the run (the compile-time note is printed earlier). Names only paths not already named. */
export function printRunPartialLine(paths: string[] | undefined, alreadyNamed?: readonly string[]): void {
  const fresh = (paths ?? []).filter((p) => !(alreadyNamed ?? []).includes(p));
  const note = partialLineMessage(fresh.length > 0 ? fresh : undefined);
  if (note) console.log(`\n  ${note}`);
}

export async function printNotTested(files: string[] | undefined, searchCut?: boolean, cutFiles?: string[]): Promise<void> {
  if (!files || files.length === 0) return;
  const { notTestedMessage } = await import("@purix/core/verify/outcome");
  // F06-05 / C3: when the search for tests hit its file limit the line must say so, or "no test is related" is a claim nobody checked.
  console.log(`  ⚠ ${notTestedMessage(files, { searchCut: searchCut === true, ...(cutFiles ? { cutFiles } : {}) })}`);
}

// Files in a language Purix cannot check. Nothing ran on them, so this line shows wherever a run ends in a success line.
export async function printNotChecked(files: string[] | undefined): Promise<void> {
  if (!files || files.length === 0) return;
  const { notCheckedMessage } = await import("@purix/core/verify/outcome");
  console.log(`  ⚠ ${notCheckedMessage(files)}`);
}

// Credential-looking files left out of the verification copy: a build or test that needed one ran without it. Shown wherever a run ends in a success line.
export function printExcludedForSafety(files: string[] | undefined): void {
  const m = excludedForSafetyMessage(files);
  if (m !== undefined) console.log(`  ⚠ ${m}`);
}

// C4: what the security gate saw and did not block, and the files its code rules did not read. Shown wherever a run ends in a success line.
export type SecurityNotes = { advisories?: { path: string; line: number; category: string }[]; notRead?: { path: string; reason: string }[] };
export function printSecurityNotes(v: SecurityNotes | undefined): void {
  for (const m of securityNotesMessages(v?.advisories, v?.notRead)) console.log(`  ⚠ ${m}`);
}

export async function loadLifecycleRuntime() {
  const [
    gatedConfirmModule,
    manifestStoreModule,
    scaffoldModule,
    classifyModule,
    injectionModule,
    driftModule,
    compileModule,
    impactModule,
    escalateModule,
    securityAuditModule,
    migrationModule,
    authModule,
    eventsModule,
    memoryModule,
    idempotencyModule,
    registryModule,
    trustgateModule,
    budgetModule,
    securityGateModule,
    overrideAuditModule,
    resolveVerificationModule,
    classifyAndCompileModule,
    commitCascadeModule,
    diffFormatModule,
    observabilityModule,
  ] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/entrypoints/scaffold"),
    import("@purix/core/llm/classify"),
    import("@purix/core/llm/injection"),
    import("@purix/core/state/drift"),
    import("@purix/core/verify/compile"),
    import("@purix/core/verify/impact"),
    import("@purix/core/recovery/escalate"),
    import("@purix/core/security/security_audit"),
    import("@purix/core/state/migration"),
    import("@purix/core/security/auth"),
    import("@purix/core/manifest/events"),
    import("@purix/core/manifest/memory"),
    import("@purix/core/state/idempotency"),
    import("@purix/core/language/registry"),
    import("@purix/core/gates/trustgate"),
    import("@purix/core/llm/budget"),
    import("@purix/core/gates/security_gate"),
    import("@purix/core/security/override_audit"),
    import("@purix/core/recovery/resolve_verification"),
    import("@purix/core/recovery/classify_and_compile"),
    import("@purix/core/manifest/commit_and_cascade"),
    // IDEA-078 / handoff finding #5: diff-before-approval fix.
    import("@purix/core/cli-io/diff_format"),
    import("@purix/core/manifest/observability"),
  ]);

  return {
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    writeManifestWithLimitCheck: manifestStoreModule.writeManifestWithLimitCheck,
    linkComponents: manifestStoreModule.linkComponents,
    deleteManifestEntry: manifestStoreModule.deleteManifestEntry,
    removeDependent: manifestStoreModule.removeDependent,
    removeDependencyReference: manifestStoreModule.removeDependencyReference,
    buildManifestEntry: scaffoldModule.buildManifestEntry,
    writeScaffold: scaffoldModule.writeScaffold,
    classifyGreenfield: classifyModule.classifyGreenfield,
    refineIntent: classifyModule.refineIntent,
    classifyModification: classifyModule.classifyModification,
    classifyDiff: classifyModule.classifyDiff,
    scanFilesForInjectionAttempts: classifyModule.scanFilesForInjectionAttempts,
    scanForInjectionAttempts: injectionModule.scanForInjectionAttempts,
    checkDrift: driftModule.checkDrift,
    compilePatch: compileModule.compilePatch,
    getDependents: impactModule.getDependents,
    runEscalation: escalateModule.runEscalation,
    auditSecurityPatterns: securityAuditModule.auditSecurityPatterns,
    buildMigrationPlan: migrationModule.buildMigrationPlan,
    stageMigration: migrationModule.stageMigration,
    assertAuthorizedToApprove: authModule.assertAuthorizedToApprove,
    recordEvent: eventsModule.recordEvent,
    readRelevantMemory: memoryModule.readRelevantMemory,
    readGlobalMemory: memoryModule.readGlobalMemory,
    formatMemoryLines: memoryModule.formatMemoryLines,
    computeRequestKey: idempotencyModule.computeRequestKey,
    findPriorCommit: idempotencyModule.findPriorCommit,
    recordRequestCommit: idempotencyModule.recordRequestCommit,
    resolveLanguage: registryModule.resolveLanguage,
    getLanguageProvider: registryModule.getLanguageProvider,
    evaluateTrustGate: trustgateModule.evaluateTrustGate,
    hasTestCoverage: trustgateModule.hasTestCoverage,
    checkDeterministicOverrideFloor: trustgateModule.checkDeterministicOverrideFloor,
    loadDofPatterns: trustgateModule.loadDofPatterns,
    recordTrustGateDecision: trustgateModule.recordTrustGateDecision,
    setBudgetOverride: budgetModule.setBudgetOverride,
    setSecurityOverride: securityGateModule.setSecurityOverride,
    recordOverrideAudit: overrideAuditModule.recordOverrideAudit,
    resolveVerification: resolveVerificationModule.resolveVerification,
    classifyAndCompile: classifyAndCompileModule.classifyAndCompile,
    // DUPLICATION FIX (residual lifecycle.ts finding, finalized): the
    // Node 5 commit sequence and the dependent re-verification cascade —
    // previously duplicated verbatim between `modify` and `ingest` below —
    // now live in commit_and_cascade.ts. Migration staging
    // (buildMigrationPlan/stageMigration above) deliberately stays
    // separate — see that file's header comment for why.
    commitVersionedChange: commitCascadeModule.commitVersionedChange,
    reVerifyCascadeDependents: commitCascadeModule.reVerifyCascadeDependents,
    formatChangeSetDiff: diffFormatModule.formatChangeSetDiff,
    countLineChanges: diffFormatModule.countLineChanges,
    readCheckpointAcceptance: observabilityModule.readCheckpointAcceptance,
    interpretationPromptSkip: observabilityModule.interpretationPromptSkip,
  };
}

// delete is far cheaper than create/modify/ingest — it never touches the
// classifier, sandbox verifier, escalation LLM, or language registry. It
// was previously routed through loadLifecycleRuntime() above, which
// imports all 26 lifecycle modules (including escalate.js, which pulls in
// the @google/genai SDK) on every call — measured at ~5.8s of pure import
// cost for a `delete` that only needed 3 of those modules. This loader
// imports only what the delete action actually destructures below.
export async function loadDeleteRuntime() {
  const [gatedConfirmModule, manifestStoreModule, eventsModule] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/manifest/events"),
  ]);

  return {
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    deleteManifestEntry: manifestStoreModule.deleteManifestEntry,
    removeDependent: manifestStoreModule.removeDependent,
    removeDependencyReference: manifestStoreModule.removeDependencyReference,
    recordEvent: eventsModule.recordEvent,
  };
}

// create needs the classifier (and therefore the LLM provider SDK — that
// cost is real, unavoidable work for this command) but never touches
// escalation, self-healing, the sandbox verifier, drift detection, diff
// ingestion, the language registry, or the trust gate — those only matter
// once a component already exists. Splitting this out saves ~16 of the 26
// modules loadLifecycleRuntime() would otherwise pull in for every create.
export async function loadCreateRuntime() {
  const [
    gatedConfirmModule,
    manifestStoreModule,
    scaffoldModule,
    classifyModule,
    memoryModule,
    authModule,
    hashModule,
    budgetModule,
    securityGateModule,
    diffFormatModule,
  ] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/entrypoints/scaffold"),
    import("@purix/core/llm/classify"),
    import("@purix/core/manifest/memory"),
    import("@purix/core/security/auth"),
    import("@purix/core/state/hash"),
    import("@purix/core/llm/budget"),
    import("@purix/core/gates/security_gate"),
    import("@purix/core/cli-io/diff_format"),
  ]);

  return {
    formatChangeSetDiff: diffFormatModule.formatChangeSetDiff,
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    writeManifestWithLimitCheck: manifestStoreModule.writeManifestWithLimitCheck,
    linkComponents: manifestStoreModule.linkComponents,
    buildManifestEntry: scaffoldModule.buildManifestEntry,
    writeScaffold: scaffoldModule.writeScaffold,
    classifyGreenfield: classifyModule.classifyGreenfield,
    readGlobalMemory: memoryModule.readGlobalMemory,
    formatMemoryLines: memoryModule.formatMemoryLines,
    assertAuthorizedToApprove: authModule.assertAuthorizedToApprove,
    computeSyncHash: hashModule.computeSyncHash,
    setBudgetOverride: budgetModule.setBudgetOverride,
    setSecurityOverride: securityGateModule.setSecurityOverride,
  };
}

// ingest never touches the classifier's intent-refinement/greenfield
// modes, scaffolding, self-healing, escalation, the LLM budget/security
// override gates (it has no --override flag and wraps nothing in a
// try/finally that would need them reset), migration staging,
// repository memory, or idempotency (a diff has no
// re-runnable "same instruction" key the way a developer instruction
// does) — of the 26 modules loadLifecycleRuntime() pulls in, ingest's
// action only ever calls into 10 of them. Split out the same way
// loadCreateRuntime()/loadDeleteRuntime() already were, for the same
// reason: avoid paying import cost (including pulling in the LLM
// provider SDKs transitively required by classify.js and trustgate.js)
// for modules this command's own body never references.
export async function loadIngestRuntime() {
  const [
    gatedConfirmModule,
    manifestStoreModule,
    classifyModule,
    driftModule,
    eventsModule,
    ingestModule,
    registryModule,
    trustgateModule,
    authModule,
    resolveVerificationModule,
    commitCascadeModule,
    diffFormatModule,
    deletionsModule,
  ] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/llm/classify"),
    import("@purix/core/state/drift"),
    import("@purix/core/manifest/events"),
    import("@purix/core/entrypoints/ingest"),
    import("@purix/core/language/registry"),
    import("@purix/core/gates/trustgate"),
    import("@purix/core/security/auth"),
    import("@purix/core/recovery/resolve_verification"),
    import("@purix/core/manifest/commit_and_cascade"),
    // IDEA-078 / handoff finding #5: diff-before-approval fix.
    import("@purix/core/cli-io/diff_format"),
    import("@purix/core/entrypoints/ingest_deletions"),
  ]);

  return {
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    classifyDiff: classifyModule.classifyDiff,
    scanDiffForInjectionAttempts: classifyModule.scanDiffForInjectionAttempts,
    checkDrift: driftModule.checkDrift,
    recordEvent: eventsModule.recordEvent,
    ingestDiffFromFile: ingestModule.ingestDiffFromFile,
    planDeletions: deletionsModule.planDeletions,
    holdDeletionForHuman: deletionsModule.holdDeletionForHuman,
    resolveLanguage: registryModule.resolveLanguage,
    getLanguageProvider: registryModule.getLanguageProvider,
    evaluateTrustGate: trustgateModule.evaluateTrustGate,
    hasTestCoverage: trustgateModule.hasTestCoverage,
    checkDeterministicOverrideFloor: trustgateModule.checkDeterministicOverrideFloor,
    loadDofPatterns: trustgateModule.loadDofPatterns,
    recordTrustGateDecision: trustgateModule.recordTrustGateDecision,
    assertAuthorizedToApprove: authModule.assertAuthorizedToApprove,
    resolveVerification: resolveVerificationModule.resolveVerification,
    // DUPLICATION FIX — see loadLifecycleRuntime()'s matching comment above.
    commitVersionedChange: commitCascadeModule.commitVersionedChange,
    reVerifyCascadeDependents: commitCascadeModule.reVerifyCascadeDependents,
    formatChangeSetDiff: diffFormatModule.formatChangeSetDiff,
  };
}

