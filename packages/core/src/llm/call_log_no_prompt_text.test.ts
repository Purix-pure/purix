// src/llm/call_log_no_prompt_text.test.ts
//
// "Payload log" one-day fix from "Purix Security After the Plan" (L3): call logs keep metadata only, and a test proves that no
// prompt text lands on disk. The call-log table has no free-text column today; this test is what stops someone adding one, or
// a failure path writing a provider reply body somewhere, without a test failing.
// Method: send a distinctive canary in the prompt, return it in the model's reply, in a provider error body and in a malformed
// reply, then search every byte of every file the run created (project folder, user folder, SQLite WAL and shm included).
// Limit: it covers callLlm and the failure paths below, on Linux, with a stubbed fetch. It does not cover the audit-event
// writers (recordEvent) when a command passes prompt text into them; those are not exercised here.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callLlm } from "./classify";
import { safeRmSync } from "../platform/fs_retry.js";

const CANARY_PROMPT = "CANARY-PROMPT-7f3a91c2-quarterly-revenue-forecast";
const CANARY_REPLY = "CANARY-REPLY-b81d44e0-internal-roadmap";
const CANARY_ERROR = "CANARY-ERRBODY-5c09aa17-customer-list";

let cwd: string, tmp: string, userDir: string, realFetch: typeof fetch, log: typeof console.log, warn: typeof console.warn;
let savedKey: string | undefined, savedUser: string | undefined;
let mode: "ok" | "error" | "badjson";

function allFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const s = statSync(p);
    if (s.isDirectory()) allFiles(p, out);
    else out.push(p);
  }
  return out;
}

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-no-prompt-text-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-no-prompt-text-user-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch; log = console.log; warn = console.warn;
  console.log = () => {}; console.warn = () => {};
  savedKey = process.env.OPENAI_API_KEY; savedUser = process.env.PURIX_USER_DIR;
  process.env.OPENAI_API_KEY = "sk-test"; process.env.PURIX_USER_DIR = userDir;
  persistProviderChoice("openai");
  mode = "ok";
  globalThis.fetch = (async () => {
    if (mode === "error") return new Response(JSON.stringify({ error: { message: CANARY_ERROR } }), { status: 500 });
    const content = mode === "badjson" ? `not json ${CANARY_REPLY}` : CANARY_REPLY;
    return new Response(JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 12, completion_tokens: 7 } }), { status: 200 });
  });
});

afterEach(() => {
  globalThis.fetch = realFetch; console.log = log; console.warn = warn;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  if (savedUser === undefined) delete process.env.PURIX_USER_DIR; else process.env.PURIX_USER_DIR = savedUser;
  closeDb();
  process.chdir(cwd);
  safeRmSync(tmp); safeRmSync(userDir);
});

function onDisk(): { path: string; canary: string }[] {
  closeDb(); // flush the WAL into the database file so the search sees what a reader of the project would see
  const hits: { path: string; canary: string }[] = [];
  for (const root of [tmp, userDir]) {
    for (const f of allFiles(root)) {
      const bytes = readFileSync(f).toString("latin1");
      for (const c of [CANARY_PROMPT, CANARY_REPLY, CANARY_ERROR]) if (bytes.includes(c)) hits.push({ path: f.replace(root, ""), canary: c });
    }
  }
  return hits;
}

describe("call logs keep metadata only", () => {
  it("a successful call leaves no prompt or reply text on disk, and does write a call-log row", async () => {
    await callLlm(`summarise: ${CANARY_PROMPT}`, "repair").catch(() => undefined);
    const files = allFiles(tmp).concat(allFiles(userDir));
    expect(files.length).toBeGreaterThan(0); // the run did write something (the log), so the search below is not vacuous
    expect(onDisk()).toEqual([]);
  });
  it("a provider error body leaves no text on disk", async () => {
    mode = "error";
    await callLlm(`summarise: ${CANARY_PROMPT}`, "repair").catch(() => undefined);
    expect(onDisk()).toEqual([]);
  });
  it("a malformed reply (format error) leaves no text on disk", async () => {
    mode = "badjson";
    await callLlm(`summarise: ${CANARY_PROMPT}`, "repair").catch(() => undefined);
    expect(onDisk()).toEqual([]);
  });
});
