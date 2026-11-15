// P4: the planner for a new component is shown the project's conventions and the ids of components that exist, and an invented
// depends_on id gets one corrective retry. A stand-in model records every request and replies from a script.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planNewComponent, recordCreateMemory, existingComponentIds } from "./create_plan.js";
import { greenfieldPrompt } from "../llm/prompts/build.js";
import { closeDb, writeManifest } from "../manifest/store.js";
import { rememberNote, readRelevantMemory } from "../manifest/memory.js";
import type { ManifestEntry } from "../manifest/schema.js";
import { safeRmSync } from "../platform/fs_retry.js";

let tmpDir: string, userDir: string, oldCwd: string, originalFetch: typeof fetch;
let bodies: string[];
let replies: string[][]; // depends_on lists to answer with, in order

const comp = (id: string, o: Partial<ManifestEntry> = {}): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files: [`${id}.ts`], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null, ...o,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-createplan-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-createplan-user-"));
  process.env.PURIX_USER_DIR = userDir;
  process.env.PURIX_LLM_PROVIDER = "openai";
  process.env.OPENAI_API_KEY = "k";
  oldCwd = process.cwd();
  process.chdir(tmpDir);
  bodies = [];
  replies = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_i: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? init.body : "";
    if (!body) return new Response("{}", { status: 200 });
    bodies.push(body);
    const deps = replies.shift() ?? [];
    const plan = { component_id: "team-board", component_type: "module", files: [{ path: "team-board.ts", purpose: "board", starter_content: "export const b = 1;\n" }], depends_on: deps };
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(plan) } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  closeDb();
  process.chdir(oldCwd);
  safeRmSync(tmpDir);
  safeRmSync(userDir);
  for (const k of ["PURIX_USER_DIR", "PURIX_LLM_PROVIDER", "OPENAI_API_KEY"]) delete process.env[k];
});

describe("greenfieldPrompt", () => {
  const base = { componentName: "x", projectBlock: "", testGuidance: "t" };
  test("is byte-identical to before when there are no conventions and no known components", () => {
    // Each prompt carries random delimiter tags (PURIX_REQUEST_<random>); compare with the random part masked.
    const mask = (p: { system: string; user: string }) => JSON.stringify(p).replace(/PURIX_([A-Z]+)_[0-9A-Za-z]+/g, "PURIX_$1_TAG");
    expect(mask(greenfieldPrompt({ ...base, conventions: [], knownComponents: [] }))).toEqual(mask(greenfieldPrompt(base)));
  });
  test("shows both lists, and says depends_on may only use the listed ids", () => {
    const p = greenfieldPrompt({ ...base, conventions: ["[decision] cents"], knownComponents: ["billing"] });
    expect(p.user).toContain("[decision] cents");
    expect(p.user).toContain("billing");
    expect(p.system).toContain("only ids from the list of existing component ids");
  });
});

describe("planNewComponent", () => {
  test("the model is shown the recorded conventions and the existing ids, but not the codebase-index record", async () => {
    writeManifest(comp("billing"));
    writeManifest(comp("__codebase_index__", { component_type: "codebase_index" }));
    rememberNote({ note: "Money is stored as integer cents.", source: "person" });
    replies = [["billing"]];
    const r = await planNewComponent("team-board", "a team board");
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain("Money is stored as integer cents.");
    expect(bodies[0]).toContain("billing");
    expect(existingComponentIds()).toEqual(["billing"]);
    expect(r.plan.depends_on).toEqual(["billing"]);
    expect(r.retried).toBe(false);
  });

  test("an invented id gets exactly one retry that names it; a valid second answer is kept", async () => {
    writeManifest(comp("billing"));
    replies = [["ghost-service"], ["billing"]];
    const r = await planNewComponent("team-board", "a team board");
    expect(bodies).toHaveLength(2);
    expect(bodies[1]).toContain("ghost-service");
    expect(r.retried).toBe(true);
    expect(r.plan.depends_on).toEqual(["billing"]);
    expect(r.droppedDependsOn).toEqual([]);
  });

  test("an id still invented after the retry is dropped and reported, with no third call", async () => {
    writeManifest(comp("billing"));
    replies = [["ghost"], ["ghost", "billing"]];
    const r = await planNewComponent("team-board", "a team board");
    expect(bodies).toHaveLength(2);
    expect(r.plan.depends_on).toEqual(["billing"]);
    expect(r.droppedDependsOn).toEqual(["ghost"]);
  });

  test("in an empty project an invented id is dropped without paying for a retry", async () => {
    replies = [["ghost"]];
    const r = await planNewComponent("team-board", "a team board");
    expect(bodies).toHaveLength(1);
    expect(r.plan.depends_on).toEqual([]);
    expect(r.droppedDependsOn).toEqual(["ghost"]);
  });

  test("a project with nothing recorded and no components sends a prompt without either block", async () => {
    replies = [[]];
    await planNewComponent("team-board", "a team board");
    expect(bodies[0]).not.toContain("Conventions recorded");
    expect(bodies[0]).not.toContain("Ids of components that already exist");
  });
});

describe("recordCreateMemory", () => {
  test("writes one line about the component that a later modify is shown", () => {
    writeManifest(comp("team-board", { depends_on: ["billing"] }));
    recordCreateMemory(comp("team-board", { depends_on: ["billing"] }), "a team board with  cards");
    const lines = readRelevantMemory("team-board").map((e) => `${e.kind}: ${e.summary}`);
    expect(lines).toEqual(["create: a team board with cards (files: team-board.ts; depends on billing)"]);
  });
});
