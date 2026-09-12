// src/recovery/escalate.ts
// ADR-043 Caveat: Escalation baseline coverage is a raised floor, not a closed gap — stated limit, not a promise.
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
import { OscillationGuard } from "./oscillation_guard.js";

const ESCALATION_MAX_ATTEMPTS = 2; // separate from heal.ts's 3 — §6.1's "three distinct retry caps"

export interface EscalationResult {
  ok: boolean;
  files?: CompiledFileChange[];
  fromLibrary: boolean;
  reason?: string;
}

async function gatherNeighborContext(
  componentId: string,
  targetDir: string
): Promise<{ component_id: string; path: string; content: string }[]> {
  const entry = readManifest(componentId);
  if (!entry) return [];
  const neighborIds = [...new Set([...(entry.depends_on ?? []), ...(entry.depended_on_by ?? [])])];
  const out: { component_id: string; path: string; content: string }[] = [];
  for (const nid of neighborIds) {
    const nEntry = readManifest(nid);
    if (!nEntry) continue;
    const files = await readComponentFiles(nEntry, targetDir);
    for (const f of files) out.push({ component_id: nid, path: f.path, content: f.content });
  }
  return out;
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
  targetDir: string = process.cwd()
): Promise<EscalationResult> {
  console.log(`\n⤴ Escalating "${componentId}" (§6.3) — high-tier model, real cost, should stay rare.`);
  recordEvent("escalation_start", { component_id: componentId, operation, detail: { instruction, failure_reason: failureReason } });

  const taskSignature = computeTaskSignature(componentId, operation, instruction);

  const cached = findLibraryMatch(taskSignature);
  if (cached) {
    console.log(`  Match found in the local operation library — reapplying with no LLM call (§5.2).`);
    const replay = applyEdits(cached.edits, originalFiles);
    if (replay.ok) {
      const merged = mergeFileChanges(originalFiles, replay.files);
      const verification = verifyInSandbox(componentId, merged, targetDir);
      if (verification.status === "pass") {
        markLibraryUsed(taskSignature);
        recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "library_hit" } });
        return { ok: true, files: merged, fromLibrary: true };
      }
      console.log(`  Cached fix no longer verifies against current file state — falling back to a fresh escalation.`);
    } else {
      console.log(`  Cached fix's anchor text no longer matches (${replay.reason}) — falling back to a fresh escalation.`);
    }
  }

  const neighborContextRaw = await gatherNeighborContext(componentId, targetDir);

  // §E10: this content is about to become prompt text sent to the
  // escalation LLM (below), not a write target — scanForSecrets() only
  // ever blocks writes, so it doesn't apply here. Redact in place
  // instead. Scrubbing happens BEFORE the injection scan too, so
  // nothing downstream — logging, the confirm prompt, or the prompt
  // itself — ever sees an unredacted secret from a neighbor file.
  const scrubbed = scrubSecrets(neighborContextRaw);
  const totalScrubbed = scrubbed.reduce((sum, s) => sum + s.scrubbedCount, 0);
  if (totalScrubbed > 0) {
    console.log(`  🔒 Redacted ${totalScrubbed} secret-shaped value(s) from dependency context before sending it to the escalation LLM.`);
  }
  const neighborContext = neighborContextRaw.map((n, i) => ({ ...n, content: scrubbed[i]!.content }));

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

  for (let attempt = 1; attempt <= ESCALATION_MAX_ATTEMPTS; attempt++) {
    console.log(`\n  Escalation attempt ${attempt}/${ESCALATION_MAX_ATTEMPTS}...`);
    const snapshot = [...currentByPath.entries()].map(([path, content]) => ({ path, content }));

    let verdict;
    try {
      verdict = await escalateJudgeAndRepair(componentId, operation, instruction, snapshot, neighborContext, lastReason, attempt);
    } catch (err) {
      lastReason = `escalation call threw: ${err instanceof Error ? err.message : err}`;
      console.log(`   ❌ ${lastReason}`);
      continue;
    }

    if (verdict.suspicious_injected_instruction) {
      console.log(`   ⚠ Model self-reported suspicious instruction-like content in the dependency context.`);
    }
    console.log(`   Reasoning: ${verdict.reasoning}`);

    const applied = applyEdits(verdict.edits, snapshot);
    if (!applied.ok) {
      lastReason = applied.reason;
      console.log(`   ❌ edits didn't apply: ${applied.reason}`);
      continue;
    }

    for (const f of applied.files) currentByPath.set(f.path, f.new_content);
    const candidateFiles = [...currentByPath.entries()].map(([path, new_content]) => ({ path, new_content }));

    const oscillation = oscillationGuard.check(candidateFiles.map((f) => ({ path: f.path, content: f.new_content })));
    if (oscillation.hit) {
      lastReason = oscillation.reason!;
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
    const verification = verifyInSandbox(componentId, candidateFiles, targetDir);
    if (verification.status === "pass") {
      console.log(`   ✅ escalation attempt ${attempt} passes verification.`);
      recordEvent("verification_pass", { component_id: componentId, operation, detail: { stage: "escalation", attempt } });

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
        return { ok: true, files: candidateFiles, fromLibrary: false };
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
      return { ok: true, files: candidateFiles, fromLibrary: false };
    }

    lastReason = verification.reason;
    console.log(`   ❌ still failing: ${verification.reason}`);
    recordEvent("verification_failure", {
      component_id: componentId,
      operation,
      detail: { stage: "escalation", attempt, reason: verification.reason },
    });
  }

  console.log(`\n🛑 Escalation capped at ${ESCALATION_MAX_ATTEMPTS} attempts — handing back to you. No real files were touched.`);
  recordEvent("escalation_outcome", { component_id: componentId, operation, detail: { outcome: "exhausted", attempts: ESCALATION_MAX_ATTEMPTS } });
  return { ok: false, fromLibrary: false, reason: lastReason };
}