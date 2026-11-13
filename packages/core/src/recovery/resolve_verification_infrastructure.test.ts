// packages/core/src/recovery/resolve_verification_infrastructure.test.ts
//
// A8-1 (research 07 finding 1, probes E1a and E1b): a result that is not a failure of the code must never reach the repair
// loop or spend a model call. The sandbox verifier and the two repair stages are stubbed through resolveVerification's seam, so
// the counts below are exact: "calls" is how many times the stage that talks to the model was entered.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { resolveVerification, type ResolveVerificationDeps, type ResolveVerificationFailure } from "./resolve_verification.js";
import { closeDb } from "../manifest/store.js";
import { listEvents } from "../manifest/events.js";
import { safeRmSync } from "../platform/fs_retry.js";
import type { SandboxVerificationResult } from "../sandbox/sandbox.js";
import type { HealResult } from "./heal.js";
import type { EscalationResult } from "./escalate.js";

const pass = (): SandboxVerificationResult => ({ status: "pass", isolation: "none", idiomFindings: [] }) as unknown as SandboxVerificationResult;
const codeFail = (reason: string): SandboxVerificationResult => ({ status: "fail", reason, idiomFindings: [] });
const timeoutText = (): SandboxVerificationResult => codeFail("Test timed out after 30000ms");
const notInstalled = (): SandboxVerificationResult => ({ status: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: "Run: purix tools install pyright", idiomFindings: [] });
const labelled = (infrastructure: "timeout" | "output_limit"): SandboxVerificationResult => ({ status: "fail", reason: "tsc was stopped because it ran past its time limit.", infrastructure, idiomFindings: [] });

let dir: string;
let prevCwd: string;
let logSaved: typeof console.log;
let verifyCalls: { content: string }[][];
let healCalls: number;
let escalateCalls: number;
let healResult: HealResult;

const original = [{ path: "src/a.ts", content: "export const a = 1;\n" }];
const candidate = [{ path: "src/a.ts", new_content: "export const a = 2;\n" }];

/** verify answers from a script, one entry per call; the last entry repeats. */
function deps(script: SandboxVerificationResult[]): Partial<ResolveVerificationDeps> {
  return {
    verify: (_id: string, files: { path: string; new_content: string }[]) => {
      verifyCalls.push(files.map((f) => ({ content: f.new_content })));
      return script[Math.min(verifyCalls.length - 1, script.length - 1)]!;
    },
    runSelfHealingLoop: async () => { healCalls++; return healResult; },
    runEscalation: async () => { escalateCalls++; return { ok: false, fromLibrary: false, reason: "escalation said no" } satisfies EscalationResult; },
  };
}

const run = (script: SandboxVerificationResult[], orig = original, cand = candidate) =>
  resolveVerification("a", "update_prompt_text", orig, cand, "direct_patch", "change a", dir, deps(script));

beforeEach(() => {
  prevCwd = process.cwd();
  dir = mkdtempSync(join(tmpdir(), "purix-resolve-infra-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "package.json"), '{"name":"t","type":"module"}');
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  process.chdir(dir);
  logSaved = console.log;
  console.log = () => {};
  verifyCalls = [];
  healCalls = 0;
  escalateCalls = 0;
  healResult = { ok: false, attempts: [{ attempt: 0, result: "fail", reason: "x" }] };
});
afterEach(() => {
  console.log = logSaved;
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(dir);
});

describe("resolveVerification: a tool that is not installed (E1a)", () => {
  it("makes zero repair and zero escalation calls, and says what to install", async () => {
    const res = (await run([notInstalled()])) as ResolveVerificationFailure;
    expect(res.ok).toBe(false);
    expect(healCalls).toBe(0);
    expect(escalateCalls).toBe(0);
    expect(verifyCalls.length).toBe(1);
    expect(res.reason).toContain("Python tooling (pyright) not installed");
    expect(res.reason).toContain("Run: purix tools install pyright");
    expect(res.reason).not.toMatch(/could not produce a passing fix/i);
    expect(res.infrastructure).toEqual({ kind: "not_installed", actionHint: "Run: purix tools install pyright" });
  });

  it("records the stop on the verification_failure event", async () => {
    await run([notInstalled()]);
    const ev = listEvents({ kind: "verification_failure" });
    expect(ev.some((e) => e.detail.infrastructure === "not_installed" && e.detail.repair_skipped === true)).toBe(true);
  });
});

describe("resolveVerification: a result the stage labelled as infrastructure", () => {
  for (const kind of ["timeout", "output_limit"] as const) {
    it(`${kind}: zero repair calls and no re-run, because the label is already known`, async () => {
      const res = (await run([labelled(kind)])) as ResolveVerificationFailure;
      expect(res.ok).toBe(false);
      expect(healCalls).toBe(0);
      expect(escalateCalls).toBe(0);
      expect(verifyCalls.length).toBe(1);
      expect(res.infrastructure?.kind).toBe(kind);
    });
  }
});

describe("resolveVerification: a timeout that only shows up as text (E1b)", () => {
  it("times out twice and the original code times out too: machine problem, zero repair calls", async () => {
    const res = (await run([timeoutText()])) as ResolveVerificationFailure;
    expect(res.ok).toBe(false);
    expect(healCalls).toBe(0);
    expect(escalateCalls).toBe(0);
    expect(verifyCalls.length).toBe(3);
    expect(verifyCalls[2]).toEqual([{ content: "export const a = 1;\n" }]);
    expect(res.infrastructure?.kind).toBe("timeout");
    expect(res.reason).toMatch(/original code/i);
  });

  it("times out once, then passes on the re-run: accepted as a pass, zero repair calls", async () => {
    const res = await run([timeoutText(), pass()]);
    expect("finalFiles" in res).toBe(true);
    expect(healCalls).toBe(0);
    expect(verifyCalls.length).toBe(2);
  });

  it("times out twice but the original passes: the change causes the hang, so repair still runs (a real infinite loop stays a code failure)", async () => {
    await run([timeoutText(), timeoutText(), pass()]);
    expect(verifyCalls.length).toBe(3);
    expect(verifyCalls[2]).toEqual([{ content: "export const a = 1;\n" }]);
    expect(healCalls).toBe(1);
  });

  it("times out twice for a newly added file: no baseline exists, so stop with zero repair calls and say it cannot tell", async () => {
    const res = (await run([timeoutText()], [], [{ path: "src/new.ts", new_content: "export const n = 1;\n" }])) as ResolveVerificationFailure;
    expect(res.ok).toBe(false);
    expect(healCalls).toBe(0);
    expect(verifyCalls.length).toBe(2);
    expect(res.infrastructure?.kind).toBe("timeout");
    expect(res.reason).toMatch(/could not tell/i);
  });

  it("a re-run that fails for another reason continues to repair with that new failure", async () => {
    await run([timeoutText(), codeFail("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")]);
    expect(verifyCalls.length).toBe(2);
    expect(healCalls).toBe(1);
  });
});

describe("resolveVerification: code failures behave exactly as before", () => {
  it("an ordinary type error runs one verification and enters repair once", async () => {
    await run([codeFail("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")]);
    expect(verifyCalls.length).toBe(1);
    expect(healCalls).toBe(1);
  });

  it("a repair that exhausts its rounds still goes on to escalation", async () => {
    await run([codeFail("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")]);
    expect(escalateCalls).toBe(1);
  });
});

describe("resolveVerification: the repair stage reports infrastructure partway through", () => {
  it("does not escalate, and carries the kind and hint out", async () => {
    healResult = {
      ok: false,
      attempts: [{ attempt: 0, result: "fail", reason: "x" }, { attempt: 1, result: "fail", reason: "Python tooling (pyright) not installed" }],
      infrastructureStop: { kind: "not_installed", reason: "Python tooling (pyright) not installed", actionHint: "Run: purix tools install pyright", attempt: 1 },
    };
    const res = (await run([codeFail("src/a.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.")])) as ResolveVerificationFailure;
    expect(res.ok).toBe(false);
    expect(escalateCalls).toBe(0);
    expect(res.infrastructure?.kind).toBe("not_installed");
    expect(res.reason).toContain("Run: purix tools install pyright");
  });
});
