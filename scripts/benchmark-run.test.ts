// These tests use a made-up "agent" (a few lines of Node) to check the harness's mechanics. They produce no benchmark data.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyze } from "./benchmark-analyze.ts";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { drawOrder, parseCli, parsePlan, runPlan, type Plan } from "./benchmark-run.ts";

function fixture(agentSrc: string, taskCount = 1): { dir: string; plan: Plan } {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-test-"));
  const tasks: Plan["tasks"] = [];
  for (let i = 0; i < taskCount; i++) {
    const t = join(dir, `t${i}`);
    mkdirSync(join(t, "repo"), { recursive: true });
    mkdirSync(join(t, "hidden"), { recursive: true });
    writeFileSync(join(t, "repo", "agent.cjs"), agentSrc);
    writeFileSync(join(t, "prompt.md"), "do it");
    writeFileSync(join(t, "hidden", "check.cjs"), 'process.exit(require("fs").existsSync("solution.txt") ? 0 : 1);');
    tasks.push({ id: `t${i}`, template: `t${i}/repo`, prompt: `t${i}/prompt.md`, accept: "node check.cjs", acceptDir: `t${i}/hidden`, timeoutSeconds: 30 });
  }
  return { dir, plan: { schema: 1, seed: 3, plain: "node agent.cjs", purix: "node agent.cjs", tasks } };
}

describe("benchmark runner", () => {
  it("the order draw is repeatable and varies between tasks", () => {
    const ids = Array.from({ length: 40 }, (_, i) => `t${i}`);
    expect(drawOrder(ids, 7)).toEqual(drawOrder(ids, 7));
    const firsts = new Set(Object.values(drawOrder(ids, 7)).map((o) => o[0]));
    expect(firsts.size).toBe(2);
  });

  it("hidden tests are absent while the agent works, present afterwards; acceptance comes from the exit code", () => {
    const agent = `const fs=require("fs"); fs.writeFileSync("saw.txt", String(fs.existsSync("check.cjs"))); fs.writeFileSync(".purix-bench-result.json", JSON.stringify({costUsd:0.5, interruptions:2})); if (process.env.PURIX_BENCH_ARM==="purix") fs.writeFileSync("solution.txt","x");`;
    const { dir, plan } = fixture(agent);
    try {
      const out = runPlan(plan, dir);
      const pair = out.pairs[0]!;
      expect(pair.plain).toMatchObject({ accepted: false, costUsd: 0.5, interruptions: 2 });
      expect(pair.purix).toMatchObject({ accepted: true, costUsd: 0.5, interruptions: 2 });
      expect(typeof pair.plain!.seconds).toBe("number");
      expect(Object.keys(out.order)).toEqual(["t0"]);
      expect(out.seed).toBe(3);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the agent never sees the hidden tests", () => {
    // The agent copies out what it sees; if check.cjs were present it would be recorded as a cost of 1.
    const agent = `const fs=require("fs"); fs.writeFileSync(".purix-bench-result.json", JSON.stringify({costUsd: fs.existsSync("check.cjs") ? 1 : 0}));`;
    const { dir, plan } = fixture(agent);
    try {
      const pair = runPlan(plan, dir).pairs[0]!;
      expect(pair.plain!.costUsd).toBe(0);
      expect(pair.purix!.costUsd).toBe(0);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("values the agent did not report are left out, not set to zero; a crashing agent still gets judged by the tests", () => {
    const { dir, plan } = fixture(`process.exit(3);`);
    try {
      const pair = runPlan(plan, dir).pairs[0]!;
      expect(pair.plain).not.toHaveProperty("costUsd");
      expect(pair.plain).not.toHaveProperty("interruptions");
      expect(pair.plain!.accepted).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("a bad result file leaves cost and interruptions unrecorded", () => {
    const { dir, plan } = fixture(`require("fs").writeFileSync(".purix-bench-result.json", "{nope");`);
    try {
      const pair = runPlan(plan, dir).pairs[0]!;
      expect(pair.purix).not.toHaveProperty("costUsd");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the workspace is removed afterwards and the template is not changed", () => {
    const { dir, plan } = fixture(`require("fs").writeFileSync("solution.txt","x");`);
    try {
      runPlan(plan, dir);
      expect(existsSync(join(dir, "t0", "repo", "solution.txt"))).toBe(false);
      expect(readFileSync(join(dir, "t0", "prompt.md"), "utf8")).toBe("do it");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("the output feeds the analysis script, which still refuses a figure below the minimum number of pairs", () => {
    const { dir, plan } = fixture(`require("fs").writeFileSync("solution.txt","x");`, 3);
    try {
      const out = runPlan(plan, dir);
      expect(out.pairs).toHaveLength(3);
      expect(analyze(out).every((r) => r.kind === "not-enough-pairs")).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("rejects a plan that is not a plan, or repeats a task id", () => {
    expect(() => parsePlan("{}")).toThrow(/not a plan/);
    expect(() => parsePlan(JSON.stringify({ schema: 1, plain: "a", purix: "b", tasks: [{ id: "x", template: "a", prompt: "b", accept: "c" }, { id: "x", template: "a", prompt: "b", accept: "c" }] }))).toThrow(/twice/);
  });
});

describe("command line", () => {
  it("needs the plan, and the output file unless --dry-run", () => {
    expect(parseCli(["p.json", "r.json"])).toEqual({ planPath: "p.json", outPath: "r.json", dryRun: false });
    expect(parseCli(["p.json", "--dry-run"])).toEqual({ planPath: "p.json", outPath: null, dryRun: true });
    expect(parseCli([])).toHaveProperty("error");
    expect(parseCli(["p.json"])).toHaveProperty("error");
  });
  it("recognises arguments PowerShell joined with a comma, and says what to write instead", () => {
    const r = parseCli(["p.json", "r.json --dry-run"]);
    expect(r).toHaveProperty("error");
    expect((r as { error: string }).error).toMatch(/separated by spaces/);
    expect(parseCli(["p.json,", "r.json"])).toHaveProperty("error");
  });
  it("run as a script it really runs: usage with no arguments, the drawn order with --dry-run (this is what failed on Windows)", () => {
    const dir = mkdtempSync(join(tmpdir(), "bench-cli-"));
    try {
      writeFileSync(join(dir, "plan.json"), JSON.stringify({ schema: 1, seed: 3, plain: "x", purix: "y", tasks: [{ id: "a", template: "t", prompt: "p", accept: "c" }, { id: "b", template: "t", prompt: "p", accept: "c" }] }));
      const script = fileURLToPath(new URL("./benchmark-run.ts", import.meta.url));
      const run = (...args: string[]) => spawnSync(process.execPath, ["--import", "tsx", script, ...args], { encoding: "utf8", cwd: fileURLToPath(new URL("..", import.meta.url)) });
      const none = run();
      expect(none.status).toBe(2);
      expect(none.stderr).toMatch(/Usage/);
      const dry = run(join(dir, "plan.json"), "--dry-run");
      expect(dry.status).toBe(0);
      expect(dry.stdout).toMatch(/^a: (plain then purix|purix then plain)$/m);
      expect(dry.stdout).toMatch(/^b: /m);
      const joined = run(join(dir, "plan.json"), "runs.json --dry-run");
      expect(joined.status).toBe(2);
      expect(joined.stderr).toMatch(/joined together/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
