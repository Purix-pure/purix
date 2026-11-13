// AI-05: one row per provider call, no prompt or reply text anywhere, honest report on an empty table.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, getDbCompat } from "../manifest/store.js";
import { persistProviderChoice } from "./providers.js";
import { callLlm, parseModelJson, classifyRepair } from "./classify.js";
import { buildCallReport, formatCallReport } from "./call_log.js";
import { routeTier } from "./router.js";
import { z } from "zod";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, tmp: string, realFetch: typeof fetch, log: typeof console.log, savedKey: string | undefined;
const CANARY = "CANARY_7f3a9c_do_not_store";

const ok = (content: string, usage: Record<string, unknown> = { prompt_tokens: 700, completion_tokens: 20 }) =>
  new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });

const rows = () => getDbCompat().query("SELECT * FROM llm_call_log ORDER BY id").all() as Record<string, unknown>[];

beforeEach(() => {
  cwd = process.cwd(); tmp = mkdtempSync(join(tmpdir(), "purix-calllog-")); process.chdir(tmp);
  realFetch = globalThis.fetch; log = console.log; console.log = () => {};
  savedKey = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
});
afterEach(() => {
  globalThis.fetch = realFetch; console.log = log;
  if (savedKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = savedKey;
  delete process.env.PURIX_TIER_REPAIR;
  closeDb(); process.chdir(cwd); safeRmSync(tmp);
});

describe("llm_call_log", () => {
  it("records one row per call with sizes and tier, and the canary in the prompt and reply appears in no column", async () => {
    globalThis.fetch = async () => ok(`reply ${CANARY}`);
    await callLlm({ system: `sys ${CANARY}`, user: `user ${CANARY}` }, "diff_classification", "low");
    const r = rows();
    expect(r.length).toBe(1);
    expect(r[0]).toMatchObject({ call_type: "diff_classification", tier: "low", provider: "openai", input_tokens: 700, output_tokens: 20, status: "ok", retry: 0 });
    expect(r[0]!.prompt_chars).toBe(`sys ${CANARY}user ${CANARY}`.length);
    for (const v of Object.values(r[0]!)) expect(String(v)).not.toContain(CANARY);
  });

  it("a failed call is logged as provider_error with zero tokens, and a retried call is flagged as a retry", async () => {
    globalThis.fetch = async () => new Response("Unauthorized", { status: 401 });
    await expect(callLlm("p", "repair", "low")).rejects.toThrow();
    // attempt 5 skips the back-off wait, exactly as the existing retry tests do
    await expect(callLlm("p", "repair", "low", 5)).rejects.toThrow();
    const r = rows();
    expect(r.map((x) => [x.status, x.retry, x.input_tokens])).toEqual([["provider_error", 0, 0], ["provider_error", 1, 0]]);
  });

  it("a reply that is not valid JSON, or the wrong shape, marks its row format_error", async () => {
    globalThis.fetch = async () => ok("Sure! Here is the change");
    const raw = await callLlm("p", "change_classification", "low");
    expect(() => parseModelJson(raw, z.object({ a: z.string() }), "x")).toThrow();
    globalThis.fetch = async () => ok("{}");
    const raw2 = await callLlm("p", "change_classification", "low");
    expect(() => parseModelJson(raw2, z.object({ a: z.string() }), "x")).toThrow();
    const raw3 = await callLlm("p", "change_classification", "low");
    expect(parseModelJson(raw3.replace("{}", '{"a":"b"}'), z.object({}).passthrough(), "x")).toBeDefined();
    expect(rows().map((x) => x.status)).toEqual(["format_error", "format_error", "ok"]);
  });

  it("parseModelJson with no call behind it touches nothing", () => {
    expect(() => parseModelJson("nope", z.object({}), "x")).toThrow();
  });

  it("cached input tokens are stored when the provider reports them and null when it does not", async () => {
    globalThis.fetch = async () => ok("{}", { prompt_tokens: 1000, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 640 } });
    await callLlm("p", "repair", "low");
    globalThis.fetch = async () => ok("{}");
    await callLlm("p", "repair", "low");
    expect(rows().map((x) => x.cached_input_tokens)).toEqual([640, null]);
    expect(buildCallReport().cachedInputShare).toBeCloseTo(0.64, 5); // only the row that reported a figure counts
  });

  it("classifyRepair goes through the router: low by default, high when PURIX_TIER_REPAIR=high, and the row says which", async () => {
    globalThis.fetch = async () => ok('{"edits":[],"reasoning":"r"}');
    await classifyRepair("c", "update_prompt_text", [{ path: "a.ts", content: "x" }], "err", 1);
    process.env.PURIX_TIER_REPAIR = "high";
    await classifyRepair("c", "update_prompt_text", [{ path: "a.ts", content: "x" }], "err", 2);
    expect(rows().map((x) => [x.call_type, x.tier])).toEqual([["repair", "low"], ["repair", "high"]]);
    expect(routeTier("repair").reason).toContain("PURIX_TIER_REPAIR");
    process.env.PURIX_TIER_REPAIR = "banana";
    expect(routeTier("repair").tier).toBe("low");
  });

  it("the report prints on an empty table, and reports the estimate ratio and unclassified share when rows exist", async () => {
    expect(formatCallReport(buildCallReport())).toContain("none recorded yet");
    globalThis.fetch = async () => ok("{}");
    await callLlm("x".repeat(3500), "change_classification", "low"); // estimate 1000, reported 700
    const rep = buildCallReport();
    expect(rep.totalCalls).toBe(1);
    expect(rep.estimateRatios[0]).toMatchObject({ provider: "openai", samples: 1 });
    expect(rep.estimateRatios[0]!.actualOverEstimate).toBeCloseTo(0.7, 2);
    expect(rep.byType[0]!.unclassifiedShare).toBeNull();
  });
});
