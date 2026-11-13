// src/llm/classify_outbound_scrub.test.ts
//
// A7-1 acceptance: a secret planted in a component file never appears in the request body that leaves the machine, whichever
// call reaches the provider (classification, refinement, repair, the format re-ask), and a secret in the model's reply is
// redacted before any caller sees it. Uses the real callLlm with a stubbed fetch, like classify_savings.test.ts.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm, classifyModification, classifyRepair, refineIntent } from "./classify";
import { safeRmSync } from "../platform/fs_retry.js";

const AWS = "AKIAIOSFODNN7EXAMPLE";
const PEM = "-----BEGIN PRIVATE KEY-----";
const GH = "ghp_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA";

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;
let bodies: string[];
let reply: string;

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-outbound-scrub-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
  bodies = [];
  reply = "{}";
  globalThis.fetch = (async (_u: unknown, init?: { body?: unknown }) => {
    bodies.push(typeof init?.body === "string" ? init.body : "");
    return new Response(JSON.stringify({ choices: [{ message: { content: reply } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }), { status: 200 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch;
  console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = savedKey;
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp);
});

const files = [{ path: "a.ts", content: `const k = "${AWS}";\nconst p = \`${PEM}\nMIIEvQ\`;\nconst t = "${GH}";\nexport const x = 1;` }];
const sent = () => bodies.join("\n");

describe("callLlm: nothing secret-shaped leaves in a request", () => {
  it("a plain string prompt", async () => {
    await callLlm(`please look at ${AWS}`, "repair");
    expect(sent()).not.toContain(AWS);
  });

  it("classifyModification with a component file that holds secrets", async () => {
    await classifyModification("c1", "rename x to y", files).catch(() => undefined);
    for (const s of [AWS, PEM, GH]) expect(sent()).not.toContain(s);
    expect(sent()).toContain("export const x = 1;");
  });

  it("refineIntent", async () => {
    await refineIntent("c1", "rename x", files).catch(() => undefined);
    for (const s of [AWS, PEM, GH]) expect(sent()).not.toContain(s);
  });

  it("classifyRepair", async () => {
    await classifyRepair("c1", "refactor", files, "error TS2322 in a.ts", 1).catch(() => undefined);
    for (const s of [AWS, PEM, GH]) expect(sent()).not.toContain(s);
  });

  it("the format re-ask, which sends the rejected reply back, is scrubbed too", async () => {
    reply = `Sure! the key is ${AWS}`;
    await classifyModification("c1", "rename x to y", [{ path: "a.ts", content: "export const x = 1;" }]).catch(() => undefined);
    expect(bodies.length).toBe(2);
    expect(bodies[1]).not.toContain(AWS);
  });
});

describe("callLlm: a secret in the reply is redacted", () => {
  it("the caller never sees the token the model produced", async () => {
    reply = `use ${GH} here`;
    const out = await callLlm("hello", "repair");
    expect(out).not.toContain(GH);
    expect(out).toContain("use ");
  });

  it("a clean reply is returned byte for byte", async () => {
    reply = `{"a":1,"b":"two"}`;
    expect(await callLlm("hello", "repair")).toBe(reply);
  });
});
