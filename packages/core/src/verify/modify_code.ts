// src/verify/modify_code.ts
//
// AI-15a (PURIX-33): the size rules for the general "modify_code" operation.
//
// "modify_code" lets a plain code change that none of the named operations describes go through the same deterministic
// compiler as everything else. It adds no new kind of edit and no new freedom: it takes only the three text edit kinds,
// on files the component already tracks (compilePatch's own path guard), and these limits keep a single verdict small
// enough to read in a diff. Sandbox verification, TrustGate and the security gate run on the result as for any edit.
//
// Pure function; no I/O, no console output.
import type { ChangeEdit } from "../llm/classify.js";
import { MODIFY_CODE_MAX_EDITS, MODIFY_CODE_MAX_LINES } from "../llm/prompts/edit_kinds.js";

const TEXT_KINDS = new Set<ChangeEdit["kind"]>(["prompt_text", "config_value", "tool_binding"]);

/** Number of lines in a piece of text; an empty string has none, and one final newline does not add a line. */
function lineCount(text: string): number {
  if (text.length === 0) return 0;
  return text.replace(/(\r\n|\r|\n)$/, "").split(/\r\n|\r|\n/).length;
}

/** The text an edit removes and the text it puts in, whichever kind it is. Null for the kinds modify_code does not accept. */
function editTexts(edit: ChangeEdit): { before: string; after: string } | null {
  switch (edit.kind) {
    case "prompt_text": return { before: edit.old_text, after: edit.new_text };
    case "config_value": return { before: edit.old_value, after: edit.new_value };
    case "tool_binding": return { before: edit.old_tool, after: edit.new_tool };
    default: return null;
  }
}

/** Lines an edit changes: the larger of what it replaces and what it writes. */
export function changedLines(edit: ChangeEdit): number {
  const t = editTexts(edit);
  return t ? Math.max(lineCount(t.before), lineCount(t.after)) : 0;
}

/** Null when the edits are within the rules for "modify_code"; otherwise a reason that says what to change. */
export function checkModifyCodeLimits(edits: ChangeEdit[]): string | null {
  if (edits.length > MODIFY_CODE_MAX_EDITS) {
    return `modify_code allows at most ${MODIFY_CODE_MAX_EDITS} edits per change, and this has ${edits.length}. Nothing was changed. Propose fewer, smaller edits, or choose "unclassified" if the change cannot be made that small.`;
  }
  for (const e of edits) {
    if (!TEXT_KINDS.has(e.kind)) {
      return `modify_code takes only "prompt_text", "config_value" or "tool_binding" edits, and ${e.path} has a "${e.kind}" edit. Nothing was changed. Use the operation that goes with that kind, or "prompt_text" for a plain text change.`;
    }
    const n = changedLines(e);
    if (n > MODIFY_CODE_MAX_LINES) {
      return `${e.path}: a modify_code edit may change at most ${MODIFY_CODE_MAX_LINES} lines, and this one changes ${n}. Nothing was changed. Split it into smaller edits with small anchors, or choose "unclassified".`;
    }
  }
  return null;
}
