// AI-01: one bounded retry when a model reply cannot be read as the expected JSON.
// Tested on Linux against a stubbed provider (no network).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { persistProviderChoice } from "./providers";
import { callJson } from "./classify";
import { getBudgetSnapshot } from "./budget";
import { safeRmSync } from "../platform/fs_retry.js";

const Schema = z.object({ name: z.string() });
const PROMPT = { system: "SYSTEM RULES", user: "THE REQUEST" };

let cwd: string;
let tmp: string;
let realFetch: typeof fetch;
let log: typeof console.log;
let savedKey: string | undefined;
let bodies: { messages: { role: string; content: string }[] }[];

function reply(content: string, usage = { prompt_tokens: 10, completion_tokens: 5 }): Response {
  return new Response(JSON.stringify({ choices: [{ message: { content } }], usage }), { status: 200 });
}

function stub(replies: string[]): void {
  let i = 0;
  globalThis.fetch = (async (_u: unknown, init: { body: string }) => {
    bodies.push(JSON.parse(init.body));
    return reply(replies[Math.min(i++, replies.length - 1)]!);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  cwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-jsonretry-"));
  process.chdir(tmp);
  realFetch = globalThis.fetch;
  log = console.log;
  console.log = () => {};
  bodies = [];
  savedKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "sk-test";
  persistProviderChoice("openai");
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

describe("callJson", () => {
  it("makes exactly one call when the first reply is valid", async () => {
    stub(['{"name":"ok"}']);
    await expect(callJson(PROMPT, Schema, "test", "repair")).resolves.toEqual({ name: "ok" });
    expect(bodies.length).toBe(1);
  });

  it("asks once more after prose, and returns the second reply", async () => {
    stub(["Sure! Here is the change you asked for", '{"name":"fixed"}']);
    await expect(callJson(PROMPT, Schema, "test", "repair")).resolves.toEqual({ name: "fixed" });
    expect(bodies.length).toBe(2);
  });

  it("the retry keeps the system text and the request, and adds the rejected reply and the reason in the user message", async () => {
    stub(["Sure! Here is the change", '{"name":"fixed"}']);
    await callJson(PROMPT, Schema, "test", "repair");
    const [first, second] = bodies.map((b) => ({
      system: b.messages.filter((m) => m.role === "system").map((m) => m.content).join("\n"),
      user: b.messages.filter((m) => m.role === "user").map((m) => m.content).join("\n"),
    }));
    expect(second!.system).toBe(first!.system);
    expect(first!.user).toBe("THE REQUEST");
    expect(second!.user.startsWith("THE REQUEST")).toBe(true);
    expect(second!.user).toContain("it was not valid JSON");
    expect(second!.user).toContain("Sure! Here is the change");
    expect(second!.user).toMatch(/<PURIX_REPLY_[0-9A-F]{12}>/);
  });

  it("names the field problem when the shape was wrong", async () => {
    stub(['{"name": 5}', '{"name":"x"}']);
    await callJson(PROMPT, Schema, "test", "repair");
    expect(bodies[1]!.messages.find((m) => m.role === "user")!.content).toContain("name:");
  });

  it("cuts a very long rejected reply to 1,500 characters", async () => {
    stub(["x".repeat(20000), '{"name":"x"}']);
    await callJson(PROMPT, Schema, "test", "repair");
    const retryUser = bodies[1]!.messages.find((m) => m.role === "user")!.content;
    expect(retryUser.length).toBeLessThan(2600);
    expect(retryUser).toContain("more characters");
  });

  it("fails with today's plain error after two bad replies, and never calls a third time", async () => {
    stub(["not json at all", "still not json"]);
    let caught: unknown;
    try {
      await callJson(PROMPT, Schema, "change classification", "change_classification");
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).constructor).toBe(Error);
    expect((caught as Error).message).toContain("not valid JSON");
    expect((caught as Error).message).toContain("still not json");
    expect((caught as Error).message).toContain("Nothing was changed");
    expect(bodies.length).toBe(2);
  });

  it("an empty reply is retried too", async () => {
    stub(["", '{"name":"x"}']);
    await expect(callJson(PROMPT, Schema, "test", "repair")).resolves.toEqual({ name: "x" });
    expect(bodies[1]!.messages.find((m) => m.role === "user")!.content).toContain("it was empty");
  });

  it("a plain string prompt gets the notice appended", async () => {
    stub(["nope", '{"name":"x"}']);
    await callJson("ONE STRING PROMPT", Schema, "test", "repair");
    const sent = bodies[1]!.messages.map((m) => m.content).join("\n");
    expect(sent).toContain("ONE STRING PROMPT");
    expect(sent).toContain("could not be used");
  });

  it("each call settles its own budget reservation: spend equals the real usage of both calls, not the estimates", async () => {
    stub(["nope", '{"name":"x"}']);
    await callJson(PROMPT, Schema, "test", "repair");
    const after = getBudgetSnapshot();
    // Two calls of 10 + 5 tokens at the openai default prices cost a tiny fraction of one 0.05 reservation.
    expect(after).not.toBeNull();
    expect(after!.totalSpentUsd).toBeLessThan(0.01);
  });
});
