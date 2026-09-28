// src/llm/prompts/prompts_golden.test.ts
//
// Frozen reference of the exact prompt text every LLM call site sent BEFORE the
// ADR-059 context policy landed (captured from the original code, per-call random
// delimiter tags normalised). This test proves the property the policy promises:
// with default settings and no project context file, nothing about any prompt
// changed — so the policy can only alter behaviour where it says it does.
//
// It is also the seed of ADR-054's "a prompt edit gets checked before it ships"
// discipline. If you change a prompt on purpose, update legacy-prompts.json in the
// same commit and say why in the commit message; an unexplained diff here is a bug.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { closeDb } from "../../manifest/store.js";
import { persistProviderChoice } from "../providers.js";
import { classifyGreenfield, extractMentionCandidates, refineIntent, classifyModification, classifyDiff, classifyRepair } from "../classify.js";
import { escalateJudgeAndRepair } from "../escalate.js";
import { safeRmSync } from "../../platform/fs_retry.js";
import { GOLDEN_INPUTS as g } from "./golden_inputs.js";

const here = dirname(fileURLToPath(import.meta.url));
const golden: Record<string, string> = JSON.parse(readFileSync(join(here, "__golden__", "legacy-prompts.json"), "utf-8"));

const norm = (s: string) =>
  s.replace(/PURIX_INTENT_[0-9A-F]{12}/g, "PURIX_INTENT_TAG")
    .replace(/PURIX_DIFF_[0-9A-F]{12}/g, "PURIX_DIFF_TAG")
    .replace(/PURIX_DATA_REVIEW_[0-9a-f]{32}/g, "PURIX_DATA_REVIEW_TAG");

let cwd: string, tmp: string, realFetch: typeof fetch, log: typeof console.log, savedKey: string | undefined;
let sent: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-golden-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch; log = console.log; console.log = () => {};
  savedKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    sent = norm(JSON.parse(init.body).messages[0].content);
    return new Response(JSON.stringify({ choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as unknown as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch; console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  closeDb(); process.chdir(cwd); safeRmSync(tmp);
});

const cases: [string, () => Promise<unknown>][] = [
  ["greenfield_plain", () => classifyGreenfield(g.componentName)],
  ["greenfield_with_intent", () => classifyGreenfield(g.componentName, g.intent)],
  ["extract_mentions", () => extractMentionCandidates(g.intent)],
  ["refine_no_memory", () => refineIntent(g.componentId, g.instruction, g.files)],
  ["refine_with_memory", () => refineIntent(g.componentId, g.instruction, g.files, g.memory)],
  ["classify_modification", () => classifyModification(g.componentId, g.instruction, g.files)],
  ["classify_diff_with_agent", () => classifyDiff(g.componentId, "cursor", g.diff)],
  ["classify_diff_no_agent", () => classifyDiff(g.componentId, null, g.diff)],
  ["classify_repair", () => classifyRepair(g.componentId, "update_prompt_text", g.files, g.tscError, 2)],
  ["escalate", () => escalateJudgeAndRepair(g.componentId, "update_prompt_text", g.instruction, g.files, g.neighbors, "anchor text not found in file", 1)],
];

describe("prompt golden — no default-path prompt changed", () => {
  it("covers every captured prompt", () => {
    expect(Object.keys(golden).sort()).toEqual(cases.map(([n]) => n).sort());
  });
  for (const [name, run] of cases) {
    it(`${name} is byte-identical to the frozen legacy prompt`, async () => {
      sent = "";
      try { await run(); } catch { /* the stub returns "{}", so schema parsing is expected to throw */ }
      expect(sent).toBe(golden[name]);
    });
  }
});
