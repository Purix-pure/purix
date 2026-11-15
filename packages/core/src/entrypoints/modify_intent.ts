// packages/core/src/entrypoints/modify_intent.ts
//
// P5 (parity): the first step of a modify, in one place. `purix modify` and `purix_modify` both start by reading what the
// repository has recorded (repo-wide conventions plus notes about this component) and having the model restate the
// instruction against the component's files. The CLI did both; the MCP tool did neither and sent the raw instruction to the
// classifier, so the same sentence produced different edits depending on the door it came through.
//
// What each door does with the result stays its own: the CLI shows the interpretation to a person and asks; MCP has nobody to ask
// at this step (the person approves the finished result later), so it records the interpretation in the audit trail instead.
import { refineIntent, type RefinedIntent } from "../llm/classify.js";
import { readRelevantMemory, formatMemoryLines } from "../manifest/memory.js";

export interface ModifyIntent {
  refined: RefinedIntent;
  /** The memory lines the model was shown, as sent (the model-bound scan runs inside refineIntent). */
  memoryLines: string[];
}

export async function prepareModifyIntent(
  componentId: string,
  instruction: string,
  currentFiles: { path: string; content: string }[]
): Promise<ModifyIntent> {
  const memoryLines = formatMemoryLines(readRelevantMemory(componentId));
  const refined = await refineIntent(componentId, instruction, currentFiles, memoryLines);
  return { refined, memoryLines };
}
