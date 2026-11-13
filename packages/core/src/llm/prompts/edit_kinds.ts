// src/llm/prompts/edit_kinds.ts
//
// The ONE description of the edit kinds a model may propose. Classification,
// self-healing repair and escalation each used to carry their own copy, and the
// copies had drifted (different wording for the same kind). All three now embed
// this text; prompt_schema_sync.test.ts checks it names every kind the schema
// (classify.ts ChangeEditSchema) accepts.
//
// Language scope is stated because it is true: error_handling and control_flow are
// AST transforms that only accept TypeScript/JavaScript files (verify/ast_transforms.ts,
// AST_TRANSFORM_SUPPORTED_EXTENSIONS). Without this line a model asked to fix a
// Python file would sometimes propose a kind the compiler can only reject.

export const OPERATIONS = [
  "update_prompt_text",
  "swap_tool_binding",
  "update_config_value",
  "add_error_handling",
  "change_control_flow",
  "add_memory_scope",
  "modify_code",
  "unclassified",
] as const;

/** AI-15a: limits on the general code-change operation. Enforced by verify/modify_code.ts and stated to the model below. */
export const MODIFY_CODE_MAX_EDITS = 5;
export const MODIFY_CODE_MAX_LINES = 60;

/**
 * AI-15a: what "modify_code" is for. It is the stated path for a plain code change that none of the named operations
 * describes. It adds no new kind of edit: it takes the same text edits as before, on any tracked file, with a size cap, and
 * every edit still goes through the same path guard, sandbox verification, TrustGate and security gate.
 */
export const MODIFY_CODE_SPEC = `Operation "modify_code" is for a plain code change that none of the other operations describes (fixing a condition, changing a literal, adding or removing a few statements). Use it only with "prompt_text", "config_value" or "tool_binding" edits: at most ${MODIFY_CODE_MAX_EDITS} edits, and no edit may replace or insert more than ${MODIFY_CODE_MAX_LINES} lines. Keep each anchor small and make sure it occurs exactly once. If the change needs more than that, choose "unclassified" with empty edits.`;

export const EDIT_KINDS_SPEC = `
You never write whole files. You propose small, checkable edits; a deterministic patch compiler applies them to the real files and fails loudly if an edit does not fit. Edit kinds:
- kind "prompt_text": { path, kind, old_text, new_text }. old_text must be copied verbatim from the current file content and must occur exactly once in it.
- kind "config_value": { path, kind, key, old_value, new_value }, exactly as they appear in the file.
- kind "tool_binding": { path, kind, old_tool, new_tool }: identifiers of a tool or dependency to swap.
- kind "error_handling": { path, kind, function_name, max_retries }. function_name is the exact name of a top-level async function (or a top-level const/let async arrow or function expression); max_retries is an integer 1-10. It wraps the ENTIRE function body in a retry loop, so use it only when the whole function should be retried, never for a narrow try/catch around one line.
- kind "control_flow": { path, kind, function_name, variable_names (2 or more) }. Each name must belong to an existing "const x = await someCall();" statement directly inside that function, with nothing else between the named statements. Use it only when the calls are independent of each other's results; if you cannot tell, do not use it.
"error_handling" and "control_flow" work on TypeScript/JavaScript files only (.ts .tsx .mts .cts .js .jsx .mjs .cjs). For any other language use only "prompt_text", "config_value" or "tool_binding".
`.trim();
