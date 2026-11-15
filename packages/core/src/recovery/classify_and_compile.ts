// packages/core/src/recovery/classify_and_compile.ts
//
// AI-11 (PURIX-33): classify a change and compile its edits, with one cheap re-ask when the edits do not apply.
//
// Before this, a failed compile (most often "anchor text not found") went straight to escalation: up to two more high-tier
// calls carrying every neighbouring file. Repair never saw compile errors, only sandbox failures. Here the same cheap-tier
// call is made once more with the failure and the nearest region of the file in the user message. Only a second miss falls
// through to escalation, exactly as before.
//
// What is NOT retried: an operation Purix cannot apply at all, a verdict with no edits (the model chose "unclassified"), and a
// test-file lock. Asking again would give the same answer.
//
// No console output here (single-point-check); the caller prints from the returned fields.
import { classifyModification, type ChangeVerdict } from "../llm/classify.js";
import { compilePatch, type CompileResult } from "../verify/compile.js";
import { recordEvent } from "../manifest/events.js";
import { gatherNeighborContext } from "./escalate.js";
import { scrubSecrets } from "../security/secrets.js";

type FileIn = { path: string; content: string };

export interface ClassifyAndCompileDeps {
  classify?: (componentId: string, instruction: string, files: FileIn[], retry?: { reason: string }, neighbors?: { component_id: string; path: string; content: string }[]) => Promise<ChangeVerdict>;
  /** Where the neighbouring components' files are read from. Default: the working directory. */
  targetDir?: string;
  /** Seam for tests: replaces reading neighbours from the manifest. */
  gatherNeighbors?: (componentId: string, targetDir: string) => Promise<{ files: { component_id: string; path: string; content: string }[]; omitted: string[] }>;
  compile?: (verdict: ChangeVerdict, files: FileIn[]) => CompileResult;
}

export interface ClassifyAndCompileResult {
  verdict: ChangeVerdict;
  compiled: CompileResult;
  /** True when a second classification call was made. */
  retried: boolean;
  /** True when that second call produced edits that applied. */
  recoveredByRetry: boolean;
  /** The first compile failure, kept when a retry happened so the caller can say what went wrong. */
  firstReason?: string;
}

/** Reasons where asking the model again cannot help. Everything else a failed compile says is about the edit text. */
export function isRetryableCompileReason(reason: string): boolean {
  if (/^operation ".*" cannot be applied automatically/.test(reason)) return false;
  if (/^classifier returned no edits/.test(reason)) return false;
  if (/have no deterministic Patch Compiler transform/.test(reason)) return false;
  if (reason.includes("§E-TESTLOCK")) return false;
  return true;
}

export async function classifyAndCompile(
  componentId: string,
  instruction: string,
  files: FileIn[],
  deps: ClassifyAndCompileDeps = {},
): Promise<ClassifyAndCompileResult> {
  const classify = deps.classify ?? classifyModification;
  const compile = deps.compile ?? compilePatch;

  // P6: the first classification already sees the neighbours (within the existing neighborMaxTokens budget), so "contract_changing" is
  // judged with the callers in view. Before this they were loaded only in escalation, after a first failure. Read-only context:
  // secrets are redacted here and the classifier screens it for injection, the same two steps escalation applies.
  const neighbors = await loadNeighbors(componentId, deps);
  const verdict = await classify(componentId, instruction, files, undefined, neighbors);
  const compiled = compile(verdict, files);
  if (compiled.ok || !isRetryableCompileReason(compiled.reason)) {
    return { verdict, compiled, retried: false, recoveredByRetry: false };
  }

  // The caller records the anchor outcome of whichever result it ends up with; the first miss is carried on the retry event.
  const firstReason = compiled.reason;
  const firstAnchorMiss = /anchor text not found/.test(firstReason);

  let verdict2: ChangeVerdict;
  try {
    verdict2 = await classify(componentId, instruction, files, { reason: firstReason }, neighbors);
  } catch {
    // The re-ask itself failed (provider or format). That must not turn a recoverable miss into a new kind of failure:
    // hand back the first result and let escalation run as it always did.
    recordEvent("compile_retry", { component_id: componentId, operation: verdict.operation, detail: { outcome: "failed", why: "second_call_failed", first_anchor_miss: firstAnchorMiss } });
    return { verdict, compiled, retried: true, recoveredByRetry: false, firstReason };
  }

  const compiled2 = compile(verdict2, files);
  recordEvent("compile_retry", { component_id: componentId, operation: verdict2.operation, detail: { outcome: compiled2.ok ? "recovered" : "failed", first_anchor_miss: firstAnchorMiss } });
  if (compiled2.ok) return { verdict: verdict2, compiled: compiled2, retried: true, recoveredByRetry: true, firstReason };
  return { verdict: verdict2, compiled: compiled2, retried: true, recoveredByRetry: false, firstReason };
}

async function loadNeighbors(componentId: string, deps: ClassifyAndCompileDeps): Promise<{ component_id: string; path: string; content: string }[]> {
  const gather = deps.gatherNeighbors ?? gatherNeighborContext;
  let gathered;
  try {
    gathered = await gather(componentId, deps.targetDir ?? process.cwd());
  } catch {
    return []; // context is a help, not a requirement: a neighbour that cannot be read must not stop the change
  }
  if (gathered.files.length === 0) return [];
  const scrubbed = scrubSecrets(gathered.files);
  const files = gathered.files.map((n, i) => ({ ...n, content: scrubbed[i]!.content }));
  if (gathered.omitted.length > 0) {
    files.push({ component_id: "omitted files", path: "(notice)", content: `These dependency files were left out to keep the request short: ${gathered.omitted.join(", ")}.` });
  }
  return files;
}
