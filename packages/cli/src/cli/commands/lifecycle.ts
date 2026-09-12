// src/cli/commands/lifecycle.ts
import type { Command } from "commander";
import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { snapshotSavings, printRunSummary } from "../savings_output.js";

async function loadLifecycleRuntime() {
  const [
    gatedConfirmModule,
    manifestStoreModule,
    scaffoldModule,
    classifyModule,
    injectionModule,
    driftModule,
    modifyModule,
    hashModule,
    compileModule,
    sandboxModule,
    impactModule,
    healModule,
    escalateModule,
    securityAuditModule,
    matchmakerModule,
    migrationModule,
    authModule,
    eventsModule,
    memoryModule,
    idempotencyModule,
    ingestModule,
    registryModule,
    trustgateModule,
    budgetModule,
    securityGateModule,
    overrideAuditModule,
  ] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/entrypoints/scaffold"),
    import("@purix/core/llm/classify"),
    import("@purix/core/llm/injection"),
    import("@purix/core/state/drift"),
    import("@purix/core/entrypoints/modify"),
    import("@purix/core/state/hash"),
    import("@purix/core/verify/compile"),
    import("@purix/core/sandbox/sandbox"),
    import("@purix/core/verify/impact"),
    import("@purix/core/recovery/heal"),
    import("@purix/core/recovery/escalate"),
    import("@purix/core/security/security_audit"),
    import("@purix/core/tools/matchmaker"),
    import("@purix/core/state/migration"),
    import("@purix/core/security/auth"),
    import("@purix/core/manifest/events"),
    import("@purix/core/manifest/memory"),
    import("@purix/core/state/idempotency"),
    import("@purix/core/entrypoints/ingest"),
    import("@purix/core/language/registry"),
    import("@purix/core/gates/trustgate"),
    import("@purix/core/llm/budget"),
    import("@purix/core/gates/security_gate"),
    import("@purix/core/security/override_audit"),
  ]);

  return {
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    writeManifestWithLimitCheck: manifestStoreModule.writeManifestWithLimitCheck,
    linkComponents: manifestStoreModule.linkComponents,
    createPendingOperation: manifestStoreModule.createPendingOperation,
    completeModification: manifestStoreModule.completeModification,
    commitManifestWithRetry: manifestStoreModule.commitManifestWithRetry,
    deletePendingOperation: manifestStoreModule.deletePendingOperation,
    deleteManifestEntry: manifestStoreModule.deleteManifestEntry,
    removeDependent: manifestStoreModule.removeDependent,
    removeDependencyReference: manifestStoreModule.removeDependencyReference,
    buildManifestEntry: scaffoldModule.buildManifestEntry,
    writeScaffold: scaffoldModule.writeScaffold,
    classifyGreenfield: classifyModule.classifyGreenfield,
    refineIntent: classifyModule.refineIntent,
    classifyModification: classifyModule.classifyModification,
    classifyDiff: classifyModule.classifyDiff,
    scanDiffForInjectionAttempts: classifyModule.scanDiffForInjectionAttempts,
    scanFilesForInjectionAttempts: classifyModule.scanFilesForInjectionAttempts,
    scanForInjectionAttempts: injectionModule.scanForInjectionAttempts,
    checkDrift: driftModule.checkDrift,
    applyModificationFiles: modifyModule.applyModificationFiles,
    rollbackModification: modifyModule.rollbackModification,
    computeSyncHash: hashModule.computeSyncHash,
    compilePatch: compileModule.compilePatch,
    verifyInSandbox: sandboxModule.verifyInSandbox,
    getDependents: impactModule.getDependents,
    reVerifyDependents: impactModule.reVerifyDependents,
    runSelfHealingLoop: healModule.runSelfHealingLoop,
    runEscalation: escalateModule.runEscalation,
    auditSecurityPatterns: securityAuditModule.auditSecurityPatterns,
    suggestTools: matchmakerModule.suggestTools,
    formatSuggestions: matchmakerModule.formatSuggestions,
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
    ingestDiffFromFile: ingestModule.ingestDiffFromFile,
    resolveLanguage: registryModule.resolveLanguage,
    getLanguageProvider: registryModule.getLanguageProvider,
    evaluateTrustGate: trustgateModule.evaluateTrustGate,
    hasTestCoverage: trustgateModule.hasTestCoverage,
    checkDeterministicOverrideFloor: trustgateModule.checkDeterministicOverrideFloor,
    loadDofPatterns: trustgateModule.loadDofPatterns,
    setBudgetOverride: budgetModule.setBudgetOverride,
    setSecurityOverride: securityGateModule.setSecurityOverride,
    recordOverrideAudit: overrideAuditModule.recordOverrideAudit,
  };
}

// delete is far cheaper than create/modify/ingest — it never touches the
// classifier, sandbox verifier, escalation LLM, or language registry. It
// was previously routed through loadLifecycleRuntime() above, which
// imports all 26 lifecycle modules (including escalate.js, which pulls in
// the @google/genai SDK) on every call — measured at ~5.8s of pure import
// cost for a `delete` that only needed 3 of those modules. This loader
// imports only what the delete action actually destructures below.
async function loadDeleteRuntime() {
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
async function loadCreateRuntime() {
  const [
    gatedConfirmModule,
    manifestStoreModule,
    scaffoldModule,
    classifyModule,
    memoryModule,
    matchmakerModule,
    authModule,
    hashModule,
    budgetModule,
    securityGateModule,
  ] = await Promise.all([
    import("@purix/core/cli-io/gated-confirm"),
    import("@purix/core/manifest/store"),
    import("@purix/core/entrypoints/scaffold"),
    import("@purix/core/llm/classify"),
    import("@purix/core/manifest/memory"),
    import("@purix/core/tools/matchmaker"),
    import("@purix/core/security/auth"),
    import("@purix/core/state/hash"),
    import("@purix/core/llm/budget"),
    import("@purix/core/gates/security_gate"),
  ]);

  return {
    confirmGated: gatedConfirmModule.confirmGated,
    readManifest: manifestStoreModule.readManifest,
    writeManifestWithLimitCheck: manifestStoreModule.writeManifestWithLimitCheck,
    linkComponents: manifestStoreModule.linkComponents,
    buildManifestEntry: scaffoldModule.buildManifestEntry,
    writeScaffold: scaffoldModule.writeScaffold,
    classifyGreenfield: classifyModule.classifyGreenfield,
    readGlobalMemory: memoryModule.readGlobalMemory,
    formatMemoryLines: memoryModule.formatMemoryLines,
    suggestTools: matchmakerModule.suggestTools,
    formatSuggestions: matchmakerModule.formatSuggestions,
    assertAuthorizedToApprove: authModule.assertAuthorizedToApprove,
    computeSyncHash: hashModule.computeSyncHash,
    setBudgetOverride: budgetModule.setBudgetOverride,
    setSecurityOverride: securityGateModule.setSecurityOverride,
  };
}

export function registerLifecycleCommands(program: Command) {
  // ---------------------------------------------------------------------------
  // create (§3.3 Greenfield)
  // ---------------------------------------------------------------------------
  program
    .command("create <n>")
    .description("Scaffold a new component (Greenfield, Instruction Path)")
    .action(async (name: string) => {
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
        suggestTools,
        formatSuggestions,
        assertAuthorizedToApprove,
        computeSyncHash,
        setBudgetOverride,
        setSecurityOverride,
      } = await loadCreateRuntime();
      const savingsBefore = snapshotSavings();
      if (readManifest(name)) {
        console.error(`Component "${name}" already exists in the manifest. Use "purix modify" instead.`);
        process.exitCode = 1;
        return;
      }

      console.log(`Planning "${name}"...`);
      const plan = await classifyGreenfield(name);

      console.log(`\nProposed component: ${plan.component_id} (${plan.component_type})`);
      for (const f of plan.files) console.log(`  ${f.path} — ${f.purpose}`);
      if (plan.depends_on.length > 0) console.log(`  depends_on: ${plan.depends_on.join(", ")}`);

      // §11.1: Tool Matchmaker reads Repository Memory too. A brand new
      // component has no history of its own yet, so this checks the
      // repo-wide conventions log instead ("we decided against X" notes).
      const globalMemory = readGlobalMemory();
      if (globalMemory.length > 0) {
        console.log(`\n  Repository Memory (§11.1) — keep these in mind before picking a package:`);
        for (const line of formatMemoryLines(globalMemory)) console.log(`    ${line}`);
      }

      // §12.1 Tool Matchmaker: add_component is exactly the trigger case
      // this describes — check for a vetted, maintained npm package
      // before committing to hand-rolled scaffolding. Advisory only: this
      // never blocks and never touches package.json itself.
      const matchQuery = `${name} ${plan.files.map((f) => f.purpose).join(" ")}`.trim();
      const toolSuggestions = await suggestTools(matchQuery);
      if (toolSuggestions.length > 0) {
        console.log(`\n  Vetted package suggestion(s) (§12.1, advisory only — not applied):`);
        console.log(formatSuggestions(toolSuggestions));
      }

      // BUG FIX: assertAuthorizedToApprove is async (it may prompt to
      // bootstrap the sole-approver file) — this was previously called
      // without await, meaning a declined bootstrap couldn't reliably
      // block the write it's supposed to gate. Same fix applied below in
      // "modify" and in escalate.ts.
      try {
        await assertAuthorizedToApprove();
      } catch (err) {
        console.error(`\n🛑 ${err instanceof Error ? err.message : err}`);
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

      if (plan.depends_on.length > 0) {
        const link = linkComponents(entry.component_id, plan.depends_on);
        if (link.skippedNotFound.length > 0) {
          console.log(
            `  ⚠ depends_on referenced unknown component(s), not linked: ${link.skippedNotFound.join(", ")}`
          );
        }
      }

      console.log(`\n✅ "${entry.component_id}" created (v${entry.current_version}).`);
      printRunSummary(savingsBefore);
    });

  

  // ---------------------------------------------------------------------------
  // modify (§3.1 Instruction Path — the full Brownfield node loop)
  // ---------------------------------------------------------------------------
  program
    .command("modify <componentId> <instruction>")
    .description("Modify an existing component via the Instruction Path ( Brownfield )")
    .option("--override <reason>", "Override gate stops with a reason")
    .action(async (componentId: string, instruction: string, options: { override?: string }) => {
      const {
        confirmGated,
        readManifest,
        writeManifestWithLimitCheck,
        createPendingOperation,
        completeModification,
        commitManifestWithRetry,
        deletePendingOperation,
        deleteManifestEntry,
        removeDependent,
        removeDependencyReference,
        buildManifestEntry,
        writeScaffold,
        refineIntent,
        classifyModification,
        scanDiffForInjectionAttempts,
        scanFilesForInjectionAttempts,
        scanForInjectionAttempts,
        checkDrift,
        applyModificationFiles,
        rollbackModification,
        computeSyncHash,
        compilePatch,
        verifyInSandbox,
        getDependents,
        reVerifyDependents,
        runSelfHealingLoop,
        runEscalation,
        auditSecurityPatterns,
        suggestTools,
        formatSuggestions,
        buildMigrationPlan,
        stageMigration,
        assertAuthorizedToApprove,
        recordEvent,
        readRelevantMemory,
        readGlobalMemory,
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
        setBudgetOverride,
        setSecurityOverride,
        recordOverrideAudit,
      } = await loadLifecycleRuntime();
      if (options.override !== undefined) {
        setBudgetOverride(options.override);
        setSecurityOverride(options.override);
      }
      try {
        const savingsBefore = snapshotSavings();
      // Node 2: State Resolver
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
            `Someone edited the files outside Purix. Run "purix accept-drift ${componentId}" first, ` +
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
      const intentOk = await confirmGated(`\nProceed with this interpretation?`, "intent_refinement", componentId);
      if (!intentOk) {
        console.log("Cancelled — nothing touched.");
        return;
      }

      // Node 3b: Change Classifier (intent-classify mode)
      console.log(`\nClassifying...`);
      const verdict = await classifyModification(componentId, refined.explicit_instruction, originalFiles);
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

      let dependents = getDependents(entry);
      if (verdict.contract_changing && dependents.length > 0) {
        console.log(`\n  This is contract-changing — ${dependents.length} dependent(s) will be re-verified after commit.`);
      }

      // Node 4: Patch Compiler
      const compiled = compilePatch(verdict, originalFiles);

      let finalFiles: { path: string; new_content: string }[];
      let fromEscalation = false;

      if (!compiled.ok) {
        // No deterministic transform for this operation at all — genuine
        // capability gap, straight to §6.3 rather than pretending a local
        // retry could ever succeed.
        const compileReason = (compiled as { ok: false; reason: string }).reason;
        console.log(`\n  No deterministic transform available: ${compileReason}`);
        const esc = await runEscalation(componentId, verdict.operation, refined.explicit_instruction, originalFiles, compileReason, process.cwd());
        if (!esc.ok) {
          console.error(`\n🛑 Escalation failed: ${esc.reason}`);
          process.exitCode = 1;
          return;
        }
        finalFiles = esc.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
        fromEscalation = true;
      } else {
        const candidateFiles = originalFiles.map((f) => {
          const changed = compiled.files.find((c) => c.path === f.path);
          return { path: f.path, new_content: changed ? changed.new_content : f.content };
        });

        const verification = verifyInSandbox(componentId, candidateFiles, process.cwd());
        if (verification.status === "pass") {
          finalFiles = candidateFiles;
          recordEvent("verification_pass", { component_id: componentId, operation: verdict.operation, detail: { stage: "direct_patch" } });
          recordEvent("idiom_findings", { component_id: componentId, operation: verdict.operation, detail: { count: verification.idiomFindings.length } });
          if (verification.idiomFindings.length > 0) {
            console.log(`\n  Idiom findings (soft, non-blocking):`);
            for (const f of verification.idiomFindings) console.log(`    ${f.path}:${f.line} [${f.rule}] ${f.message}`);
          }
        } else {
          // Node 6: first failure -> capped self-healing (§6.1).
          console.log(`\n  ❌ Verification failed: ${verification.reason}`);
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: verdict.operation,
            detail: { stage: "direct_patch", reason: verification.reason },
          });
          const healed = await runSelfHealingLoop(
            componentId,
            verdict.operation,
            originalFiles,
            compiled.files,
            verification.reason,
            process.cwd()
          );
          if (healed.ok) {
            finalFiles = healed.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
          } else {
            // Second consecutive failure (self-healing exhausted) -> §6.3.
            const lastReason = healed.attempts[healed.attempts.length - 1]?.reason ?? "self-healing exhausted";
            const esc = await runEscalation(componentId, verdict.operation, refined.explicit_instruction, originalFiles, lastReason, process.cwd());
            if (!esc.ok) {
              console.error(`\n🛑 Escalation failed: ${esc.reason}`);
              process.exitCode = 1;
              return;
            }
            finalFiles = esc.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
            fromEscalation = true;
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
      let decision = evaluateTrustGate({
        confidence: verdict.confidence,
        contractChanging: verdict.contract_changing,
        hasCoverage,
        testIntegrity: {
          flagged: testIntegrity.flagged,
          reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined,
        },
      });

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

      console.log(`\n  TrustGate: ${decision.action} — ${decision.reason}`);

      if (decision.action === "abort") {
        if (options.override !== undefined) {
          recordOverrideAudit("TrustGate", options.override, decision.reason);
          console.log(`  [override] TrustGate overridden: ${options.override.trim()}`);
          decision = { action: "human_confirm", reason: `Overridden via --override: ${options.override}` };
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
          console.error(`\n🛑 ${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
          return;
        }

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
      const newVersion = entry.current_version + 1;
      const pendingId = createPendingOperation({
        component_id: componentId,
        before_snapshot: beforeSnapshot,
        after_snapshot: finalFiles.map((f) => ({ path: f.path, content: f.new_content })),
        new_version: newVersion,
        operation: verdict.operation,
        contract_changed: verdict.contract_changing,
        provenance: { source_type: "instruction", source_agent: null },
      });

      let backups;
      try {
        backups = await applyModificationFiles(finalFiles, process.cwd());
      } catch (err) {
        console.error(`\n🛑 File write failed, rolled back: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return;
      }

      entry.current_version = newVersion;
      entry.verification_status = "pass";
      entry.last_synced_hash = computeSyncHash(finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
      entry.version_history.push({
        version: newVersion,
        operation: verdict.operation,
        patch_ref: `v${newVersion}-${verdict.operation}`,
        contract_changed: verdict.contract_changing,
        timestamp: new Date().toISOString(),
        provenance: { source_type: "instruction", source_agent: null },
      });

      const committed = await commitManifestWithRetry(entry, newVersion - 1);
      if (!committed) {
        // Real conflict: another process committed a newer version between
        // our State Resolver read and now. Roll back the files we just wrote
        // and hand back to the human rather than clobbering the other write.
        await rollbackModification(backups);
        deletePendingOperation(pendingId);
        console.error(
          `\n🛑 Manifest write conflict — "${componentId}" changed underneath this run. Rolled back file writes. Re-run "purix modify" against current state.`
        );
        process.exitCode = 1;
        return;
      }
      completeModification(entry, pendingId, newVersion);
      recordRequestCommit(requestKey, componentId, newVersion);

      console.log(`\n✅ "${componentId}" now at v${newVersion}.`);

      // §6.5: cascade re-verification, only on contract-changing.
      if (verdict.contract_changing) {
        const plan = buildMigrationPlan(componentId, verdict.operation, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
        const migrationId = stageMigration(componentId, verdict.operation, newVersion - 1, newVersion, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
        console.log(`  Migration record staged: ${migrationId} (${plan.summary})`);

        dependents = getDependents(entry);
        if (dependents.length > 0) {
          console.log(`  Re-verifying ${dependents.length} dependent(s)...`);
          const cascade = reVerifyDependents(dependents, process.cwd());
          for (const c of cascade) {
            console.log(c.status === "pass" ? `    ✅ ${c.component_id}` : `    ❌ ${c.component_id}: ${c.reason}`);
          }
        }
      }
      printRunSummary(savingsBefore);
    } finally {
      setBudgetOverride(undefined);
      setSecurityOverride(undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // ingest (§3.1 Diff Ingestion Path — Node 0)
  // ---------------------------------------------------------------------------
  program
    .command("ingest <componentId> <diffFile>")
    .description("Ingest an external diff (PR patch, pre-commit hook output, agent-authored diff) against a tracked component")
    .option("-a, --agent <name>", "the upstream agent that produced this diff (cursor, claude-code, devin, human, ...)")
    .action(async (componentId: string, diffFile: string, opts: { agent?: string }) => {
      const {
        confirmGated,
        readManifest,
        writeManifestWithLimitCheck,
        createPendingOperation,
        completeModification,
        commitManifestWithRetry,
        deletePendingOperation,
        deleteManifestEntry,
        removeDependent,
        removeDependencyReference,
        buildManifestEntry,
        writeScaffold,
        classifyGreenfield,
        refineIntent,
        classifyModification,
        classifyDiff,
        scanDiffForInjectionAttempts,
        scanFilesForInjectionAttempts,
        scanForInjectionAttempts,
        checkDrift,
        applyModificationFiles,
        rollbackModification,
        computeSyncHash,
        compilePatch,
        verifyInSandbox,
        getDependents,
        reVerifyDependents,
        runSelfHealingLoop,
        runEscalation,
        auditSecurityPatterns,
        suggestTools,
        formatSuggestions,
        buildMigrationPlan,
        stageMigration,
        assertAuthorizedToApprove,
        recordEvent,
        readRelevantMemory,
        readGlobalMemory,
        formatMemoryLines,
        computeRequestKey,
        findPriorCommit,
        recordRequestCommit,
        ingestDiffFromFile,
        resolveLanguage,
        getLanguageProvider,
        evaluateTrustGate,
        hasTestCoverage,
        checkDeterministicOverrideFloor,
        loadDofPatterns,
        setBudgetOverride,
        setSecurityOverride,
        recordOverrideAudit,
      } = await loadLifecycleRuntime();
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
        console.error(`\n⚠ "${componentId}" has drifted from its last known state. Run "purix accept-drift ${componentId}" first, then retry this ingest.`);
        process.exitCode = 1;
        return;
      }
      const originalFiles = drift.liveFiles;

      // Node 0: Diff Ingestion
      const ingested = await ingestDiffFromFile(diffFile, sourceAgent, process.cwd());
      if (!ingested.ok) {
        const ingestReason = (ingested as { ok: false; reason: string }).reason;
        console.error(`\n🛑 Diff didn't apply: ${ingestReason}`);
        process.exitCode = 1;
        return;
      }

      const deletions = ingested.files.filter((f) => f.status === "deleted");
      if (deletions.length > 0) {
        console.error(
          `\n🛑 This diff deletes file(s) (${deletions.map((f) => f.path).join(", ")}) — file deletion isn't wired into ingest yet. Handle deletions manually for now.`
        );
        process.exitCode = 1;
        return;
      }

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
        ...originalFiles.map((f) => {
          const changed = ingested.files.find((c) => c.path === f.path);
          return { path: f.path, new_content: changed ? changed.new_content : f.content };
        }),
        ...ingested.files.filter((f) => f.status === "added").map((f) => ({ path: f.path, new_content: f.new_content })),
      ];

      // §3.2 Node 6: identical Verifier every path converges on.
      let verification = verifyInSandbox(componentId, finalFiles, process.cwd());
      let workingFiles = finalFiles;
      let fromEscalation = false;

      if (verification.status !== "pass") {
        console.log(`\n  ❌ Verification failed: ${verification.reason}`);
        recordEvent("verification_failure", { component_id: componentId, operation: "diff_ingest", detail: { stage: "direct_ingest", reason: verification.reason } });

        const healed = await runSelfHealingLoop(
          componentId,
          "diff_ingest",
          originalFiles,
          workingFiles,
          verification.reason,
          process.cwd()
        );
        if (healed.ok) {
          workingFiles = healed.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
        } else {
          const lastReason = healed.attempts[healed.attempts.length - 1]?.reason ?? "self-healing exhausted";
          const esc = await runEscalation(
            componentId,
            "diff_ingest",
            `apply ingested diff from ${sourceAgent ?? "unknown source"}`,
            originalFiles,
            lastReason,
            process.cwd()
          );
          if (!esc.ok) {
            console.error(`\n🛑 Escalation failed: ${esc.reason}`);
            process.exitCode = 1;
            return;
          }
          workingFiles = esc.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
          fromEscalation = true;
        }
      } else {
        recordEvent("verification_pass", { component_id: componentId, operation: "diff_ingest", detail: { stage: "direct_ingest" } });
        if (verification.idiomFindings.length > 0) {
          console.log(`\n  Idiom findings (soft, non-blocking):`);
          for (const f of verification.idiomFindings) console.log(`    ${f.path}:${f.line} [${f.rule}] ${f.message}`);
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
      let decision = evaluateTrustGate({
        confidence: diffVerdict.confidence,
        contractChanging: diffVerdict.contract_changing,
        hasCoverage,
        testIntegrity: {
          flagged: testIntegrity.flagged,
          reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined,
        },
      });

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
          console.error(`\n🛑 ${err instanceof Error ? err.message : err}`);
          process.exitCode = 1;
          return;
        }
        const checkpointKind = fromEscalation ? "escalation_fix" : "diff_ingest";
        const proceed = await confirmGated(`\nApply this ingested diff to real files now? (${decision.reason})`, checkpointKind, componentId);
        if (!proceed) {
          console.log("Cancelled — no real files touched.");
          return;
        }
      }

      // Node 5: Executor + atomic manifest commit
      const beforeSnapshot = originalFiles.map((f) => ({ path: f.path, content: f.content }));
      const newVersion = entry.current_version + 1;
      // Previously always hardcoded to true — the conservative worst-case
      // default drift.ts's acceptDrift still uses for the same reason
      // (genuinely unknown, so don't guess "safe"). diff-classify (Node
      // 3b's second mode) now supplies a real verdict for ingested diffs,
      // so this uses that instead of guessing.
      const contractChanged = diffVerdict.contract_changing;

      const pendingId = createPendingOperation({
        component_id: componentId,
        before_snapshot: beforeSnapshot,
        after_snapshot: workingFiles.map((f) => ({ path: f.path, content: f.new_content })),
        new_version: newVersion,
        operation: "diff_ingest",
        contract_changed: contractChanged,
        provenance: { source_type: "external_diff", source_agent: sourceAgent },
      });

      let backups;
      try {
        backups = await applyModificationFiles(workingFiles, process.cwd());
      } catch (err) {
        console.error(`\n🛑 File write failed, rolled back: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return;
      }

      if (newPaths.length > 0) {
        entry.files = Array.from(new Set([...entry.files, ...newPaths]));
      }
      entry.current_version = newVersion;
      entry.verification_status = "pass";
      entry.last_synced_hash = computeSyncHash(workingFiles.map((f) => ({ path: f.path, content: f.new_content })));
      entry.version_history.push({
        version: newVersion,
        operation: "diff_ingest",
        patch_ref: `v${newVersion}-diff-ingest`,
        contract_changed: contractChanged,
        timestamp: new Date().toISOString(),
        provenance: { source_type: "external_diff", source_agent: sourceAgent },
      });

      const committed = await commitManifestWithRetry(entry, newVersion - 1);
      if (!committed) {
        await rollbackModification(backups);
        deletePendingOperation(pendingId);
        console.error(`\n🛑 Manifest write conflict — "${componentId}" changed underneath this run. Rolled back file writes. Re-run "purix ingest" against current state.`);
        process.exitCode = 1;
        return;
      }
      completeModification(entry, pendingId, newVersion);

      console.log(`\n✅ "${componentId}" now at v${newVersion} (ingested from ${sourceAgent ?? "unknown source"}).`);

      const dependents = getDependents(entry);
      if (contractChanged && dependents.length > 0) {
        console.log(`  Re-verifying ${dependents.length} dependent(s) — diff-classify flagged this as contract-changing.`);
        const cascade = reVerifyDependents(dependents, process.cwd());
        for (const c of cascade) {
          console.log(c.status === "pass" ? `    ✅ ${c.component_id}` : `    ❌ ${c.component_id}: ${c.reason}`);
        }
      }
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
      const {
        confirmGated,
        readManifest,
        deleteManifestEntry,
        removeDependent,
        removeDependencyReference,
        recordEvent,
      } = await loadDeleteRuntime();
      const entry = readManifest(componentId);
      if (!entry) {
        console.error(`No manifest entry for "${componentId}". Run "purix library" to see what's tracked.`);
        process.exitCode = 1;
        return;
      }

      if (entry.depended_on_by.length > 0 && !opts.force) {
        console.error(
          `\n🛑 "${componentId}" still has dependent(s): ${entry.depended_on_by.join(", ")}.\n` +
            `   Re-run with --force to delete anyway (dependents will have this reference removed from their depends_on list), ` +
            `or remove those dependencies first.`
        );
        process.exitCode = 1;
        return;
      }

      const proceed = await confirmGated(
        `This will permanently delete "${componentId}" from the manifest${opts.files ? " and remove its files from disk" : ""}. This cannot be undone. Continue?`,
        "component_delete",
        componentId
      );
      if (!proceed) {
        console.log("Cancelled — nothing deleted.");
        return;
      }

      // Clean up both directions of the dependency graph before the row
      // itself is gone and readManifest(componentId) stops working.
      for (const depId of entry.depends_on) {
        removeDependent(depId, componentId);
      }
      for (const dependentId of entry.depended_on_by) {
        removeDependencyReference(dependentId, componentId);
      }

      if (opts.files) {
        for (const relPath of entry.files) {
          const fullPath = join(process.cwd(), relPath);
          if (existsSync(fullPath)) {
            try {
              rmSync(fullPath);
            } catch (err) {
              console.warn(`  warning: couldn't remove ${relPath}: ${err instanceof Error ? err.message : err}`);
            }
          }
        }
      }

      deleteManifestEntry(componentId);
      recordEvent("component_deleted", {
        component_id: componentId,
        detail: { forced: !!opts.force, files_removed: !!opts.files, had_dependents: entry.depended_on_by.length > 0 },
      });
      console.log(`\n🗑️  Deleted "${componentId}"${opts.files ? " (files removed)" : " (manifest entry only — files left on disk)"}.`);
    });
}