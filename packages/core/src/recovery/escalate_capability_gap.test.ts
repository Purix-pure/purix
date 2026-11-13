// AI-02: a capability gap stops after one escalation call, and neighbour context stays inside a token budget.
// Real store and files in a temp project; only the provider's HTTP call is stubbed. Tested on Linux against simulated payloads.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { closeDb, writeManifest } from "../manifest/store";
import { persistProviderChoice } from "../llm/providers";
import { safeRmSync } from "../platform/fs_retry.js";
import type { ManifestEntry } from "../manifest/schema";
import { gatherNeighborContext, runEscalation } from "./escalate";

function entry(id: string, files: string[], over: Partial<ManifestEntry> = {}): ManifestEntry {
  return {
    component_id: id, component_type: "module", current_version: 1, schema_version: 5,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: "h", ...over,
  } as unknown as ManifestEntry;
}

let root: string;
let prevCwd: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;
let calls: number;
let lines: string[];

beforeEach(() => {
  prevCwd = process.cwd();
  root = realpathSync(mkdtempSync(join(tmpdir(), "purix-esc-")));
  execFileSync("git", ["init", "-q"], { cwd: root });
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "package.json"), '{"name":"t","type":"module"}');
  process.chdir(root);
  realFetch = globalThis.fetch;
  log = console.log;
  lines = [];
  console.log = (...a: unknown[]) => { lines.push(a.join(" ")); };
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
  calls = 0;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  closeDb();
  process.chdir(prevCwd);
  safeRmSync(root);
});

describe("runEscalation: capability gap", () => {
  it("stops after ONE call when the model reports a new capability and proposes no edits", async () => {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeManifest(entry("alpha", ["src/a.ts"]));
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
      calls++;
      void init;
      const verdict = { edits: [], reasoning: "This needs a streaming transport Purix has no transform for.", is_new_capability: true, suspicious_injected_instruction: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
    }) as unknown as typeof fetch;

    const res = await runEscalation("alpha", "unclassified", "add streaming", [{ path: "src/a.ts", content: "export const a = 1;\n" }], "no transform wired for this operation", root);

    expect(calls).toBe(1);
    expect(res.ok).toBe(false);
    expect(res.reason?.startsWith("capability gap")).toBe(true);
    expect(res.reason).toContain("nothing was changed");
    expect(res.reason).toContain("purix ingest");
    expect(res.reason).toContain("streaming transport");
    expect(lines.join("\n")).not.toContain("Escalation attempt 2/2");
  });

  it("still tries a second attempt when the model gives no edits but does NOT claim a capability gap", async () => {
    writeFileSync(join(root, "src/a.ts"), "export const a = 1;\n");
    writeManifest(entry("alpha", ["src/a.ts"]));
    globalThis.fetch = async () => {
      calls++;
      const verdict = { edits: [], reasoning: "unsure", is_new_capability: false, suspicious_injected_instruction: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
    };
    await runEscalation("alpha", "unclassified", "x", [{ path: "src/a.ts", content: "export const a = 1;\n" }], "reason", root);
    expect(calls).toBeGreaterThanOrEqual(2);
  });
});

describe("gatherNeighborContext: token budget", () => {
  function setup(): void {
    const small = "export const dep = 1;\n";
    const big = "// big dependent\n" + "export const line = 'x';\n".repeat(2000); // ~48k characters, ~14k estimated tokens
    writeFileSync(join(root, "src/main.ts"), "export const m = 1;\n");
    writeFileSync(join(root, "src/dep.ts"), small);
    writeFileSync(join(root, "src/user.ts"), big);
    writeFileSync(join(root, "src/user_small.ts"), "export const u = 1;\n");
    writeManifest(entry("main", ["src/main.ts"], { depends_on: ["dep"], depended_on_by: ["user"] }));
    writeManifest(entry("dep", ["src/dep.ts"], { depended_on_by: ["main"] }));
    writeManifest(entry("user", ["src/user.ts", "src/user_small.ts"], { depends_on: ["main"] }));
  }

  it("lists dependencies before dependents, and names a file that does not fit instead of dropping it silently", async () => {
    setup();
    const ctx = await gatherNeighborContext("main", root, 6000);
    expect(ctx.files.map((f) => `${f.component_id}/${f.path}`)).toEqual(["dep/src/dep.ts", "user/src/user_small.ts"]);
    expect(ctx.omitted).toEqual(["user/src/user.ts"]);
  });

  it("with a large budget everything is included and nothing is omitted", async () => {
    setup();
    const ctx = await gatherNeighborContext("main", root, 100000);
    expect(ctx.files.length).toBe(3);
    expect(ctx.omitted).toEqual([]);
  });

  it("the escalation prompt stays under budget and tells the model what was left out", async () => {
    setup();
    let sent = "";
    globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
      calls++;
      sent += JSON.parse(init.body).messages.map((m: { content: string }) => m.content).join("\n");
      const verdict = { edits: [], reasoning: "gap", is_new_capability: true, suspicious_injected_instruction: false };
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(verdict) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } }), { status: 200 });
    }) as unknown as typeof fetch;
    await runEscalation("main", "unclassified", "x", [{ path: "src/main.ts", content: "export const m = 1;\n" }], "reason", root);
    expect(sent).toContain("left out to keep the request short: user/src/user.ts");
    expect(sent).not.toContain("// big dependent");
    expect(sent.length).toBeLessThan(6000 * 3.5 + 8000); // budget plus the fixed prompt text
  });
});
