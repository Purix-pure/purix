// packages/core/src/recovery/heal_infrastructure.test.ts
//
// A8-1: inside the repair loop, a round whose verification could not run (tool gone, labelled timeout or output limit) ends the
// loop at once. Further rounds would send the same unfixable problem to the model again. The number of rounds for ordinary code
// failures is unchanged and is asserted here too. Real prompts through classifyRepair; only the HTTP call and the sandbox verifier
// are stubbed. Tested on Linux against simulated payloads.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSelfHealingLoop } from "./heal.js";
import { recordCircuitSuccess } from "../llm/circuit.js";
import { getDbCompat as getDb, closeDb } from "../manifest/store.js";
import { createConfigStore } from "../state/config.js";
import { listEvents } from "../manifest/events.js";
import { safeRmSync } from "../platform/fs_retry.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";
import type { CompiledFileChange } from "../verify/compile.js";

const fail = (reason: string): SandboxVerificationResult => ({ status: "fail", reason, idiomFindings: [] });
const pass = (): SandboxVerificationResult => ({ status: "pass", isolation: "none", idiomFindings: [] }) as unknown as SandboxVerificationResult;
const notInstalled = (): SandboxVerificationResult => ({ status: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: "Run: purix tools install pyright", idiomFindings: [] });
const labelled = (infrastructure: "timeout" | "output_limit" | "resource_limit"): SandboxVerificationResult => ({ status: "fail", reason: `check stopped: ${infrastructure}`, infrastructure, idiomFindings: [] });

let realFetch: typeof fetch;
let prevCwd: string;
let dir: string;
let prompts: number;
let replies: object[];
let savedEnv: Record<string, string | undefined>;
let logSaved: typeof console.log;

function stubModel(): void {
  globalThis.fetch = async () => {
    prompts++;
    const reply = replies[Math.min(prompts - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
  };
}

// Each reply edits the text the previous reply produced, so every round's edit applies.
const chain = (n: number) => Array.from({ length: n }, (_, i) => ({ reasoning: `round ${i + 1}`, edits: [{ path: "src/a.ts", kind: "prompt_text", old_text: `a = ${10 + i}`, new_text: `a = ${11 + i}` }] }));

beforeEach(() => {
  realFetch = globalThis.fetch;
  prevCwd = process.cwd();
  savedEnv = { p: process.env.PURIX_LLM_PROVIDER, k: process.env.OPENAI_API_KEY, e: process.env.PURIX_HEAL_EARLY_STOP };
  process.env.PURIX_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "test_openai_key";
  delete process.env.PURIX_HEAL_EARLY_STOP;
  dir = mkdtempSync(join(tmpdir(), "purix-heal-infra-"));
  process.chdir(dir);
  // Reset the circuit in THIS test's store. It used to run before the chdir and so created .purix/manifest.db in the package folder.
  recordCircuitSuccess();
  createConfigStore(dir).set("project-id", "test-repo");
  const db = getDb();
  db.run(`DROP TABLE IF EXISTS budget_state`);
  db.run(`CREATE TABLE IF NOT EXISTS budget_state (repo_id TEXT PRIMARY KEY, total_spent_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  db.run(`INSERT OR IGNORE INTO budget_state (repo_id, total_spent_usd, calls, updated_at) VALUES (?, 0, 0, ?)`, ["test-repo", new Date().toISOString()]);
  prompts = 0;
  replies = [];
  logSaved = console.log;
  console.log = () => {};
  stubModel();
});
afterEach(() => {
  console.log = logSaved;
  globalThis.fetch = realFetch;
  for (const [k, name] of [["p", "PURIX_LLM_PROVIDER"], ["k", "OPENAI_API_KEY"], ["e", "PURIX_HEAL_EARLY_STOP"]] as const) {
    if (savedEnv[k] === undefined) delete process.env[name]; else process.env[name] = savedEnv[k];
  }
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(dir);
});

const original = [{ path: "src/a.ts", content: "export const a = 1;\nexport const b = 2;\n" }];
const first: CompiledFileChange[] = [{ path: "src/a.ts", new_content: "export const a = 10;\nexport const b = 2;\n" }];
const tscErr = (line: number) => `src/a.ts(${line},14): error TS2322: Type 'string' is not assignable to type 'number'.`;
const codeFail = (line: number) => fail(tscErr(line));

describe("runSelfHealingLoop: infrastructure results end the loop (A8-1)", () => {
  it("a tool that disappears after round two stops the loop with two model calls, not three", async () => {
    replies = chain(3);
    let n = 0;
    const res = await runSelfHealingLoop("c", "update_prompt_text", original, first, tscErr(1), dir, { verify: () => (++n === 1 ? codeFail(2) : notInstalled()) });
    expect(res.ok).toBe(false);
    // Rarely seen on a loaded Windows machine: the stop came at round 3 instead of 2, so round 2 ended before it was verified.
    // console.log is silenced here, so say what each round did; the next occurrence then names its cause.
    if (res.infrastructureStop?.attempt !== 2 || prompts !== 2) {
      throw new Error(`expected the stop at round 2 after 2 model calls; got round ${res.infrastructureStop?.attempt} after ${prompts} calls. Rounds: ${JSON.stringify(res.attempts)}`);
    }
    expect(prompts).toBe(2);
    expect(res.infrastructureStop).toEqual({ kind: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: "Run: purix tools install pyright", attempt: 2 });
    expect(res.attempts[res.attempts.length - 1]).toMatchObject({ attempt: 2, result: "fail", reason: "Python tooling (pyright) not installed" });
  });

  for (const kind of ["timeout", "output_limit", "resource_limit"] as const) {
    it(`a ${kind} label on round one stops the loop after one model call`, async () => {
      replies = chain(3);
      const res = await runSelfHealingLoop("c", "update_prompt_text", original, first, tscErr(1), dir, { verify: () => labelled(kind) });
      expect(res.ok).toBe(false);
      expect(prompts).toBe(1);
      expect(res.infrastructureStop?.kind).toBe(kind);
      expect(res.infrastructureStop?.attempt).toBe(1);
    });
  }

  it("records the stop on the round's verification_failure event", async () => {
    replies = chain(3);
    await runSelfHealingLoop("c", "update_prompt_text", original, first, tscErr(1), dir, { verify: () => notInstalled() });
    const ev = listEvents({ kind: "verification_failure" });
    expect(ev.some((e) => e.detail.stage === "self_heal" && e.detail.infrastructure === "not_installed" && e.detail.repair_skipped === true)).toBe(true);
  });

  it("a round that passes after an earlier code failure is unaffected", async () => {
    replies = chain(3);
    let n = 0;
    const res = await runSelfHealingLoop("c", "update_prompt_text", original, first, tscErr(1), dir, { verify: () => (++n < 2 ? codeFail(2) : pass()) });
    expect(res.ok).toBe(true);
    expect(res.infrastructureStop).toBeUndefined();
    expect(prompts).toBe(2);
  });
});

describe("runSelfHealingLoop: the number of rounds is unchanged (A8-1 out of bounds)", () => {
  it("code failures on every round still use all three rounds", async () => {
    replies = chain(3);
    let n = 0;
    // A different line each round so the failure never repeats at the same place.
    const res = await runSelfHealingLoop("c", "update_prompt_text", original, first, tscErr(1), dir, { verify: () => codeFail(2 + ++n) });
    expect(res.ok).toBe(false);
    expect(prompts).toBe(3);
    expect(res.infrastructureStop).toBeUndefined();
  });
});
