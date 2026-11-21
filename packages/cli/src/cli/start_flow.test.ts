// The guided setup, end to end through its seams: questions in order, what is saved, what is never printed, and the exits.
// No terminal, no key store, no network: every dependency is a fake that records what it was asked.
import { describe, it } from "node:test";
import { expect } from "expect";
import { runStart, StartCancelled, NOT_A_TERMINAL_LINES, type StartDeps, type StartIO, type KeySource, type ProviderChoiceSource } from "./start_flow";

const PROVIDERS = [
  { id: "gemini", label: "Google Gemini", keyEnvVar: "GEMINI_API_KEY" },
  { id: "anthropic", label: "Anthropic Claude", keyEnvVar: "ANTHROPIC_API_KEY" },
  { id: "openai", label: "OpenAI", keyEnvVar: "OPENAI_API_KEY" },
];
const SECRET = "sk-test-SECRET-value-1234567890";

interface World {
  current: { id: string; source: ProviderChoiceSource } | null;
  keySource: KeySource;
  conflict: boolean;
  env: Record<string, string>;
  stored: Set<string>;
  probeResult: { ok: true; provider: string; model: string } | { ok: false; message: string };
  connectCode: number;
  storeRefusals: string[]; // reasons returned, in order, before a store succeeds
}
const world = (over: Partial<World> = {}): World => ({
  current: null, keySource: "missing", conflict: false, env: {}, stored: new Set(), connectCode: 0, storeRefusals: [],
  probeResult: { ok: true, provider: "gemini", model: "m-low" }, ...over,
});

function harness(w: World, answers: Array<string | null>, secrets: string[] = [SECRET], interactive = true) {
  const out: string[] = [];
  const err: string[] = [];
  const asked: string[] = [];
  const calls: string[] = [];
  const storedValues: Array<[string, string]> = [];
  let a = 0;
  let sec = 0;
  const io: StartIO = {
    interactive,
    log: (l) => out.push(l),
    err: (l) => err.push(l),
    ask: async (q) => { asked.push(q); return a < answers.length ? answers[a++]! : null; },
    askSecret: async () => { const v = secrets[sec++]; if (v === undefined) throw new StartCancelled(); return v; },
  };
  const deps: StartDeps = {
    providers: () => PROVIDERS,
    currentProvider: () => w.current,
    saveDefaultProvider: (id) => { calls.push(`saveDefault:${id}`); w.current = { id, source: "user_default" }; },
    keyStatus: (id) => { const p = PROVIDERS.find((x) => x.id === id); return p ? { envVar: p.keyEnvVar, source: w.keySource, conflict: w.conflict } : undefined; },
    envValue: (n) => w.env[n],
    hasStoredKey: (n) => w.stored.has(n),
    storeKey: (n, v) => {
      calls.push(`store:${n}`);
      const refusal = w.storeRefusals.shift();
      if (refusal) return { ok: false, reason: refusal };
      w.stored.add(n); storedValues.push([n, v]);
      return { ok: true, backend: "keyring", notes: [] };
    },
    probe: async (id) => { calls.push(`probe:${id}`); return w.probeResult; },
    runConnect: async () => { calls.push("connect"); return w.connectCode; },
  };
  return { io, deps, out, err, asked, calls, storedValues, all: () => [...out, ...err].join("\n") };
}

describe("purix start", () => {
  it("refuses without a terminal, says what to run instead, and touches nothing", async () => {
    const w = world();
    const h = harness(w, [], [], false);
    const throwing = new Proxy(h.deps, { get: () => () => { throw new Error("must not be called"); } }) as StartDeps;
    expect(await runStart(h.io, throwing)).toBe(1);
    expect(h.err).toEqual([...NOT_A_TERMINAL_LINES]);
    expect(h.err.join("\n")).toContain("purix start");
    expect(h.err.join("\n")).toContain("purix secret set <KEY_NAME>");
    expect(h.out).toEqual([]);
  });

  it("first run: choose a provider by number, paste the key, check it, connect an agent", async () => {
    const w = world();
    const h = harness(w, ["2", "", "", ""]); // provider 2, then Enter = yes for check, Enter = yes for connect
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls).toEqual(["saveDefault:anthropic", "store:ANTHROPIC_API_KEY", "probe:anthropic", "connect"]);
    expect(h.storedValues).toEqual([["ANTHROPIC_API_KEY", SECRET]]);
    const text = h.all();
    expect(text).toContain("Saved anthropic as your default provider. It applies in every folder.");
    expect(text).toContain("Saved ANTHROPIC_API_KEY");
    expect(text).toContain("Anthropic Claude accepted the key");
    expect(text).toContain("Not done: your project was not indexed.");
    expect(text).toContain("restart your coding agent");
    expect(text).not.toContain(SECRET);
  });

  it("a provider can be typed as an id, case does not matter", async () => {
    const w = world();
    const h = harness(w, ["OpenAI", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls).toEqual(["saveDefault:openai", "store:OPENAI_API_KEY"]);
  });

  it("an unknown provider or Enter changes nothing and exits 1", async () => {
    for (const answer of ["nonsense", "9", ""]) {
      const w = world();
      const h = harness(w, [answer]);
      expect(await runStart(h.io, h.deps)).toBe(1);
      expect(h.calls).toEqual([]);
    }
  });

  it("key already in the environment: offers a copy, and saves the environment's own value on yes", async () => {
    const w = world({ current: { id: "openai", source: "user_default" }, keySource: "environment", env: { OPENAI_API_KEY: SECRET } });
    const h = harness(w, ["", "", "n", "n"]); // keep provider, copy yes, check n, connect n
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.storedValues).toEqual([["OPENAI_API_KEY", SECRET]]);
    expect(h.asked.some((q) => q.includes("Also save a copy of OPENAI_API_KEY"))).toBe(true);
    expect(h.all()).toContain("Found OPENAI_API_KEY in your environment (not shown).");
    expect(h.all()).not.toContain(SECRET);
    expect(h.out.join("\n")).toContain("Key:       saved for your user account");
  });

  it("key in the environment and declined copy: nothing stored", async () => {
    const w = world({ current: { id: "openai", source: "user_default" }, keySource: "environment", env: { OPENAI_API_KEY: SECRET } });
    const h = harness(w, ["", "n", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.all()).toContain("from your environment");
  });

  it("key in the environment and already saved too: no copy question", async () => {
    const w = world({ current: { id: "openai", source: "user_default" }, keySource: "environment", env: { OPENAI_API_KEY: SECRET }, stored: new Set(["OPENAI_API_KEY"]) });
    const h = harness(w, ["", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.asked.some((q) => q.includes("Also save a copy"))).toBe(false);
    expect(h.all()).toContain("A copy is already saved too.");
  });

  it("PURIX_LLM_PROVIDER decides: no provider question, and the person is told how to change it", async () => {
    const w = world({ current: { id: "gemini", source: "environment" }, keySource: "stored" });
    const h = harness(w, ["n", "n", "n"]); // replace? n, check n, connect n
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.asked[0]).toContain("Replace it with a new key?");
    expect(h.all()).toContain("set by the PURIX_LLM_PROVIDER variable");
    expect(h.calls).toEqual([]);
  });

  it("a stored key is kept unless the person says to replace it; a replacement goes through the same store", async () => {
    const keep = harness(world({ current: { id: "gemini", source: "user_default" }, keySource: "stored" }), ["", "", "n", "n"]);
    expect(await runStart(keep.io, keep.deps)).toBe(0);
    expect(keep.calls).toEqual([]);

    const replace = harness(world({ current: { id: "gemini", source: "user_default" }, keySource: "stored" }), ["", "y", "n", "n"]);
    expect(await runStart(replace.io, replace.deps)).toBe(0);
    expect(replace.calls).toEqual(["store:GEMINI_API_KEY"]);
  });

  it("a project's own provider setting is kept as is, and the person is told other folders are not covered", async () => {
    const w = world({ current: { id: "gemini", source: "project" }, keySource: "stored" });
    const h = harness(w, ["", "n", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls).toEqual([]);
    expect(h.all()).toContain("Other folders have no provider yet");
  });

  it("choosing a different provider than the project's says which one wins where", async () => {
    const w = world({ current: { id: "gemini", source: "project" }, keySource: "missing" });
    const h = harness(w, ["n", "3", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.all()).toContain("This folder has its own setting (gemini), which still wins here. Other folders use openai.");
  });

  it("a badly pasted key is refused with the reason and asked for again, up to three times", async () => {
    const w = world({ storeRefusals: ["The value contains a space. API keys do not.", "The value is empty."] });
    const h = harness(w, ["1", "n", "n"], ["a b", "", SECRET]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls.filter((c) => c.startsWith("store:"))).toHaveLength(3);
    expect(h.err.join("\n")).toContain("The value contains a space");
    expect(h.storedValues).toEqual([["GEMINI_API_KEY", SECRET]]);
  });

  it("three bad pastes stop with exit 1 and a way forward", async () => {
    const bad = "The value contains a space.";
    const w = world({ storeRefusals: [bad, bad, bad] });
    const h = harness(w, ["1"], ["a b", "c d", "e f"]);
    expect(await runStart(h.io, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("The key was not saved");
    expect(h.err.join("\n")).toContain("purix secret set GEMINI_API_KEY");
  });

  it("a refusal that retyping cannot fix (a conflicting environment key) is not retried", async () => {
    const w = world({ storeRefusals: ["The environment variable GEMINI_API_KEY is already set to a different value."] });
    const h = harness(w, ["1"], [SECRET, SECRET]);
    expect(await runStart(h.io, h.deps)).toBe(1);
    expect(h.calls.filter((c) => c.startsWith("store:"))).toHaveLength(1);
  });

  it("a failed key check exits 1, keeps the key, and points to rotate; the agent step still runs", async () => {
    const w = world({ probeResult: { ok: false, message: "Gemini 400: API key not valid" } });
    const h = harness(w, ["1", "y", "y"]);
    expect(await runStart(h.io, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("The check failed: Gemini 400: API key not valid");
    expect(h.err.join("\n")).toContain("purix secret rotate GEMINI_API_KEY");
    expect(h.calls).toContain("connect");
    expect(w.stored.has("GEMINI_API_KEY")).toBe(true);
    expect(h.out.join("\n")).toContain("Key check: failed");
  });

  it("a declined key check is said out loud and still exits 0", async () => {
    const h = harness(world(), ["1", "n", "n"]);
    expect(await runStart(h.io, h.deps)).toBe(0);
    expect(h.calls.some((c) => c.startsWith("probe"))).toBe(false);
    expect(h.out.join("\n")).toContain("Not checked. The first real request will be the first test.");
    expect(h.out.join("\n")).toContain("Key check: not run");
  });

  it("a failed connect makes the exit code 1 but the key work stays done", async () => {
    const w = world({ connectCode: 1 });
    const h = harness(w, ["1", "n", "y"]);
    expect(await runStart(h.io, h.deps)).toBe(1);
    expect(w.stored.has("GEMINI_API_KEY")).toBe(true);
    expect(h.out.join("\n")).toContain("Agent:     failed");
  });

  it("input ending (Ctrl-D) or Ctrl-C at the key prompt is a cancel with exit 130", async () => {
    const eof = harness(world(), ["1"], [SECRET]);
    eof.io.ask = async () => null;
    expect(await runStart(eof.io, eof.deps)).toBe(130);

    const ctrlC = harness(world(), ["1"], []); // askSecret throws StartCancelled when no secret is queued
    expect(await runStart(ctrlC.io, ctrlC.deps)).toBe(130);
    expect(ctrlC.out.join("\n")).toContain("Anything already saved stays saved");
    expect(ctrlC.calls.filter((c) => c.startsWith("store"))).toEqual([]);
  });

  it("an incomplete provider (no key name) stops with the next command", async () => {
    const w = world({ current: { id: "ghost", source: "user_default" } });
    const h = harness(w, [""]);
    expect(await runStart(h.io, h.deps)).toBe(1);
    expect(h.err.join("\n")).toContain("purix provider status");
  });

  it("never prints the key, whatever happens", async () => {
    const w = world({ probeResult: { ok: false, message: "rejected" } });
    const h = harness(w, ["1", "y", "y"]);
    await runStart(h.io, h.deps);
    expect(h.all()).not.toContain(SECRET);
  });
});
