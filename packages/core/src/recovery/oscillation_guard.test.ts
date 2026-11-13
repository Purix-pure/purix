// packages/core/src/recovery/oscillation_guard.test.ts
//
// F07-06 (research 07 finding 6, experiment E3; decision D24, ADR-051). Before: the guard fired only on the THIRD proposal of the same
// candidate, so a repair loop of three rounds could never reach it except by sending the same edit three times (E3a: A, B, A went
// uncaught). E3b (a re-sent no-change edit) no longer reaches the guard in this tree: the patch compiler refuses an edit that
// would change nothing (verify/compile.ts, "would produce no change"), so that round costs a model call and no verification; a
// test below pins it. E3c (escalation) was open: escalation has two rounds and a round cannot repeat its own previous state (same reason), so
// the guard could not fire there. It is closed in three other files (one place per behaviour): heal.test.ts (the loop returns the states it verified, `triedStates`),
// resolve_verification.test.ts (resolveVerification passes them on) and escalate_infrastructure.test.ts (escalation seeds its guard with them).
// Design: research 07 section 2.2 option E, "guard on repeated or reverted states, seeded with the failing state". A candidate that
// was already verified and failed (or the failing state itself) is not verified a second time. Verification is deterministic for an
// identical file set, so a repeat cannot pass where the first try failed (a flaky test is the exception: see the note in oscillation_guard.ts).
//
// The loops are run through their real code with a stubbed model and a stubbed sandbox verifier, on Linux. No real model.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { OscillationGuard, applyEditsAndCheckOscillation, OSCILLATION_THRESHOLD } from "./oscillation_guard.js";
import { runSelfHealingLoop } from "./heal.js";
import { runEscalation } from "./escalate.js";
import { resolveVerification } from "./resolve_verification.js";
import { recordCircuitSuccess } from "../llm/circuit.js";
import { persistProviderChoice } from "../llm/providers.js";
import { closeDb, getDbCompat, writeManifest } from "../manifest/store.js";
import { createConfigStore } from "../state/config.js";
import { listEvents } from "../manifest/events.js";
import { safeRmSync } from "../platform/fs_retry.js";
import type { ManifestEntry } from "../manifest/schema.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";
import type { CompiledFileChange } from "../verify/compile.js";

const A = [{ path: "src/a.ts", content: "export const a = 11;\n" }];
const B = [{ path: "src/a.ts", content: "export const a = 12;\n" }];
const S0 = [{ path: "src/a.ts", content: "export const a = 10;\n" }];

describe("OscillationGuard", () => {
  it("fires when a candidate comes back, even once: A, B, A (E3a)", () => {
    const g = new OscillationGuard();
    expect([g.check(A).hit, g.check(B).hit, g.check(A).hit]).toEqual([false, false, true]);
  });
  it("fires on the second proposal of the same candidate: A, A (E3b)", () => {
    const g = new OscillationGuard();
    expect([g.check(A).hit, g.check(A).hit]).toEqual([false, true]);
  });
  it("different candidates never fire, however many there are", () => {
    const g = new OscillationGuard();
    for (let i = 0; i < 20; i++) expect(g.check([{ path: "src/a.ts", content: `export const a = ${i};\n` }]).hit).toBe(false);
  });
  it("a seeded state fires the first time it is proposed (the state being repaired counts as already tried)", () => {
    const g = new OscillationGuard();
    g.seed(S0);
    expect(g.check(A).hit).toBe(false);
    const r = g.check(S0);
    expect(r.hit).toBe(true);
    expect(r.reason).toMatch(/already (been )?tried|already failed|before/i);
  });
  it("the same text in a different file is a different candidate", () => {
    const g = new OscillationGuard();
    g.check([{ path: "src/a.ts", content: "x" }]);
    expect(g.check([{ path: "src/b.ts", content: "x" }]).hit).toBe(false);
  });
  it("the default threshold is 2: the second sighting fires", () => {
    expect(OSCILLATION_THRESHOLD).toBe(2);
  });
  it("applyEditsAndCheckOscillation: a candidate equal to the seed fires (given directly, bypassing the compiler)", () => {
    const g = new OscillationGuard();
    g.seed(S0);
    const current = new Map(S0.map((f) => [f.path, f.content]));
    const out = applyEditsAndCheckOscillation(current, [{ path: "src/a.ts", new_content: S0[0]!.content }], g);
    expect(out.oscillation.hit).toBe(true);
  });
});

// ---- the loops ----

const fail = (reason: string): SandboxVerificationResult => ({ status: "fail", reason, idiomFindings: [] });
const tscErr = (line: number) => `src/a.ts(${line},14): error TS2322: Type 'string' is not assignable to type 'number'.`;
const src = (n: number): string => `export const a = ${n};\n`;

let root: string;
let prevCwd: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedEnv: Record<string, string | undefined>;
let modelCalls: number;
let replies: object[];

function entry(id: string, files: string[]): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: "h",
  } as unknown as ManifestEntry;
}

beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "purix-osc-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"name":"t","type":"module"}');
  writeFileSync(join(root, "src/a.ts"), src(1));
  process.chdir(root);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  savedEnv = { k: process.env.OPENAI_API_KEY, e: process.env.PURIX_HEAL_EARLY_STOP, p: process.env.PURIX_LLM_PROVIDER };
  delete process.env.PURIX_HEAL_EARLY_STOP;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.PURIX_LLM_PROVIDER = "openai";
  persistProviderChoice("openai");
  recordCircuitSuccess();
  createConfigStore(root).set("project-id", "test-repo");
  const db = getDbCompat();
  db.run(`DROP TABLE IF EXISTS budget_state`);
  db.run(`CREATE TABLE IF NOT EXISTS budget_state (repo_id TEXT PRIMARY KEY, total_spent_usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL)`);
  db.run(`INSERT OR IGNORE INTO budget_state (repo_id, total_spent_usd, calls, updated_at) VALUES (?, 0, 0, ?)`, ["test-repo", new Date().toISOString()]);
  writeManifest(entry("alpha", ["src/a.ts"]));
  modelCalls = 0;
  replies = [];
  globalThis.fetch = async () => {
    modelCalls++;
    const reply = replies[Math.min(modelCalls - 1, replies.length - 1)]!;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = log;
  for (const [k, name] of [["k", "OPENAI_API_KEY"], ["e", "PURIX_HEAL_EARLY_STOP"], ["p", "PURIX_LLM_PROVIDER"]] as const) {
    if (savedEnv[k] === undefined) delete process.env[name]; else process.env[name] = savedEnv[k];
  }
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(root);
});

/** A repair reply that replaces one number with another in src/a.ts. */
const heal = (from: number, to: number) => ({ reasoning: `${from}->${to}`, edits: [{ path: "src/a.ts", kind: "prompt_text", old_text: `a = ${from}`, new_text: `a = ${to}` }] });
const esc = (from: number, to: number) => ({ ...heal(from, to), is_new_capability: false, suspicious_injected_instruction: false });

const original = [{ path: "src/a.ts", content: src(1) }];
const firstAttempt: CompiledFileChange[] = [{ path: "src/a.ts", new_content: src(10) }];

describe("runSelfHealingLoop: a state already tried is not verified again (E3a, E3b)", () => {
  it("A, B, A: the third round stops before its verification (was: three verifications)", async () => {
    // first failing candidate S0 = a 10; round 1 -> 11 (A), round 2 -> 12 (B), round 3 -> 11 (A again)
    replies = [heal(10, 11), heal(11, 12), heal(12, 11)];
    let verifies = 0;
    const res = await runSelfHealingLoop("alpha", "update_prompt_text", original, firstAttempt, tscErr(1), root, { verify: () => { verifies++; return fail(tscErr(1 + verifies)); } });
    expect(res.ok).toBe(false);
    expect(verifies).toBe(2);
    expect(modelCalls).toBe(3);
    expect(res.attempts.at(-1)!.reason).toMatch(/oscillation guard/);
  });
  it("a round that puts the failing state back stops at once: S0, A, S0 (the seed)", async () => {
    replies = [heal(10, 11), heal(11, 10), heal(10, 11)];
    let verifies = 0;
    const res = await runSelfHealingLoop("alpha", "update_prompt_text", original, firstAttempt, tscErr(1), root, { verify: () => { verifies++; return fail(tscErr(1 + verifies)); } });
    expect(res.ok).toBe(false);
    expect(verifies).toBe(1); // round 1 only; round 2's candidate is the state that already failed
    expect(modelCalls).toBe(2);
  });
  it("a repair that changes nothing is refused by the compiler, not verified (E3b is closed by verify/compile.ts, not by the guard)", async () => {
    replies = [heal(10, 10)];
    let verifies = 0;
    const res = await runSelfHealingLoop("alpha", "update_prompt_text", original, firstAttempt, tscErr(1), root, { verify: () => { verifies++; return fail(tscErr(1)); } });
    expect(res.ok).toBe(false);
    expect(verifies).toBe(0);
    expect(res.attempts.some((a) => /no change/.test(a.reason ?? ""))).toBe(true);
  });
  it("control: three different candidates still use all three rounds", async () => {
    replies = [heal(10, 11), heal(11, 12), heal(12, 13)];
    let verifies = 0;
    const res = await runSelfHealingLoop("alpha", "update_prompt_text", original, firstAttempt, tscErr(1), root, { verify: () => { verifies++; return fail(tscErr(1 + verifies)); } });
    expect(res.ok).toBe(false);
    expect(verifies).toBe(3);
    expect(modelCalls).toBe(3);
  });
  it("control: a passing round still passes", async () => {
    replies = [heal(10, 11)];
    const res = await runSelfHealingLoop("alpha", "update_prompt_text", original, firstAttempt, tscErr(1), root, { verify: () => ({ status: "pass", isolation: "none", idiomFindings: [] }) as unknown as SandboxVerificationResult });
    expect(res.ok).toBe(true);
  });
});

describe("runEscalation: a fresh run (nothing tried before) is unchanged by the new rule", () => {
  it("control: two different candidates still use both attempts", async () => {
    replies = [esc(1, 2), esc(2, 3)];
    let verifies = 0;
    const res = await runEscalation("alpha", "update_prompt_text", "set a", original, tscErr(1), root, { verify: () => { verifies++; return fail(tscErr(1 + verifies)); } });
    expect(res.ok).toBe(false);
    expect(verifies).toBe(2);
    expect(modelCalls).toBe(2);
  });
});
