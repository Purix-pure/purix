// packages/cli/src/cli/commands/lifecycle.test.ts
//
// Tests for lifecycle.ts (create, modify, ingest, delete) and the per-gate override flags it hands to the core gates.
// Replaces an older file of this name that held a stale copy of lifecycle.ts and no tests.
//
// These run the real CLI against a throwaway project and a fake local model (see lifecycle_harness.test.ts), so a pass here means
// the code a person runs did the thing, not that a copy of it did. Slow on purpose: each case starts its own project.
import { describe, it, before, after, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MD5_BODY, SAFE_BODY, ORIGINAL_BODY, makeProject, startFakeModel, type FakeModel, type Project } from "./lifecycle_harness.test.js";

const MODIFY = ["modify", "greet", "make greet return a hash of the name"];
const RETIRED_FLAG_TEXT = /--override no longer exists/;

describe("modify: the security gate and the per-gate override flags (F03-09)", () => {
  let model: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel(MD5_BODY);
  });
  after(async () => {
    await model.close();
  });
  beforeEach(async () => {
    p = await makeProject(model);
  });
  afterEach(() => p.cleanup());

  it("with no override, a change that adds weak crypto is blocked and nothing is written", async () => {
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/Security gate blocked/);
    expect(r.out).toMatch(/Weak Cryptography/);
    expect(r.status).toBe(1);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(p.overrideAudits()).toEqual([]);
  });

  it("--override-budget alone does NOT get past the security gate (the reproduced bug)", async () => {
    const r = await p.run([...MODIFY, "--override-budget", "cost stop, need to finish the release"]);
    expect(r.out).toMatch(/Security gate blocked/);
    expect(r.out).not.toMatch(/\[override\] SecurityGate/);
    expect(r.status).toBe(1);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    // The budget was nowhere near its ceiling, so the budget override was never needed and must not leave a record.
    expect(p.overrideAudits()).toEqual([]);
  });

  it("--override-security applies the change and records exactly one SecurityGate override", async () => {
    const r = await p.run([...MODIFY, "--override-security", "md5 is only a cache key here"]);
    expect(r.out).toMatch(/\[override\] SecurityGate overridden: md5 is only a cache key here/);
    expect(r.out).toMatch(/now at v2/);
    expect(r.status ?? 0).toBe(0);
    expect(p.greet()).toContain(MD5_BODY);
    const rows = p.overrideAudits();
    expect(rows.map((x) => x.gate_name)).toEqual(["SecurityGate"]);
    expect(rows[0]!.reason).toBe("md5 is only a cache key here");
  });

  it("the retired --override is refused with the names of the new flags, before any model call", async () => {
    const r = await p.run([...MODIFY, "--override", "anything"]);
    expect(r.out).toMatch(RETIRED_FLAG_TEXT);
    expect(r.out).toMatch(/--override-budget/);
    expect(r.out).toMatch(/--override-security/);
    expect(r.out).toMatch(/--override-trust/);
    expect(r.status).toBe(1);
    expect(model.calls).toEqual([]);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(p.overrideAudits()).toEqual([]);
  });

  it("an empty reason is refused, before any model call", async () => {
    const r = await p.run([...MODIFY, "--override-security", "  "]);
    expect(r.out).toMatch(/--override-security needs a reason/);
    expect(r.status).toBe(1);
    expect(model.calls).toEqual([]);
    expect(p.greet()).toContain(ORIGINAL_BODY);
  });

  it("--dry-run applies no override, writes nothing, records nothing, and says so", async () => {
    const r = await p.run([...MODIFY, "--dry-run", "--override-security", "md5 is only a cache key here"]);
    expect(r.out).toMatch(/--dry-run does not apply overrides/);
    expect(r.out).toMatch(/Security gate blocked/);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(p.overrideAudits()).toEqual([]);
  });

  it("`change` passes --override-security through to modify", async () => {
    const r = await p.run(["change", "make greet return a hash of the name", "--component", "greet", "--override-security", "md5 is only a cache key here"]);
    expect(r.out).toMatch(/\[override\] SecurityGate overridden/);
    expect(p.greet()).toContain(MD5_BODY);
    expect(p.overrideAudits().map((x) => x.gate_name)).toEqual(["SecurityGate"]);
  });

  it("`change` refuses the retired --override before it spends anything on matching", async () => {
    const r = await p.run(["change", "make greet return a hash of the name", "--override", "anything"]);
    expect(r.out).toMatch(RETIRED_FLAG_TEXT);
    expect(r.status).toBe(1);
    expect(model.calls).toEqual([]);
    expect(p.greet()).toContain(ORIGINAL_BODY);
  });

  it("help lists the three per-gate flags and does not advertise the retired one", async () => {
    const r = await p.run(["modify", "--help"]);
    expect(r.out).toMatch(/--override-budget <reason>/);
    expect(r.out).toMatch(/--override-security <reason>/);
    expect(r.out).toMatch(/--override-trust <reason>/);
    expect(r.out).not.toMatch(/--override <reason>/);
  });
});

describe("modify: the budget guard and --override-budget", () => {
  let model: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel(MD5_BODY);
  });
  after(async () => {
    await model.close();
  });
  beforeEach(async () => {
    p = await makeProject(model);
  });
  afterEach(() => p.cleanup());

  // A call is estimated at $0.05, so a $0.04 ceiling refuses every call.
  const TINY = { PURIX_COST_CEILING_USD: "0.04" };

  it("over the ceiling with no override: stops before the first model call", async () => {
    const r = await p.run(MODIFY, TINY);
    expect(r.out).toMatch(/Cost guardrail tripped/);
    expect(r.status).toBe(1);
    expect(model.calls).toEqual([]);
    expect(p.overrideAudits()).toEqual([]);
  });

  it("over the ceiling with --override-budget: the first call goes through, one BudgetGate record says why, the next call is refused again", async () => {
    const r = await p.run([...MODIFY, "--override-budget", "finish the release"], TINY);
    expect(r.out).toMatch(/\[override\] BudgetGate overridden: finish the release/);
    expect(r.out).toMatch(/Cost guardrail tripped/); // the override covers one call, not the run
    expect(model.calls).toEqual(["refine"]);
    const rows = p.overrideAudits();
    expect(rows.map((x) => x.gate_name)).toEqual(["BudgetGate"]);
    expect(rows[0]!.finding).toMatch(/Budget exceeded/);
    expect(p.greet()).toContain(ORIGINAL_BODY);
  });
});

describe("modify: ordinary paths", () => {
  let model: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel(SAFE_BODY);
  });
  after(async () => {
    await model.close();
  });
  beforeEach(async () => {
    p = await makeProject(model);
  });
  afterEach(() => p.cleanup());

  it("a clean change applies with no override and leaves no override record", async () => {
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/now at v2/);
    expect(r.status ?? 0).toBe(0);
    expect(p.greet()).toContain(SAFE_BODY);
    expect(p.overrideAudits()).toEqual([]);
    expect(model.calls).toEqual(["refine", "classify"]);
  });

  it("a credential-looking file left out of the verification copy is named on a passing run (C3 item 2)", async () => {
    writeFileSync(join(p.dir, ".npmrc"), "//registry.npmjs.org/:_authToken=NOT-A-REAL-TOKEN\n");
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/now at v2/);
    expect(r.out).toMatch(/Left out of the verification copy for safety: \.npmrc/);
  });

  it("no such line when nothing was left out", async () => {
    const r = await p.run(MODIFY);
    expect(r.out).not.toMatch(/Left out of the verification copy/);
  });

  it("--dry-run shows the outcome and writes nothing", async () => {
    const r = await p.run([...MODIFY, "--dry-run"]);
    expect(r.status ?? 0).toBe(0);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(r.out).not.toMatch(/now at v2/);
  });

  it("an unknown component is reported and nothing reaches the model", async () => {
    const r = await p.run(["modify", "no-such-component", "do something"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/no-such-component/);
    expect(model.calls).toEqual([]);
  });

  it("a file edited outside Purix is reported as drift and nothing reaches the model", async () => {
    appendFileSync(join(p.dir, "greet.ts"), "// edited by hand\n");
    const r = await p.run(MODIFY);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/has drifted from its last known state/);
    expect(r.out).toMatch(/purix migration accept-drift greet/);
    expect(model.calls).toEqual([]);
  });
});

describe("delete", () => {
  let model: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel(SAFE_BODY);
  });
  after(async () => {
    await model.close();
  });
  beforeEach(async () => {
    p = await makeProject(model);
  });
  afterEach(() => p.cleanup());

  it("an unknown component is reported", async () => {
    const r = await p.run(["delete", "no-such-component"]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/No manifest entry for "no-such-component"/);
  });

  it("removes the manifest entry and keeps the file on disk", async () => {
    const r = await p.run(["delete", "greet"]);
    expect(r.out).not.toMatch(/No manifest entry/);
    const after = await p.run(["modify", "greet", "anything"]);
    expect(after.status).toBe(1);
    expect(p.greet()).toContain(ORIGINAL_BODY);
  });
});

describe("modify: an edit that starts and ends inside a line says so (F04-04, C3 item 1)", () => {
  let model: FakeModel;
  let whole: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel('"hi "', '"hello "'); // replaces only the string literal, so the anchor is mid-line
    whole = await startFakeModel(SAFE_BODY); // replaces the whole statement
  });
  after(async () => {
    await model.close();
    await whole.close();
  });
  afterEach(() => p.cleanup());

  it("prints the partial-line note when the replaced text is only part of a line", async () => {
    p = await makeProject(model);
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/now at v2/);
    expect(p.greet()).toContain('return "hi " + name;');
    expect(r.out).toMatch(/Edited inside a line in greet\.ts/);
  });

  it("prints no such note when the replaced text is a whole statement", async () => {
    p = await makeProject(whole);
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/now at v2/);
    expect(r.out).not.toMatch(/Edited inside a line/);
  });
});

// R1-b (plan v6): --override-trust had no test that fails when the flag stops working. The fake classifier reports 0.20, below the
// TrustGate reject threshold (0.35), and the project has a test that imports greet, so the gate reaches its abort answer instead of
// the earlier "no coverage, ask a human" one. The change itself is safe (no security finding), so only the trust gate can stop it.
describe("modify: --override-trust gets past a TrustGate abort, and only that flag does (F03-09, R1-b)", () => {
  let model: FakeModel;
  let p: Project;
  before(async () => {
    model = await startFakeModel(SAFE_BODY, ORIGINAL_BODY, 0.2);
  });
  after(async () => {
    await model.close();
  });
  beforeEach(async () => {
    p = await makeProject(model, { withTest: true });
  });
  afterEach(() => p.cleanup());

  it("with no override, a low-confidence change stops at the TrustGate and nothing is written", async () => {
    const r = await p.run(MODIFY);
    expect(r.out).toMatch(/TrustGate: abort/);
    expect(r.out).toMatch(/below the reject threshold/);
    // R1-b remainder: the 0.20 came from a model answer over HTTP (the "custom" provider), not from a stubbed classifier function.
    expect(model.calls).toContain("classify");
    expect(r.status).toBe(1);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(p.overrideAudits()).toEqual([]);
  });

  it("--override-security and --override-budget do NOT get past a TrustGate abort", async () => {
    const r = await p.run([...MODIFY, "--override-security", "not the gate that stopped it", "--override-budget", "not this one either"]);
    expect(r.out).toMatch(/TrustGate: abort/);
    expect(r.out).not.toMatch(/\[override\] TrustGate/);
    expect(r.status).toBe(1);
    expect(p.greet()).toContain(ORIGINAL_BODY);
  });

  it("--override-trust applies the change and records exactly one TrustGate override", async () => {
    const r = await p.run([...MODIFY, "--override-trust", "reviewed by hand, the wording is fine"]);
    expect(r.out).toMatch(/\[override\] TrustGate overridden: reviewed by hand, the wording is fine/);
    expect(r.out).toMatch(/now at v2/);
    expect(r.status ?? 0).toBe(0);
    expect(p.greet()).toContain(SAFE_BODY);
    const rows = p.overrideAudits();
    expect(rows.map((x) => x.gate_name)).toEqual(["TrustGate"]);
    expect(rows[0]!.reason).toBe("reviewed by hand, the wording is fine");
  });

  it("--dry-run does not honour --override-trust: nothing is written and no override is recorded", async () => {
    const r = await p.run([...MODIFY, "--dry-run", "--override-trust", "should be ignored"]);
    expect(r.out).toMatch(/A real run would stop here/);
    expect(r.out).not.toMatch(/\[override\] TrustGate/);
    expect(p.greet()).toContain(ORIGINAL_BODY);
    expect(p.overrideAudits()).toEqual([]);
  });
});
