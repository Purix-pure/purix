// src/recovery/escalate.ts
// ADR-043 Caveat: Escalation baseline coverage is a raised floor, not a closed gap — stated limit, not a promise.
import { recordAnchorOutcome } from "../verify/anchor_events.js";
import { readManifest } from "../manifest/store.js";
import { readComponentFiles } from "../entrypoints/modify.js";
import { verifyInSandbox } from "../sandbox/sandbox.js";
import { scrubSecrets } from "../security/secrets.js";
import { escalateJudgeAndRepair } from "../llm/escalate.js";
import { scanForInjectionAttempts } from "../llm/injection.js";
import { computeTaskSignature, findLibraryMatch, promoteOperation, markLibraryUsed } from "../manifest/library.js";
import { recordMemory } from "../manifest/memory.js";
import { assertAuthorizedToApprove } from "../security/auth.js";
import { confirm } from "../cli-io/confirm.js";
import { applyEdits, mergeFileChanges, type CompiledFileChange } from "../verify/compile.js";
import { resolveLanguage, getLanguageProvider } from "../language/registry.js";
import { recordEvent } from "../manifest/events.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";
import { OscillationGuard, applyEditsAndCheckOscillation } from "./oscillation_guard.js";
import { loadContextConfig } from "../llm/context/config.js";
import { estimateTokens } from "../llm/context/tokens.js";
import { shapeFailure, type ShapedFailure } from "../verify/failure_shape.js";
import { sanitizeAndRecord } from "../llm/input_scan.js";
import { appendLedger, renderLedger, sameFailurePlace, type LedgerEntry, type LedgerOutcome } from "./repair_ledger.js";
import { healEarlyStopEnabled } from "./heal_config.js";
import { infrastructureOf, infrastructureStopOf, stopMessage } from "./infrastructure_stop.js";
import type { InfrastructureKind } from "../verify/outcome.js";
import { searchCutDetail, securityNotesDetail } from "../verify/discovery_cut.js";

const ESCALATION_MAX_ATTEMPTS = 2; // separate from heal.ts's 3 — §6.1's "three distinct retry caps"

export interface EscalationResult {
  ok: boolean;
  files?: CompiledFileChange[];
  fromLibrary: boolean;
  reason?: string;
  /** The verification the returned files actually passed (carries isolation and notTested). Set only when ok. */
  verification?: SandboxVerificationResult;
  /** C3: paths where a repair-authored exact anchor started or ended inside a line, so the rest of that line stayed. Absent when none did. */
  partialLinePaths?: string[];
  /** A8-1: set only on a failure where a verification could not run (tool missing, labelled timeout, output limit, resource limit). No further model call was made after it. Not a failure of the code. */
  infrastructure?: { kind: InfrastructureKind; actionHint?: string };
}

/** Seams for tests: the model call and the sandbox. Production callers pass nothing and get the real ones. */
export interface EscalationDeps {
  escalate: typeof escalateJudgeAndRepair;
  verify: typeof verifyInSandbox;
}

export interface NeighborContext {
  files: { component_id: string; path: string; content: string }[];
  /** "component/path" of each file left out to stay inside the token budget. */
  omitted: string[];
}

/**
 * Files of the components this one depends on, then the components that depend on it, as many whole files as fit in
 * `maxTokens` (estimated). A file that does not fit is skipped and named, never cut in half: half a file reads as the
 * whole file to the model. Direct dependencies come first because a change there is the likeliest cause of a failure here.
 */
export async function gatherNeighborContext(
  componentId: string,
  targetDir: string,
  maxTokens: number = loadContextConfig().neighborMaxTokens
): Promise<NeighborContext> {
  const entry = readManifest(componentId);
  if (!entry) return { files: [], omitted: [] };
  const neighborIds = [...new Set([...(entry.depends_on ?? []), ...(entry.depended_on_by ?? [])])];
  const files: NeighborContext["files"] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const nid of neighborIds) {
    const nEntry = readManifest(nid);
    if (!nEntry) continue;
    for (const f of await readComponentFiles(nEntry, targetDir)) {
      const cost = estimateTokens(f.content) + estimateTokens(`--- [dependency context: ${nid}] ${f.path} ---`);
      if (used + cost > maxTokens) {
        omitted.push(`${nid}/${f.path}`);
        continue;
      }
      used += cost;
      files.push({ component_id: nid, path: f.path, content: f.content });
    }
  }
  return { files, omitted };
}

/** Words for the person and the model when the budget left files out. */
function omissionNotice(omitted: string[]): string {
  return `These dependency files were left out to keep the request short: ${omitted.join(", ")}.`;
}

/**
 *  Reached from exactly two places in cli.ts: an operation with no
 * wired Patch Compiler transform (real capability gap), or heal.ts
 * exhausting its own cap (the "second consecutive verification failure"
 * case). Checks the §5.2 library first, at zero LLM cost, before ever
 * calling the high-tier model.
 */
export async function runEscalation(
  componentId: string,
  operation: string,
  instruction: string,
  originalFiles: { path: string; content: string }[],
  failureReason: string,
  targetDir: string = process.cwd(),
  deps: Partial<EscalationDeps> = {},
  /** E3c (F07-06): full file sets the repair loop already verified and saw fail. A candidate equal to one of them is refused, not verified again. */
  options: { alreadyTried?: { path: string; content: string }[][] } = {}
): Promise<EscalationResult> {
  const callEscalation = deps.escalate ?? escalateJudgeAndRepair;
  const verify = deps.verify ?? verifyInSandbox;
  console.log(`\n⤴ Escalating "${componentId}" (§6.3) — high-tier model, real cost, should stay rare.`);
  recordEvent("escalation_start", { component_id: componentId, operation, detail: { instruction, failure_reason: failureReason } });

  const taskSignature = computeTaskSignature(componentId, operation, instruction);

  // BUG FIX: findLibraryMatch() defaults to "typescript" when no language is
  // passed, and this was the one production caller not passing one —
  // promoteOperation() below already resolves the component's real language
  // before writing (library.ts's own default: entry.language ??
  // resolveLanguage(entry.component_id)). Without this, a non-TypeScript
  // component's fix gets written under its real language partition but
  // every future lookup here searches only "typescript" and never finds
  // it — every such escalation silently pays full LLM cost forever.
  let libraryLanguage: string | undefined;
  try {
    libraryLanguage = resolveLanguage(componentId, targetDir);
  } catch {
    // Ambiguous/undetectable language: fall through to findLibraryMatch's
    // own "typescript" default rather than failing the whole escalation
    // over a lookup that's allowed to simply miss.
  }

  const cached = findLibraryMatch(taskSignature, libraryLanguage);
  if (cached) {
    console.log(`  Match found in the local operation library — reapplying with no LLM call (§5.2).`);
    const replay = applyEdits(cached.edits, originalFiles);
    if (replay.ok) {
      const merged = mergeFileChanges(originalFiles, replay.files);
      const verification = verify(componentId, merged, targetDir);
      if (verification.status === "pass") {
        markLibraryUsed(taskSignature);
        recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "library_hit" } });
        return { ok: true, files: merged, fromLibrary: true, verification, ...(replay.partialLinePaths?.length ? { partialLinePaths: replay.partialLinePaths } : {}) };
      }
      // A8-1: a replay that could not be checked says nothing about the cached fix, and a fresh escalation would hit the same wall at full price.
      const replayStop = infrastructureStopOf(verification);
      if (replayStop) {
        recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "infrastructure_stop", attempts: 0, infrastructure: replayStop.kind } });
        return { ok: false, fromLibrary: false, reason: stopMessage(replayStop), infrastructure: infrastructureOf(replayStop) };
      }
      console.log(`  Cached fix no longer verifies against current file state — falling back to a fresh escalation.`);
    } else {
      console.log(`  Cached fix's anchor text no longer matches (${replay.reason}) — falling back to a fresh escalation.`);
    }
  }

  const gathered = await gatherNeighborContext(componentId, targetDir);
  const neighborContextRaw = gathered.files;

  // §E10: this content is about to become prompt text sent to the
  // escalation LLM (below), not a write target — scanForSecrets() only
  // ever blocks writes, so it doesn't apply here. Redact in place
  // instead. Scrubbing happens BEFORE the injection scan too, so
  // nothing downstream — logging, the confirm prompt, or the prompt
  // itself — ever sees an unredacted secret from a neighbor file.
  const scrubbed = scrubSecrets(neighborContextRaw);
  const totalScrubbed = scrubbed.reduce((sum, s) => sum + s.scrubbedCount, 0);
  const contextNotes = [
    totalScrubbed > 0 ? `🔒 Redacted ${totalScrubbed} secret-shaped value(s) from dependency context before sending it to the escalation LLM.` : "",
    gathered.omitted.length > 0 ? omissionNotice(gathered.omitted) : "",
  ].filter(Boolean);
  if (contextNotes.length > 0) {
    console.log(contextNotes.map((n) => `  ${n}`).join("\n"));
  }
  const neighborContext = neighborContextRaw.map((n, i) => ({ ...n, content: scrubbed[i]!.content }));
  if (gathered.omitted.length > 0) {
    // The model is told what it was not shown, so it does not assume the listed files are empty or absent.
    neighborContext.push({ component_id: "omitted files", path: "(notice)", content: omissionNotice(gathered.omitted) });
  }

  for (const n of neighborContext) {
    const hits = scanForInjectionAttempts(n.content);
    if (hits.length > 0) {
      console.log(`\n⚠ Instruction-like text found in dependency context from "${n.component_id}" (${n.path}):`);
      for (const h of hits) console.log(`    "${h}"`);
      const proceed = await confirm(
        `This could be an attempt to redirect the model via untrusted repo content (§9.3). Send it to the escalation LLM anyway?`
      );
      recordEvent("confirm_response", {
        component_id: componentId,
        operation,
        detail: { checkpoint_kind: "injection_risk_proceed", approved: proceed, neighbor: n.component_id },
      });
      if (!proceed) {
        recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "aborted_injection_risk" } });
        return { ok: false, fromLibrary: false, reason: "Aborted after suspicious content was flagged in dependency context." };
      }
    }
  }

  const currentByPath = new Map(originalFiles.map((f) => [f.path, f.content]));
  let lastReason = failureReason;

  // §E-OSC oscillation guard — see recovery/oscillation_guard.ts. Fresh
  // instance per runEscalation invocation, same as before consolidation.
  const oscillationGuard = new OscillationGuard();
  for (const state of options.alreadyTried ?? []) oscillationGuard.seed(state);

  // AI-12: the same ledger, shaped failure and input scan as the repair loop. Escalation starts from the original files, so
  // every file of the component counts as one the failure may be about (nothing has been edited yet to narrow it down).
  let ledger: LedgerEntry[] = [];
  const earlyStop = healEarlyStopEnabled();
  let shaped: ShapedFailure | null;

  const partialPaths = new Set<string>();
  for (let attempt = 1; attempt <= ESCALATION_MAX_ATTEMPTS; attempt++) {
    console.log(`\n  Escalation attempt ${attempt}/${ESCALATION_MAX_ATTEMPTS}...`);
    const snapshot = [...currentByPath.entries()].map(([path, content]) => ({ path, content }));

    const failureShape = shapeFailure(lastReason, { touchedPaths: snapshot.map((f) => f.path), files: snapshot });
    const scan = { componentId, operation, stage: "escalation" as const, attempt };
    const failureText = sanitizeAndRecord(failureShape.text, { ...scan, source: "failure" });
    const ledgerText = sanitizeAndRecord(renderLedger(ledger), { ...scan, source: "ledger" });
    shaped = failureShape;
    const finishRound = (outcome: LedgerOutcome, kinds: string[], target: string | null, next?: ShapedFailure): void => {
      ledger = appendLedger(ledger, {
        round: attempt,
        kinds,
        target,
        outcome,
        ...(next ? { errorClass: next.errorClass, location: next.locations[0] ?? null } : outcome === "edits did not apply" ? { errorClass: "apply" as const } : outcome === "no usable reply" ? { errorClass: "call" as const } : {}),
      });
    };

    let verdict;
    try {
      verdict = await callEscalation(componentId, operation, instruction, snapshot, neighborContext, failureText, attempt, {
        ...(ledgerText !== "" ? { ledger: ledgerText } : {}),
        locations: failureShape.locations,
      });
    } catch (err) {
      lastReason = `escalation call threw: ${err instanceof Error ? err.message : String(err)}`;
      console.log(`   ❌ ${lastReason}`);
      finishRound("no usable reply", [], null);
      continue;
    }
    const kinds = verdict.edits.map((e) => e.kind);
    const target = verdict.edits[0]?.path ?? null;

    if (verdict.suspicious_injected_instruction) {
      console.log(`   ⚠ Model self-reported suspicious instruction-like content in the dependency context.`);
    }
    console.log(`   Reasoning: ${verdict.reasoning}`);

    // AI-02: the model says this needs a capability Purix does not have and proposes nothing. A second call would repeat the
    // same answer, so stop here with a message the person can act on.
    if (verdict.is_new_capability && verdict.edits.length === 0) {
      lastReason =
        `capability gap: Purix cannot make this kind of change automatically yet, and nothing was changed. ` +
        `You can make the edit by hand, then run \`purix ingest\` (or \`purix check\`) so Purix picks it up.` +
        (verdict.reasoning.trim() ? ` The model's reason: ${verdict.reasoning.trim().slice(0, 300)}` : "");
      recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "capability_gap", attempts: attempt } });
      return { ok: false, fromLibrary: false, reason: lastReason };
    }

    const applied = applyEdits(verdict.edits, snapshot);
    recordAnchorOutcome(componentId, applied);
    if (applied.ok) for (const p of applied.partialLinePaths ?? []) partialPaths.add(p);
    if (!applied.ok) {
      lastReason = applied.reason;
      console.log(`   ❌ edits didn't apply: ${applied.reason}`);
      finishRound(verdict.edits.length === 0 ? "no edits proposed" : "edits did not apply", kinds, target);
      continue;
    }

    const { candidateFiles, oscillation } = applyEditsAndCheckOscillation(currentByPath, applied.files, oscillationGuard);
    if (oscillation.hit) {
      lastReason = oscillation.reason!;
      finishRound("same state as before", kinds, target);
      console.log(`   🔁 ${lastReason}`);
      recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "oscillation_aborted", attempts: attempt } });
      return { ok: false, fromLibrary: false, reason: lastReason };
    }

    // ADR-037: verifyInSandbox's own first check scans candidateFiles —
    // exactly what the escalation LLM just returned, post-applyEdits —
    // for secret-shaped content and fails closed before any of it
    // reaches the real working tree. Not a separate call here on
    // purpose: see sandbox/sandbox.ts's verifyInSandbox for why the
    // check lives there instead of duplicated at every call site that
    // can reach a real write.
    const verification = verify(componentId, candidateFiles, targetDir);
    if (verification.status === "pass") {
      console.log(`   ✅ escalation attempt ${attempt} passes verification.`);
      recordEvent("verification_pass", { component_id: componentId, operation, detail: { stage: "escalation", attempt, isolation: verification.isolation, ...(verification.notTested ? { not_tested: verification.notTested } : {}), ...searchCutDetail(verification), ...securityNotesDetail(verification) } });

      const lang = resolveLanguage(componentId, targetDir);
      const provider = getLanguageProvider(lang);
      const testIntegrityChecker = await provider?.getTestIntegrityChecker?.();
      const testFilesBefore = originalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
      const testFilesAfter = candidateFiles.map((f) => ({ path: f.path, content: f.new_content })).filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
      const testIntegrity = testIntegrityChecker
        ? testIntegrityChecker.check(testFilesBefore, testFilesAfter)
        : { flagged: true, findings: [{ path: "unknown", reason: `no test integrity checker registered for language ${lang} — failing closed` }] };
      if (testIntegrity.flagged) {
        console.log(`   🛑 Refusing operation library promotion: test integrity check flagged test assertion weakening or skip additions.`);
        for (const f of testIntegrity.findings) {
          console.log(`       - ${f.path}: ${f.reason}`);
        }
        recordEvent("escalation_outcome", {
          component_id: componentId,
          operation,
          detail: { outcome: "fresh_fix_revet_failed", attempts: attempt },
        });
        return { ok: true, files: candidateFiles, fromLibrary: false, verification, ...(partialPaths.size > 0 ? { partialLinePaths: [...partialPaths] } : {}) };
      }

      await assertAuthorizedToApprove();
      const promote = await confirm(
        `\nFix verified. Promote into the local operation library so this exact task type is handled locally at zero LLM cost next time (§5.2, §7.5 checkpoint)?`
      );
      recordEvent("confirm_response", {
        component_id: componentId,
        operation,
        detail: { checkpoint_kind: "library_promotion", approved: promote },
      });
      if (promote) {
        promoteOperation({
          component_id: componentId,
          operation,
          task_signature: taskSignature,
          description: verdict.reasoning,
          edits: verdict.edits,
        });
        recordMemory({
          component_id: componentId,
          kind: "escalation_promotion",
          summary: `Promoted a local operation for: "${instruction}"`,
          detail: verdict.reasoning,
        });
        console.log(`  Promoted, and logged to Repository Memory (§11.1).`);
      } else {
        recordMemory({
          component_id: componentId,
          kind: "escalation_fix_not_promoted",
          summary: `Escalation fixed "${instruction}" but promotion was declined.`,
        });
      }

      recordEvent("escalation_outcome", {
        component_id: componentId,
        operation,
        detail: { outcome: "fresh_fix", attempts: attempt, promoted: promote },
      });
      return { ok: true, files: candidateFiles, fromLibrary: false, verification, ...(partialPaths.size > 0 ? { partialLinePaths: [...partialPaths] } : {}) };
    }

    // A8-1: same rule as the repair loop. This is the high-tier model, so the second attempt is the most expensive place to repeat it.
    const stop = infrastructureStopOf(verification);
    if (stop) {
      recordEvent("verification_failure", { component_id: componentId, operation, detail: { stage: "escalation", attempt, reason: verification.reason, infrastructure: stop.kind, repair_skipped: true } });
      recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "infrastructure_stop", attempts: attempt, infrastructure: stop.kind } });
      return { ok: false, fromLibrary: false, reason: stopMessage(stop), infrastructure: infrastructureOf(stop) };
    }

    lastReason = verification.reason;
    console.log(`   ❌ still failing: ${verification.reason}`);
    recordEvent("verification_failure", {
      component_id: componentId,
      operation,
      detail: { stage: "escalation", attempt, reason: verification.reason },
    });

    const after = shapeFailure(lastReason, { touchedPaths: candidateFiles.map((f) => f.path), files: candidateFiles.map((f) => ({ path: f.path, content: f.new_content })) });
    finishRound("verification failed", kinds, target, after);
    const before = shaped;
    if (earlyStop && before !== null && sameFailurePlace({ errorClass: before.errorClass, location: before.locations[0] ?? null }, { errorClass: after.errorClass, location: after.locations[0] ?? null })) {
      recordEvent("repair_early_stop", { component_id: componentId, operation, detail: { stage: "escalation", attempt, error_class: after.errorClass, location: after.locations[0] ?? null } });
      recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "early_stop", attempts: attempt } });
      return { ok: false, fromLibrary: false, reason: lastReason };
    }
  }

  console.log(`\n🛑 Escalation capped at ${ESCALATION_MAX_ATTEMPTS} attempts — handing back to you. No real files were touched.`);
  recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "exhausted", attempts: ESCALATION_MAX_ATTEMPTS } });
  return { ok: false, fromLibrary: false, reason: lastReason };
}