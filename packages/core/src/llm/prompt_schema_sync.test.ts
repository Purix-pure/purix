// src/llm/prompt_schema_sync.test.ts
//
// Guards against the exact drift this file was written to fix:
// classifyRepair (classify.ts) and escalateJudgeAndRepair (escalate.ts)
// both accept the FULL ChangeEditSchema discriminated union in their
// response schema, but their prompts previously only *documented* a
// subset of the kinds — repair silently under-used capability the schema
// already supported. This test doesn't call the LLM; it statically reads
// each function's prompt template as source text and checks every kind
// literal the schema knows about is actually mentioned in it. If someone
// adds a 6th ChangeEdit kind to the schema and forgets to update one of
// these prompts, this test fails instead of the gap surviving silently
// until someone notices repair or escalation never proposes that kind.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ChangeEditSchema } from "./classify";

const ALL_KINDS: string[] = ChangeEditSchema.options.map((o) => o.shape.kind.value);

// Sanity check on the extraction itself, so a future zod upgrade that
// changes how kind literals surface fails loudly here rather than making
// every check below vacuously pass against an empty list.
describe("ALL_KINDS extraction", () => {
  it("finds all five known edit kinds on the current schema", () => {
    const expected: string[] = ["config_value", "control_flow", "error_handling", "prompt_text", "tool_binding"];
    expect([...ALL_KINDS].sort()).toEqual(expected.sort());
  });
});

import { EDIT_KINDS_SPEC } from "./prompts/edit_kinds.js";
import { classifyPrompt, repairPrompt, escalatePrompt } from "./prompts/build.js";

// The edit-kind documentation now lives in ONE place (prompts/edit_kinds.ts). Two checks:
// (1) that text names every kind the schema accepts, (2) every prompt that may return
// edits embeds it verbatim — so a new kind added to the schema fails here until it is documented.
describe("EDIT_KINDS_SPEC documents every ChangeEdit kind", () => {
  for (const kind of ALL_KINDS) {
    it(`mentions kind "${kind}"`, () => {
      expect(EDIT_KINDS_SPEC).toContain(`kind "${kind}"`);
    });
  }
});

describe("every edit-producing prompt embeds EDIT_KINDS_SPEC", () => {
  const pairs = {
    classifyPrompt: classifyPrompt({ componentId: "c", files: "", projectBlock: "", instruction: "x" }),
    repairPrompt: repairPrompt({ componentId: "c", operation: "o", files: "", failure: "f", attempt: 1 }),
    escalatePrompt: escalatePrompt({ componentId: "c", operation: "o", instruction: "x", failureReason: "f", attempt: 1, failingFiles: "", neighborFiles: "" }),
  };
  for (const [name, p] of Object.entries(pairs)) {
    it(`${name} includes the shared spec`, () => {
      expect(p.system).toContain(EDIT_KINDS_SPEC);
    });
  }
});

// AI-15a: the "modify_code" operation is offered where a request becomes edits (classify, escalate) and stated with its
// limits; the prompt for an already-landed external diff keeps its old taxonomy, so no label there changes meaning.
import { MODIFY_CODE_SPEC, MODIFY_CODE_MAX_EDITS, MODIFY_CODE_MAX_LINES } from "./prompts/edit_kinds.js";
import { diffPrompt } from "./prompts/build.js";
describe("modify_code in the prompts", () => {
  const classify = classifyPrompt({ componentId: "c", files: "", projectBlock: "", instruction: "x" }).system;
  const escalate = escalatePrompt({ componentId: "c", operation: "o", instruction: "x", failureReason: "f", attempt: 1, failingFiles: "", neighborFiles: "" }).system;
  it("classification names it, maps it to the text kinds and states its limits", () => {
    expect(classify).toContain("modify_code -> \"prompt_text\", \"config_value\" or \"tool_binding\" edits");
    expect(classify).toContain(MODIFY_CODE_SPEC);
    expect(MODIFY_CODE_SPEC).toContain(`at most ${MODIFY_CODE_MAX_EDITS} edits`);
    expect(MODIFY_CODE_SPEC).toContain(`more than ${MODIFY_CODE_MAX_LINES} lines`);
  });
  it("escalation lists it among the operations it knows", () => {
    expect(escalate).toContain("modify_code");
  });
  it("the external-diff prompt does not offer it", () => {
    const d = diffPrompt({ componentId: "c", sourceAgent: null, diff: "", }).system;
    expect(d).not.toContain("modify_code");
  });
});
