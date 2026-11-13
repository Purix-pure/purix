// packages/core/src/recovery/escalate_infrastructure.test.ts
//
// A8-1: escalation uses the high-tier model, so it is the most expensive place to repeat an unfixable problem. A verification that
// could not run ends it at once, in a cached-fix replay and in every attempt. The number of attempts for ordinary code failures
// is unchanged and is asserted here too. Real prompts through escalateJudgeAndRepair; only the HTTP call and the sandbox verifier
// are stubbed. Tested on Linux against simulated payloads.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { closeDb, writeManifest } from "../manifest/store.js";
import { persistProviderChoice } from "../llm/providers.js";
import { listEvents } from "../manifest/events.js";
import { computeTaskSignature, promoteOperation } from "../manifest/library.js";
import { safeRmSync } from "../platform/fs_retry.js";
import { runEscalation } from "./escalate.js";
import type { ManifestEntry } from "../manifest/schema.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";

const fail = (reason: string): SandboxVerificationResult => ({ status: "fail", reason, idiomFindings: [] });
const notInstalled = (): SandboxVerificationResult => ({ status: "not_installed", reason: "TypeScript is not installed", actionHint: "Run: purix tools install typescript", idiomFindings: [] });
const labelled = (infrastructure: "timeout" | "output_limit"): SandboxVerificationResult => ({ status: "fail", reason: `check stopped: ${infrastructure}`, infrastructure, idiomFindings: [] });
const tscErr = (line: number) => `src/a.ts(${line},14): error TS2322: Type 'string' is not assignable to type 'number'.`;

function entry(id: string, files: string[]): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: "h",
  } as unknown as ManifestEntry;
}

let root: string;
let prevCwd: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;
let savedStop: string | undefined;
let prompts: number;
let replies: object[];

const verdict = (oldText: string, newText: string) => ({
  edits: [{ path: "src/a.ts", kind: "prompt_text", old_text: oldText, new_text: newText }],
  reasoning: "try", is_new_capability: false, suspicious_injected_instruction: false,
});

beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "purix-esc-infra-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"name":"t","type":"module"}');
  writeFileSync(join(root, "src/a.ts"), "export const a = 1;\nexport const b = 2;\n");
  process.chdir(root);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  savedKey = process.env.OPENAI_API_KEY;
  savedStop = process.env.PURIX_HEAL_EARLY_STOP;
  delete process.env.PURIX_HEAL_EARLY_STOP;
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
  prompts = 0;
  replies = [];
  writeManifest(entry("alpha", ["src/a.ts"]));
  globalThis.fetch = async () => {
    prompts++;
    const reply = replies[Math.min(prompts - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  if (savedStop === undefined) delete process.env.PURIX_HEAL_EARLY_STOP; else process.env.PURIX_HEAL_EARLY_STOP = savedStop;
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(root);
});

const original = [{ path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" }];

describe("runEscalation: infrastructure results end escalation (A8-1)", () => {
  it("a tool that is not installed after attempt one stops with one model call, not two, and carries the hint out", async () => {
    replies = [verdict("a = 1", "a = 2"), verdict("a = 2", "a = 3")];
    const res = await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => notInstalled() });
    expect(res.ok).toBe(false);
    expect(prompts).toBe(1);
    expect(res.infrastructure).toEqual({ kind: "not_installed", actionHint: "Run: purix tools install typescript" });
    expect(res.reason).toContain("TypeScript is not installed");
    expect(listEvents({ kind: "escalation_outcome" }).some((e) => e.detail.outcome === "infrastructure_stop")).toBe(true);
  });

  for (const kind of ["timeout", "output_limit"] as const) {
    it(`a ${kind} label after attempt one stops with one model call`, async () => {
      replies = [verdict("a = 1", "a = 2"), verdict("a = 2", "a = 3")];
      const res = await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => labelled(kind) });
      expect(res.ok).toBe(false);
      expect(prompts).toBe(1);
      expect(res.infrastructure?.kind).toBe(kind);
    });
  }

  it("a cached fix whose replay cannot be verified because the tool is missing makes zero model calls", async () => {
    const instruction = "set a to two";
    promoteOperation({
      component_id: "alpha", operation: "update_prompt_text", task_signature: computeTaskSignature("alpha", "update_prompt_text", instruction),
      description: "set a", edits: [{ path: "src/a.ts", kind: "prompt_text", old_text: "a = 1", new_text: "a = 2" }] as never, language: "typescript",
    });
    replies = [verdict("a = 1", "a = 2")];
    const res = await runEscalation("alpha", "update_prompt_text", instruction, original, tscErr(1), root, { verify: () => notInstalled() });
    expect(res.ok).toBe(false);
    expect(prompts).toBe(0);
    expect(res.infrastructure?.kind).toBe("not_installed");
  });
});

describe("runEscalation: the number of attempts is unchanged (A8-1 out of bounds)", () => {
  it("code failures on every attempt still use both attempts", async () => {
    replies = [verdict("a = 1", "a = 2"), verdict("a = 2", "a = 3")];
    let n = 0;
    const res = await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => fail(tscErr(2 + ++n)) });
    expect(res.ok).toBe(false);
    expect(prompts).toBe(2);
    expect(res.infrastructure).toBeUndefined();
  });
});

describe("runEscalation: candidates the repair loop already tried (E3c, F07-06)", () => {
  const tried = [[{ path: "src/a.ts", content: "export const a = 2;\nexport const b = 2;\n" }]];
  it("without the list, a candidate repair already failed is verified again (the gap)", async () => {
    replies = [verdict("a = 1", "a = 2"), verdict("a = 2", "a = 3")];
    let verified = 0;
    await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => { verified++; return fail(tscErr(2)); } });
    expect(verified).toBe(2);
  });
  it("with the list, a candidate that equals one repair failed is not verified and ends escalation at once", async () => {
    replies = [verdict("a = 1", "a = 2"), verdict("a = 2", "a = 3")];
    let verified = 0;
    const res = await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => { verified++; return fail(tscErr(2)); } }, { alreadyTried: tried });
    expect(res.ok).toBe(false);
    expect(verified).toBe(0);
    expect(prompts).toBe(1);
    expect(res.reason).toContain("oscillation guard");
  });
  it("a candidate that is new is still verified", async () => {
    replies = [verdict("a = 1", "a = 7")];
    let verified = 0;
    await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => { verified++; return fail(tscErr(2)); } }, { alreadyTried: tried });
    expect(verified).toBeGreaterThan(0);
  });
});
