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

function extractFunctionSource(fileName: string, functionSignature: string): string {
  const full = readFileSync(join(import.meta.dirname, fileName), "utf-8");
  const start = full.indexOf(functionSignature);
  if (start === -1) {
    throw new Error(`could not find "${functionSignature}" in ${fileName} — has it been renamed?`);
  }
  // Each of these functions ends at its own closing brace + the `raw =
  // await callLlm` line that follows; grabbing a generous fixed window
  // after the signature is enough to cover the whole prompt template
  // without needing a real parser.
  return full.slice(start, start + 4000);
}

describe("classifyRepair prompt documents every ChangeEdit kind", () => {
  const source = extractFunctionSource("classify.ts", "export async function classifyRepair");

  for (const kind of ALL_KINDS) {
    it(`mentions kind "${kind}"`, () => {
      expect(source).toContain(`kind "${kind}"`);
    });
  }
});

describe("escalateJudgeAndRepair prompt documents every ChangeEdit kind", () => {
  const source = extractFunctionSource("escalate.ts", "export async function escalateJudgeAndRepair");

  for (const kind of ALL_KINDS) {
    it(`mentions kind "${kind}"`, () => {
      expect(source).toContain(`kind "${kind}"`);
    });
  }
});

describe("classifyModification prompt documents every ChangeEdit kind (the reference implementation)", () => {
  const source = extractFunctionSource("classify.ts", "export async function classifyModification");

  for (const kind of ALL_KINDS) {
    it(`mentions kind "${kind}"`, () => {
      expect(source).toContain(`kind "${kind}"`);
    });
  }
});
