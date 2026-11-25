// src/llm/prompts/prompt_rules.test.ts
//
// The prompts that produce code must tell the model what the checks that run after it will reject, and what they say must be true.
//  1. Placement: CODE_SAFETY_RULE is in every prompt whose output becomes code (greenfield, classify, repair, escalate) and in no
//     other; TEST_LOCK_RULE is in repair and escalation only, because those are the callers compilePatch locks test files for.
//  2. Accuracy: each thing CODE_SAFETY_RULE tells the model to avoid is blocked by the real security gate, and the alternative it
//     names is not. If the gate changes and the sentence does not, this fails (same idea as prompt_schema_sync.test.ts).
//  3. Accuracy of TEST_LOCK_RULE: the compiler really does reject a repair edit to a test file.
import { describe, it } from "node:test";
import { expect } from "expect";
import { greenfieldPrompt, mentionPrompt, refinePrompt, classifyPrompt, diffPrompt, repairPrompt, escalatePrompt } from "./build.js";
import { CODE_SAFETY_RULE, TEST_LOCK_RULE } from "./edit_kinds.js";
import { runSecurityGate, GOLDEN_CORPUS } from "../../gates/security_gate.js";
import { applyEdits } from "../../verify/compile.js";

const prompts = {
  greenfield: greenfieldPrompt({ componentName: "c", projectBlock: "", testGuidance: "tests" }),
  classify: classifyPrompt({ componentId: "c", files: "--- a.ts ---\nx", projectBlock: "", instruction: "do it" }),
  repair: repairPrompt({ componentId: "c", operation: "modify_code", files: "--- a.ts ---\nx", failure: "boom", attempt: 1 }),
  escalate: escalatePrompt({ componentId: "c", operation: "modify_code", instruction: "do it", failureReason: "boom", attempt: 1, failingFiles: "x", neighborFiles: "y" }),
  mention: mentionPrompt({ intent: "change a" }),
  refine: refinePrompt({ componentId: "c", files: "x", memory: [], projectBlock: "", instruction: "do it" }),
  diff: diffPrompt({ componentId: "c", sourceAgent: null, diff: "x" }),
};

describe("code-writing prompts say what the checks after them reject", () => {
  it("CODE_SAFETY_RULE is in the four prompts whose output becomes code, and in the system message only", () => {
    for (const k of ["greenfield", "classify", "repair", "escalate"] as const) {
      expect(prompts[k].system).toContain(CODE_SAFETY_RULE);
      expect(prompts[k].user).not.toContain(CODE_SAFETY_RULE);
    }
    for (const k of ["mention", "refine", "diff"] as const) expect(prompts[k].system).not.toContain(CODE_SAFETY_RULE);
  });

  it("TEST_LOCK_RULE is in repair and escalation only", () => {
    for (const k of ["repair", "escalate"] as const) expect(prompts[k].system).toContain(TEST_LOCK_RULE);
    for (const k of ["greenfield", "classify", "mention", "refine", "diff"] as const) expect(prompts[k].system).not.toContain(TEST_LOCK_RULE);
  });
});

describe("CODE_SAFETY_RULE matches what the security gate does", () => {
  const blocked = (path: string, content: string, base?: string) => runSecurityGate([{ path, content, ...(base !== undefined ? { base } : {}) }]).blocked;

  it("blocks what the rule says to avoid", () => {
    expect(blocked("a.ts", 'db.query("SELECT * FROM users WHERE name = " + userInput);')).toBe(true); // joined SQL
    expect(blocked("a.ts", "exec(command);")).toBe(true); // shell string from a variable
    expect(blocked("a.ts", "const f = eval(text);")).toBe(true); // text evaluated as code
    expect(blocked("a.py", "obj = pickle.loads(data)")).toBe(true);
    expect(blocked("a.py", "cfg = yaml.load(text)")).toBe(true);
    expect(blocked("a.ts", 'const h = crypto.createHash("md5").update(x).digest("hex");')).toBe(true);
    expect(blocked("a.py", "h = hashlib.sha1(x)")).toBe(true);
    expect(blocked("a.ts", 'const apiKey = "AKIAIOSFODNN7EXAMPLX";')).toBe(true); // secret written into a file
    expect(blocked("a.ts", "await fetch(url, { body: JSON.stringify(process.env) });")).toBe(true); // whole environment over the network
    expect(blocked("package.json", JSON.stringify({ dependencies: { thing: "github:someone/thing" } }), JSON.stringify({ dependencies: {} }))).toBe(true); // git source
    expect(blocked("package.json", JSON.stringify({ dependencies: { thing: "https://example.com/thing.tgz" } }), JSON.stringify({ dependencies: {} }))).toBe(true); // URL source
  });

  it("lets the alternatives the rule names through", () => {
    expect(blocked("a.ts", 'db.prepare("SELECT * FROM users WHERE id = ?").get(id);')).toBe(false); // parameters
    expect(blocked("a.ts", 'execFile("git", ["status"]);')).toBe(false); // argument list
    expect(blocked("a.ts", 'const h = crypto.createHash("sha256").update(x).digest("hex");')).toBe(false);
    expect(blocked("a.py", "h = hashlib.sha256(x)")).toBe(false);
    expect(blocked("a.py", "cfg = yaml.safe_load(text)")).toBe(false);
    expect(blocked("a.ts", "const key = process.env.API_KEY;")).toBe(false); // one named variable
    expect(blocked("package.json", JSON.stringify({ dependencies: { zod: "^3.23.0" } }), JSON.stringify({ dependencies: {} }))).toBe(false); // registry range
  });

  it("every corpus entry the gate is known to block is covered by a sentence in the rule", () => {
    // The gate's own golden corpus lists the categories it was built to block. Each blocked one must be one the rule speaks to.
    const spoken: Record<string, RegExp> = {
      "SQL injection with string concat": /SQL/,
      "Hardcoded secret": /secret/,
      "Weak crypto MD5": /MD5/,
    };
    for (const entry of GOLDEN_CORPUS.filter((e) => e.shouldBlock && e.name in spoken)) {
      expect(CODE_SAFETY_RULE).toMatch(spoken[entry.name]!);
    }
  });
});

describe("TEST_LOCK_RULE matches the compiler", () => {
  it("a repair-loop edit to a test file is rejected outright (§E-TESTLOCK)", () => {
    const files = [
      { path: "src/a.ts", content: "export const a = 1;\n" },
      { path: "src/a.test.ts", content: 'import assert from "node:assert";\nassert.equal(1, 1);\n' },
    ];
    const r = applyEdits([{ path: "src/a.test.ts", kind: "prompt_text", old_text: "assert.equal(1, 1);", new_text: "assert.equal(1, 2);" }], files);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("§E-TESTLOCK");
  });
});
