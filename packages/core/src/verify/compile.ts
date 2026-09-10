// src/verify/compile.ts
import type { ChangeEdit, ChangeVerdict } from "../llm/classify.js";
import { applyErrorHandlingTransform, applyControlFlowTransform } from "./ast_transforms.js";
import { isTestFilePath } from "./test_integrity.js";

export interface CompiledFileChange {
  path: string;
  new_content: string;
}

export type CompileResult =
  | { ok: true; files: CompiledFileChange[] }
  | { ok: false; reason: string };

const WIRED_UP_OPERATIONS = new Set([
  "update_prompt_text",
  "update_config_value",
  "swap_tool_binding",
  "add_error_handling",
  "change_control_flow",
]);

/**
 * Function-form replacement, always. `String.prototype.replace` with a
 * STRING second argument interprets $&, $$, $1 etc as special patterns
 * even when the search value is a plain string — not just with regex.
 * If new_text ever legitimately contains a literal "$&", the naive form
 * would corrupt it silently. Function form sidesteps that entirely.
 */
function applyUniqueReplacement(
  content: string,
  oldText: string,
  newText: string
): { ok: true; content: string } | { ok: false; reason: string } {
  const occurrences = oldText.length === 0 ? 0 : content.split(oldText).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: `anchor text not found in file` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `anchor text found ${occurrences} times — ambiguous, refusing to guess which one`,
    };
  }
  return { ok: true, content: content.replace(oldText, () => newText) };
}

function applyPromptTextEdit(
  content: string,
  edit: Extract<ChangeEdit, { kind: "prompt_text" }>
): { ok: true; content: string } | { ok: false; reason: string } {
  return applyUniqueReplacement(content, edit.old_text, edit.new_text);
}

/**
 * Config edits are scoped by key first, then old_value, so a value like
 * "5" doesn't match every line that happens to contain a 5. Still a
 * text-anchor approach, not a real config parser — good enough for v1,
 * and it fails loudly instead of guessing when it can't be sure.
 */
function applyConfigValueEdit(
  content: string,
  edit: Extract<ChangeEdit, { kind: "config_value" }>
): { ok: true; content: string } | { ok: false; reason: string } {
  const lines = content.split("\n");
  const keyLines = lines
    .map((line, i) => ({ line, i }))
    .filter(({ line }) => line.includes(edit.key));

  if (keyLines.length === 0) {
    return { ok: false, reason: `key "${edit.key}" not found in file` };
  }

  const candidateLines = keyLines.filter(({ line }) => line.includes(edit.old_value));
  if (candidateLines.length === 0) {
    return {
      ok: false,
      reason: `key "${edit.key}" found, but old_value "${edit.old_value}" doesn't appear on that line`,
    };
  }
  if (candidateLines.length > 1) {
    return {
      ok: false,
      reason: `key "${edit.key}" with old_value "${edit.old_value}" is ambiguous — matches ${candidateLines.length} lines`,
    };
  }

  const { i } = candidateLines[0]!;
  lines[i] = lines[i]!.replace(edit.old_value, () => edit.new_value);
  return { ok: true, content: lines.join("\n") };
}

function applyToolBindingEdit(
  content: string,
  edit: Extract<ChangeEdit, { kind: "tool_binding" }>
): { ok: true; content: string } | { ok: false; reason: string } {
  const occurrences = edit.old_tool.length === 0 ? 0 : content.split(edit.old_tool).length - 1;
  if (occurrences === 0) {
    return { ok: false, reason: `tool "${edit.old_tool}" not found in file` };
  }
  if (occurrences > 1) {
    return {
      ok: false,
      reason: `tool "${edit.old_tool}" appears ${occurrences} times — ambiguous, refusing to guess which binding to swap`,
    };
  }
  return { ok: true, content: content.replace(edit.old_tool, () => edit.new_tool) };
}

function applyErrorHandlingEdit(
  content: string,
  edit: Extract<ChangeEdit, { kind: "error_handling" }>
): { ok: true; content: string } | { ok: false; reason: string } {
  return applyErrorHandlingTransform(content, edit.path, edit.function_name, edit.max_retries);
}

function applyControlFlowEdit(
  content: string,
  edit: Extract<ChangeEdit, { kind: "control_flow" }>
): { ok: true; content: string } | { ok: false; reason: string } {
  return applyControlFlowTransform(content, edit.path, edit.function_name, edit.variable_names);
}


export interface CompilePatchOptions {
  /**
   * §E-TESTLOCK. When true, any edit targeting a path that
   * isTestFilePath() recognizes is rejected outright — the whole patch,
   * not just that one edit — before anything is applied. This is NOT
   * set for the direct Instruction-Path call in cli.ts (a human
   * explicitly asking to change a test is a legitimate, human-directed
   * action). It IS set for every repair-loop caller (heal.ts's
   * self-healing, escalate.ts's escalation, including cached-library
   * replay) via applyEdits below, because those loops exist to satisfy
   * the test suite, not to rewrite it. Per Core Principle A1: "the
   * verification target must not be reachable by the thing being
   * verified." A rejection here is a compile failure like any other —
   * it counts as a failed attempt against the caller's own oscillation
   * guard / retry cap, it just never reaches the sandbox at all.
   */
  blockTestFileEdits?: boolean;
}

/**
 * Applies a verdict's edits deterministically against the current file
 * contents. Returns the full set of changed files, or a reason it
 * refused — it never partially guesses. Multiple edits on the same file
 * are threaded in order.
 */
export function compilePatch(
  verdict: ChangeVerdict,
  currentFiles: { path: string; content: string }[],
  opts: CompilePatchOptions = {}
): CompileResult {
  if (!WIRED_UP_OPERATIONS.has(verdict.operation)) {
    return {
      ok: false,
      reason: `operation "${verdict.operation}" is defined in the Section 6 taxonomy but has no deterministic Patch Compiler transform yet — not applying anything`,
    };
  }

  if (verdict.edits.length === 0) {
    return { ok: false, reason: `classifier returned no edits to apply` };
  }

  if (opts.blockTestFileEdits) {
    const testTargets = [...new Set(verdict.edits.filter((e) => isTestFilePath(e.path)).map((e) => e.path))];
    if (testTargets.length > 0) {
      return {
        ok: false,
        reason:
          `§E-TESTLOCK: this patch touches test file(s) ${testTargets.join(", ")} — a self-healing or ` +
          `escalation repair may never modify the file it's being verified against (Core Principle A1). ` +
          `Rejected outright, nothing applied. If the test itself genuinely needs to change, that's a ` +
          `human decision via a direct "purix modify" instruction, not an automated repair loop.`,
      };
    }
  }

  const contentByPath = new Map(currentFiles.map((f) => [f.path, f.content]));
  const workingByPath = new Map(contentByPath);

  for (const edit of verdict.edits) {
    if (!contentByPath.has(edit.path)) {
      return {
        ok: false,
        reason: `edit references "${edit.path}", which isn't one of this component's known files — refusing to touch a file outside the manifest`,
      };
    }

    const current = workingByPath.get(edit.path)!;
    let result: { ok: true; content: string } | { ok: false; reason: string };

    switch (edit.kind) {
      case "prompt_text":
        result = applyPromptTextEdit(current, edit);
        break;
      case "config_value":
        result = applyConfigValueEdit(current, edit);
        break;
      case "tool_binding":
        result = applyToolBindingEdit(current, edit);
        break;
      case "error_handling":
        result = applyErrorHandlingEdit(current, edit);
        break;
      case "control_flow":
        result = applyControlFlowEdit(current, edit);
        break;
    }
    if (!result.ok) {
      return { ok: false, reason: `${edit.path}: ${result.reason}` };
    }
    workingByPath.set(edit.path, result.content);
  }

  const changedPaths = new Set(verdict.edits.map((e) => e.path));
  const files: CompiledFileChange[] = [...changedPaths].map((path) => ({
    path,
    new_content: workingByPath.get(path)!,
  }));

  

  return { ok: true, files };
}

// Security fix (review finding #4): maps each ChangeEdit kind to its
// corresponding Section 6 taxonomy operation string, so applyEdits can
// check what the edits actually are instead of a hardcoded placeholder.
const EDIT_KIND_TO_OPERATION: Record<ChangeEdit["kind"], string> = {
  prompt_text: "update_prompt_text",
  config_value: "update_config_value",
  tool_binding: "swap_tool_binding",
  error_handling: "add_error_handling",
  control_flow: "change_control_flow",
};

/**
 * The only entry point heal.ts and escalate.ts use to turn model-
 * returned edits into file content — including escalate.ts's
 * cached-library replay path, not just fresh LLM output. §E-TESTLOCK is
 * therefore unconditional here: every caller of applyEdits is, by
 * construction, a repair loop rather than a direct human instruction.
 *
 * BUG FIX (review finding #4): this used to call compilePatch with a
 * hardcoded `operation: "update_prompt_text"` regardless of what the
 * edits actually contained. Since that string is always present in
 * WIRED_UP_OPERATIONS, compilePatch's top-level "is this operation wired
 * up" check could never fire on this call path — it was always matching
 * a fixed string against a set that fixed string is always in. The
 * individual edit-kind handlers still validated their own inputs
 * correctly, so this was never directly exploitable, but the intended
 * second layer of defense was decorative on exactly the path with the
 * least human oversight (the automated repair loop).
 *
 * Now each edit's real kind is checked against the wired-operation set
 * directly, before compilePatch runs at all. If a new ChangeEdit kind is
 * ever added to the schema without a matching Patch Compiler transform
 * landing at the same time, the repair loop actually refuses it instead
 * of silently attempting (or masking a failure to attempt) a transform
 * that doesn't exist for it.
 */
export function applyEdits(
  edits: ChangeEdit[],
  currentFiles: { path: string; content: string }[]
): CompileResult {
  const unwiredKinds = [...new Set(edits.map((e) => e.kind))].filter(
    (kind) => !isWiredOperation(EDIT_KIND_TO_OPERATION[kind])
  );
  if (unwiredKinds.length > 0) {
    return {
      ok: false,
      reason:
        `edit kind(s) ${unwiredKinds.join(", ")} have no deterministic Patch Compiler transform wired ` +
        `up yet — not applying anything`,
    };
  }

  // The real per-kind gate already happened above; compilePatch's
  // top-level operation check is now redundant-but-harmless for this call
  // path, so any wired operation string satisfies it. Derived from the
  // first edit rather than re-introducing a hardcoded literal.
  const operation: ChangeVerdict["operation"] =
    edits.length > 0 ? (EDIT_KIND_TO_OPERATION[edits[0]!.kind] as ChangeVerdict["operation"]) : "update_prompt_text";

  return compilePatch({ operation, edits } as ChangeVerdict, currentFiles, {
    blockTestFileEdits: true,
  });
}

export function isWiredOperation(operation: string): boolean {
  return WIRED_UP_OPERATIONS.has(operation);
}


/**
 * Merges a changed subset back into the component's full file list.
 * Everything downstream (sandbox verify, real-file verify, apply-to-disk)
 * must operate on the FULL set, not just the literally-edited files —
 * otherwise an unedited sibling file that breaks because of the edit
 * never gets type-checked at all. This is the fix for that gap.
 */
export function mergeFileChanges(
  original: { path: string; content: string }[],
  changes: { path: string; new_content: string }[]
): { path: string; new_content: string }[] {
  const changedByPath = new Map(changes.map((c) => [c.path, c.new_content]));
  return original.map((f) => ({
    path: f.path,
    new_content: changedByPath.get(f.path) ?? f.content,
  }));
}