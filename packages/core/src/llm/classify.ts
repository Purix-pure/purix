// src/llm/classify.ts
import { z } from "zod";
import type { TopologyPlan } from "../manifest/schema.js";
import { assertBudgetAvailable } from "./budget.js";
import { recordProviderUsage, recordSavings } from "./budget.js";
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from "./circuit.js";
import { ModelCallTimeoutError, TIMEOUT_MAX_RETRIES, TRANSIENT_MAX_RETRIES, isTimeoutError, retryDelayMs, retrySleep } from "./call_failure.js";
import { llmTimeoutMs } from "../platform/net.js";
import { scanForInjectionAttempts } from "./injection.js";
import { getProvider, priceFor, type ModelTier } from "./providers.js";
import { recordLlmCall, markLastCallFormatError, markLastCallOperation } from "./call_log.js";
import type { RoutingCall, RoutingDecision } from "./router.js";
import { routeTier } from "./router.js";
import { detectTestRunner, testRunnerGuidance, greenfieldLanguage } from "./test_runner.js";
import { buildContextPack, buildProjectOnlyPack } from "./context/pack.js";
import { loadContextConfig } from "./context/config.js";
import { buildRepairFilesBlock } from "./context/failure_windows.js";
import { sanitizeAndRecord } from "./input_scan.js";
import { scrubOutboundPrompt, scrubOutboundText } from "../security/outbound_scrub.js";
import type { FailureLocation } from "../verify/failure_shape.js";
import { OPERATIONS } from "./prompts/edit_kinds.js";
import {
  greenfieldPrompt, mentionPrompt, refinePrompt, classifyPrompt, diffPrompt, repairPrompt, formatRetryPrompt, compileRetryNotice,
} from "./prompts/build.js";
import type { PromptPair } from "./prompts/frames.js";

export type { ModelTier };

// NOTE on provenance: this file used to instantiate @google/genai directly
// and was the single place Purix was coupled to Gemini specifically. That
// coupling now lives behind llm/providers.ts (BYOK: Gemini/OpenAI/Anthropic/etc.,
// selected by PURIX_LLM_PROVIDER or `purix provider set`). callLlm() below
// is vendor-neutral, handling all configured providers. Every call site is
// vendor-agnostic.
// ADR-031 Caveat: Trust scorer accuracy is a raised floor, not a closed gap — stated limit, not a promise.

const TopologyPlanSchema = z.object({
  component_id: z.string(),
  component_type: z.string(),
  files: z.array(
    z.object({
      path: z.string(),
      purpose: z.string(),
      starter_content: z.string(),
    })
  ),
  depends_on: z.array(z.string()),
});

function promptChars(prompt: string | PromptPair): number {
  return typeof prompt === "string" ? prompt.length : prompt.system.length + prompt.user.length;
}

function modelName(provider: { modelFor(tier: ModelTier): string }, tier: ModelTier): string {
  try { return provider.modelFor(tier); } catch { return "unknown"; }
}

/**
 * `callType` names what this call is for. It is required: every provider call lands one row in llm_call_log (AI-05), and a
 * call that cannot say what it is for would show up as an unlabelled line in the report. Sizes and timings are recorded,
 * never prompt or reply text.
 */
export async function callLlm(
  prompt: string | PromptPair,
  callType: RoutingCall,
  tier: ModelTier = "low",
  attempt = 1,
  savingsContext?: { call: RoutingCall; decision: RoutingDecision }
): Promise<string> {
  // The two refusals that cost nothing (an open circuit breaker, an unusable
  // provider configuration) run BEFORE the budget reservation. Reserving first
  // meant each refusal left its estimate committed with no call behind it, so
  // a tripped breaker or a missing provider slowly drained the ceiling
  // (beta test report 2026-09-30, problem 5; the catch block below already
  // releases the reservation for a call that was actually attempted).
  assertCircuitClosed();
  const provider = getProvider();
  const reserved = assertBudgetAvailable();
  const startedAt = Date.now();
  try {
    // A7-1: the one place text leaves for a provider. Known secret formats are redacted on the way out (component files,
    // the instruction, the rejected reply of a format re-ask, anything a caller put in the prompt) and on the way back.
    // promptChars below stays the size of what the caller built, so the call log is unchanged.
    const outbound = scrubOutboundPrompt(prompt).prompt;
    const result = typeof outbound === "string"
      ? await provider.generate(outbound, tier)
      : await provider.generate(outbound.user, tier, outbound.system);
    recordProviderUsage(result.usage, provider.id, tier, reserved);
    {
      const price = priceFor(provider.id, tier);
      recordLlmCall({
        callType, tier, provider: provider.id, model: modelName(provider, tier), promptChars: promptChars(prompt),
        inputTokens: result.usage.inputTokens, outputTokens: result.usage.outputTokens,
        ...(result.usage.cachedInputTokens !== undefined ? { cachedInputTokens: result.usage.cachedInputTokens } : {}),
        retry: attempt > 1, latencyMs: Date.now() - startedAt,
        costUsd: (result.usage.inputTokens / 1_000_000) * price.input + (result.usage.outputTokens / 1_000_000) * price.output,
        status: "ok",
      });
    }
    if (savingsContext) {
      recordSavings(savingsContext.call, savingsContext.decision, result.usage, provider.id);
    }
    recordCircuitSuccess();
    return scrubOutboundText(result.text ?? "").text;
  } catch (err: any) {
    // BUG FIX (GAPS-REPORT-2 §2): assertBudgetAvailable() reserves
    // estimatedCost into total_spent_usd at the top of THIS invocation —
    // including every retried attempt, since each is its own real call
    // with its own real spend risk. Previously, only the success path
    // ever reconciled that reservation (via recordProviderUsage a few
    // lines up); every failure path fell straight through to `throw err`
    // with no refund, permanently committing the reservation with zero
    // dollars of real spend behind it. Enough consecutive failures (a
    // misconfigured API key, a provider outage) would exhaust the entire
    // cost ceiling and then correctly-but-wrongly refuse every
    // subsequent call, including ones that would have succeeded — a
    // self-inflicted denial-of-service on the tool's own core function.
    //
    // recordProviderUsage() already computes exactly the right refund
    // for a zero-usage call: actualCost is 0, so delta = 0 - reserved =
    // -reserved, releasing this attempt's reservation back out. Doing
    // this here, before either retrying (which reserves its own
    // separate amount on its own recursive invocation) or giving up,
    // means every attempt's reservation is accounted for exactly once,
    // whichever way this attempt ends.
    recordProviderUsage({ inputTokens: 0, outputTokens: 0 }, provider.id, tier, reserved);
    const timedOut = isTimeoutError(err);
    recordLlmCall({
      callType, tier, provider: provider.id, model: modelName(provider, tier), promptChars: promptChars(prompt),
      inputTokens: 0, outputTokens: 0, retry: attempt > 1, latencyMs: Date.now() - startedAt, costUsd: 0, status: timedOut ? "timeout" : "provider_error",
    });
    // A10c-1: a timeout is its own class. It is retried (fewer times, because each try costs a whole deadline), counted by the
    // breaker like any transient failure, and ends in an error that says what happened, not the bare "aborted due to timeout".
    if (timedOut || provider.isTransientError(err)) {
      recordCircuitFailure();
      const maxRetries = timedOut ? TIMEOUT_MAX_RETRIES : TRANSIENT_MAX_RETRIES;
      if (attempt <= maxRetries) {
        const waitMs = retryDelayMs(attempt);
        console.log(
          `${timedOut ? "Timeout" : "Transient error"} from ${provider.id} — retrying in ${waitMs / 1000}s (attempt ${attempt}/${maxRetries}): ${err?.message ?? err}`
        );
        await retrySleep(waitMs);
        return callLlm(prompt, callType, tier, attempt + 1, savingsContext);
      }
      if (timedOut) throw new ModelCallTimeoutError(provider.id, attempt, llmTimeoutMs());
    }
    throw err;
  }
}

type JsonCheck<T> = { ok: true; data: T } | { ok: false; problem: string; error: Error };

/**
 * The one place a model reply is read as JSON and checked against its schema. Returns what went wrong as data
 * (`problem` for the model, `error` for the person) instead of throwing, so callJson() can ask once more.
 */
function checkModelJson<S extends z.ZodType>(raw: string, schema: S, what: string): JsonCheck<z.infer<S>> {
  const cleaned = raw.replace(/```json|```/g, "").trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    markLastCallFormatError();
    const excerpt = cleaned.slice(0, 80).replace(/\s+/g, " ");
    return {
      ok: false,
      problem: cleaned.length === 0 ? "it was empty" : "it was not valid JSON",
      error: new Error(
        `The model's ${what} reply was not valid JSON (it began: "${excerpt}${cleaned.length > 80 ? "…" : ""}"). ` +
          `Nothing was changed. Try again, or pick a stronger model with "purix provider set".`,
      ),
    };
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    markLastCallFormatError();
    const issues = result.error.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    return {
      ok: false,
      problem: `it did not match the expected shape (${issues})`,
      error: new Error(`The model's ${what} reply did not match the expected shape (${issues}). Nothing was changed.`),
    };
  }
  return { ok: true, data: result.data };
}

/**
 * TEST-REPORT F9: turns "the model answered in prose / the wrong shape" into
 * a plain, actionable Error. Before this, a reply like "Sure! Here is the
 * change…" surfaced as `🛑 Unhandled error: Unexpected token 'S', "Sure! Here"…
 * is not valid JSON` (a raw SyntaxError, mislabelled as an internal bug), and
 * a wrong shape surfaced as a raw ZodError. A plain `Error` is what the CLI's
 * reportCommandFailure() treats as an expected, user-facing failure.
 */
export function parseModelJson<S extends z.ZodType>(raw: string, schema: S, what: string): z.infer<S> {
  const checked = checkModelJson(raw, schema, what);
  if (!checked.ok) throw checked.error;
  return checked.data;
}

/**
 * AI-01: calls the model and reads the reply as JSON. When the reply cannot be used (prose, a cut-off object, the wrong
 * shape) it asks ONE more time, with the same system text, the original request, the rejected reply (cut short, in its
 * own data block) and what was wrong with it. A second failure ends the way it always did: the same plain error, nothing
 * changed. The success path is exactly one call, as before. A provider error is not a format failure and keeps callLlm's
 * own backoff; each of the two calls reserves and releases its own budget.
 */
export async function callJson<S extends z.ZodType>(
  prompt: string | PromptPair,
  schema: S,
  what: string,
  callType: RoutingCall,
  options: { tier?: ModelTier; savingsContext?: { call: RoutingCall; decision: RoutingDecision } } = {},
): Promise<z.infer<S>> {
  const tier = options.tier ?? "low";
  const first = await callLlm(prompt, callType, tier, 1, options.savingsContext);
  const checked = checkModelJson(first, schema, what);
  if (checked.ok) return checked.data;

  const notice = formatRetryPrompt({ badReply: first, problem: checked.problem });
  const again: string | PromptPair = typeof prompt === "string" ? `${prompt}\n\n${notice}` : { system: prompt.system, user: `${prompt.user}\n\n${notice}` };
  const second = await callLlm(again, callType, tier, 1, options.savingsContext);
  return parseModelJson(second, schema, what);
}

export async function classifyGreenfield(componentName: string, intent?: string, opts: { language?: string } = {}): Promise<TopologyPlan> {
  // Decision 3 (resolved 2026-09-24, additive): widened from a name-only
  // signature so `purix change`'s create-proposal branch (IDEA-078) can
  // pass the user's full intent text as planning context, instead of
  // just the bare component name it derives. Existing callers
  // (bare `create <n>`, mcp-server's purix_create) are unaffected — when
  // no distinct `intent` is supplied, the prompt is byte-identical to
  // the prior one (no extra line), not just semantically equivalent.
  // ADR-058: a project that documents its own stack/security rules (AGENTS.md etc.)
  // lets planning respect them. Empty when there is no such file.
  const project = buildProjectOnlyPack();
  for (const n of project.notes) console.log(`  ${n}`);
  // AI-04: when the caller knows the project language (preflight chose it), the prompt follows it. Without one the
  // prompt is byte-identical to the one before, so existing callers and goldens are unaffected.
  const lang = opts.language !== undefined ? greenfieldLanguage(opts.language) : undefined;
  const prompt = greenfieldPrompt({
    componentName,
    intent,
    projectBlock: project.projectBlock,
    testGuidance: lang ? lang.testGuidance : testRunnerGuidance(detectTestRunner()),
    ...(lang ? { language: lang.label } : {}),
  });

  return callJson(prompt, TopologyPlanSchema, "planning", "greenfield_plan");
}

const MentionCandidatesSchema = z.object({ mentions: z.array(z.string()).max(40) });

/**
 * IDEA-078 Decision 2, LLM half: propose candidate mention strings (component
 * ids, file paths, identifiers) found in a free-text intent. This function
 * DECIDES NOTHING — it mirrors gates/trustgate.ts's shape (LLM produces a
 * signal, a separate deterministic function decides). Callers must pass the
 * result through mentions.ts's filterVerbatimMentions() before resolving, so
 * a model can only ever return strings the user actually wrote. Sends the
 * intent text only — no repository content and no manifest contents.
 */
export async function extractMentionCandidates(intent: string): Promise<string[]> {
  const prompt = mentionPrompt({ intent });
  return (await callJson(prompt, MentionCandidatesSchema, "mention extraction", "mention_extraction")).mentions;
}

const RefinedIntentSchema = z.object({
  explicit_instruction: z.string(),
  assumptions: z.array(z.string()),
});
export type RefinedIntent = z.infer<typeof RefinedIntentSchema>;

export async function refineIntent(
  componentId: string,
  rawInstruction: string,
  currentFiles: { path: string; content: string }[],
  recentMemory: string[] = []
): Promise<RefinedIntent> {
  // ADR-059: one policy decides how much repository context goes in. With
  // defaults and no project context file this is byte-identical to the old inline join.
  const pack = buildContextPack({ instruction: rawInstruction, files: currentFiles });
  for (const n of pack.notes) console.log(`  ${n}`);
  const prompt = refinePrompt({
    componentId,
    files: pack.filesBlock,
    // AI-12: memory lines were written in earlier sessions from model and tool text, so they pass the same scan as repair input.
    // A clean line comes back unchanged, so the prompt is byte-identical when nothing matched.
    memory: recentMemory.map((m) => sanitizeAndRecord(m, { componentId, operation: "refine", stage: "refine", source: "memory" })),
    projectBlock: pack.projectBlock,
    instruction: rawInstruction,
  });

  const decision = routeTier("intent_refinement");
  if (decision.tier === "low") {
    console.log(`  [router] ${decision.reason}`);
  }
  return callJson(prompt, RefinedIntentSchema, "intent refinement", "intent_refinement", { tier: decision.tier, savingsContext: { call: "intent_refinement", decision } });
}





const PromptTextEditSchema = z.object({
  path: z.string(),
  kind: z.literal("prompt_text"),
  old_text: z.string(),
  new_text: z.string(),
});
const ConfigValueEditSchema = z.object({
  path: z.string(),
  kind: z.literal("config_value"),
  key: z.string(),
  old_value: z.string(),
  new_value: z.string(),
});
const ToolBindingEditSchema = z.object({
  path: z.string(),
  kind: z.literal("tool_binding"),
  old_tool: z.string(),
  new_tool: z.string(),
});

const ErrorHandlingEditSchema = z.object({
  path: z.string(),
  kind: z.literal("error_handling"),
  function_name: z.string(),
  max_retries: z.number().int().min(1).max(10),
});
const ControlFlowEditSchema = z.object({
  path: z.string(),
  kind: z.literal("control_flow"),
  function_name: z.string(),
  variable_names: z.array(z.string()).min(2),
});

export const ChangeEditSchema = z.discriminatedUnion("kind", [PromptTextEditSchema, ConfigValueEditSchema, ToolBindingEditSchema, ErrorHandlingEditSchema,
  ControlFlowEditSchema,]);
export type ChangeEdit = z.infer<typeof ChangeEditSchema>;

const ChangeVerdictSchema = z.object({
  operation: z.enum(OPERATIONS),
  contract_changing: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  edits: z.array(ChangeEditSchema),
  suspicious_injected_instruction: z.boolean(),
});
export type ChangeVerdict = z.infer<typeof ChangeVerdictSchema>;

export async function classifyModification(
  componentId: string,
  instruction: string,
  currentFiles: { path: string; content: string }[],
  /** AI-11: set only on the one re-ask after the first edits failed to apply. The first call never passes it. */
  retry?: { reason: string }
): Promise<ChangeVerdict> {
  // ADR-059 / ADR-058: see refineIntent. Empty project block => identical prompt to before.
  const pack = buildContextPack({ instruction, files: currentFiles });
  for (const n of pack.notes) console.log(`  ${n}`);
  const base = classifyPrompt({ componentId, files: pack.filesBlock, projectBlock: pack.projectBlock, instruction });
  const prompt = retry ? { system: base.system, user: `${base.user}\n\n${compileRetryNotice({ reason: retry.reason })}` } : base;

  // AI-05: classification now goes through the router like refinement and escalation, so its tier choice is recorded.
  // The default is the low tier it always used; PURIX_TIER_CHANGE_CLASSIFICATION=high pins it up for measurement.
  const decision = routeTier("change_classification");
  const verdict = await callJson(prompt, ChangeVerdictSchema, "change classification", "change_classification", { tier: decision.tier, savingsContext: { call: "change_classification", decision } });
  markLastCallOperation(verdict.operation);
  return verdict;
}


// ---- Node 3b, second mode: diff-classify (§3.2, Bundle B v1.0) ----

/**
 * Diff-classify mode. Same structured verdict shape intent-classify
 * produces (operation, contract_changing, confidence, reasoning) — the
 * Change Classifier is still one step with two input shapes, not two
 * separate steps — but there's no developer instruction to classify
 * against here, only a diff that already landed.
 *
 * That changes what "confidence" has to mean, and this is the real
 * engineering surprise the build path (Appendix 1, step 3) warned
 * about. intent-classify's confidence answers "am I sure this is the
 * right operation and target for what the developer asked." There's no
 * "what the developer asked" on this path — an external diff arrives as
 * a fait accompli, not a request to be interpreted. The honest
 * equivalent: confidence that the diff is a coherent, single-purpose
 * instance of the operation type picked, rather than several unrelated
 * changes bundled together or a diff that doesn't cleanly fit any
 * bucket. Low confidence here means "ambiguous or mixed-purpose," never
 * "looks buggy" — correctness is the Verifier's job (Node 6: tsc, tests)
 * on both input paths, and Principle 2 keeps this step from quietly
 * becoming a second opinion on that.
 *
 * Deliberately returns no edits, and reuses the same OPERATIONS
 * taxonomy but not ChangeVerdictSchema itself. Node 4 (Patch Compiler)
 * is Instruction-Path only — a diff already produced its own after-
 * state on disk via ingest.ts's applyHunks, so there's nothing left to
 * compile. Threading an always-empty edits array through code that
 * never reads it would just be a second, silently-unused copy of the
 * intent-classify shape; a smaller schema says only what's actually
 * true on this path.
 */
const DiffClassificationSchema = z.object({
  operation: z.enum(OPERATIONS),
  contract_changing: z.boolean(),
  confidence: z.number().min(0).max(1),
  reasoning: z.string(),
  suspicious_injected_instruction: z.boolean(),
});
export type DiffClassification = z.infer<typeof DiffClassificationSchema>;

export interface DiffClassificationInput {
  path: string;
  old_content: string | null; // null for a newly-added file
  new_content: string;
  status: "added" | "modified" | "deleted";
}

function formatDiffBlock(changes: DiffClassificationInput[]): string {
  return changes
    .map((c) => {
      if (c.status === "added" || c.old_content === null) {
        return `--- ${c.path} (NEW FILE) ---\n${c.new_content}`;
      }
      return `--- ${c.path} (BEFORE) ---\n${c.old_content}\n\n--- ${c.path} (AFTER) ---\n${c.new_content}`;
    })
    .join("\n\n");
}

/** Pre-LLM local pass (§9.3) — same "fast, local, before it reaches the model" discipline the escalation path applies to dependency context, run here against the diff content itself. */
export function scanDiffForInjectionAttempts(changes: DiffClassificationInput[]): { path: string; hits: string[] }[] {
  const findings: { path: string; hits: string[] }[] = [];
  for (const c of changes) {
    const hits = scanForInjectionAttempts(c.new_content);
    if (hits.length > 0) findings.push({ path: c.path, hits });
  }
  return findings;
}

/**
 * §9.3 pass over a component's EXISTING file content, not the developer's
 * instruction. classifyModification and refineIntent both paste
 * `currentFiles` verbatim into the prompt (filesBlock) as context — a file
 * already sitting in the component (from an earlier diff-ingest, a manual
 * edit, or anything else that landed before this scan existed) reaches the
 * model with no local gate unless this is called first. Same coverage
 * classifyDiff already gets via scanDiffForInjectionAttempts, applied to
 * the instruction-path's read side instead of the diff-path's write side.
 */
export function scanFilesForInjectionAttempts(files: { path: string; content: string }[]): { path: string; hits: string[] }[] {
  const findings: { path: string; hits: string[] }[] = [];
  for (const f of files) {
    const hits = scanForInjectionAttempts(f.content);
    if (hits.length > 0) findings.push({ path: f.path, hits });
  }
  return findings;
}

/**
 * Node 3b, diff-classify mode. `changes` should be limited to the files
 * the diff itself actually touched (ingest.ts's output) — not the
 * component's full file set the way classifyModification receives it —
 * since there's no instruction here to justify pulling in untouched
 * sibling files as context; it would just dilute the one thing this
 * call needs to judge.
 */
export async function classifyDiff(
  componentId: string,
  sourceAgent: string | null,
  changes: DiffClassificationInput[]
): Promise<DiffClassification> {
  const prompt = diffPrompt({ componentId, sourceAgent, diff: formatDiffBlock(changes) });

  return callJson(prompt, DiffClassificationSchema, "diff classification", "diff_classification");
}

// ---- Node 6: repair classification for the self-healing loop ----

const RepairResultSchema = z.object({
  edits: z.array(ChangeEditSchema),
  reasoning: z.string(),
});
export type RepairResult = z.infer<typeof RepairResultSchema>;



/**
 * Section 10 self-healing: feeds the exact tsc error back and asks for a
 * minimal fix, expressed the same restricted way as the Change Classifier
 * (edits only — never raw file content, keeping "LLM as arbiter, not
 * author" true even during repair).
 */
/** AI-12: what a repair round adds to the prompt beyond the failure text. Both fields are optional; with neither, the files and prompt are as before for any component under the full-view threshold. */
export interface RepairExtras {
  /** Rendered attempt ledger (recovery/repair_ledger.ts). Empty or missing means no ledger block. */
  ledger?: string;
  /** Places the verifier named (verify/failure_shape.ts). Used to cut a large component down to windows around them. */
  locations?: FailureLocation[];
}

export async function classifyRepair(
  componentId: string,
  operation: string,
  failingFiles: { path: string; content: string }[],
  tscError: string,
  attemptNumber: number,
  extras: RepairExtras = {}
): Promise<RepairResult> {
  // AI-12: a small component is sent whole, exactly as before. A component over the full-view threshold is shown as windows
  // around the lines the verifier named, plus the focused view of any other file. Edits are still applied to the full files.
  const cfg = loadContextConfig();
  const view = buildRepairFilesBlock(failingFiles, extras.locations ?? [], cfg, operation);
  const prompt = repairPrompt({
    componentId,
    operation,
    files: view.filesBlock,
    failure: tscError,
    attempt: attemptNumber,
    ...(extras.ledger !== undefined ? { ledger: extras.ledger } : {}),
  });

  // AI-05: repair goes through the router, default low (as before), so which tier repair should run on can be measured.
  const decision = routeTier("repair");
  return callJson(prompt, RepairResultSchema, "repair", "repair", { tier: decision.tier, savingsContext: { call: "repair", decision } });
}
