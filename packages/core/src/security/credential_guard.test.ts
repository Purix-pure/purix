// A second or conflicting stored key for one provider is refused; unused entries are reported.
import { describe, test } from "node:test";
import { expect } from "expect";
import { auditStoredSecrets, checkSecretRotate, checkSecretSet, nameMeant, secretValueProblem, type GuardContext } from "./credential_guard";

function ctx(over: Partial<GuardContext> & { stored?: Record<string, string>; env?: Record<string, string> } = {}): GuardContext {
  const stored = over.stored ?? {};
  const env = over.env ?? {};
  return {
    known: [
      { name: "GEMINI_API_KEY", purpose: "Gemini API key", providerId: "gemini" },
      { name: "OPENAI_API_KEY", purpose: "OpenAI API key", providerId: "openai" },
      { name: "PURIX_WEBHOOK_SECRET", purpose: "notification webhook signing secret" },
    ],
    storedNames: Object.keys(stored),
    storedValue: (n) => stored[n] ?? null,
    envValue: (n) => env[n],
    ...over,
  };
}
const reason = (r: { ok: boolean; reason?: string }) => (r.ok ? "" : (r as { reason: string }).reason);

describe("secretValueProblem", () => {
  test("accepts a plain key", () => expect(secretValueProblem("AIzaSyAbC123-_x")).toBeNull());
  for (const [label, v] of [["empty", ""], ["spaces", "   "], ["trailing newline", "abc\n"], ["leading space", " abc"], ["quoted", '"abc123"'], ["inner space", "abc def"], ["control", "ab\u0007c"]] as const) {
    test(`refuses ${label}`, () => expect(secretValueProblem(v)).not.toBeNull());
  }
});

describe("checkSecretSet", () => {
  test("stores a new known key", () => expect(checkSecretSet("GEMINI_API_KEY", "k1", ctx()).ok).toBe(true));
  test("refuses a second key for a name already stored", () => {
    const r = checkSecretSet("GEMINI_API_KEY", "k2", ctx({ stored: { GEMINI_API_KEY: "k1" } }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain("secret rotate GEMINI_API_KEY");
  });
  test("refuses a loose provider name and says the right one", () => {
    const r = checkSecretSet("gemini", "k1", ctx());
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain("secret set GEMINI_API_KEY");
  });
  test("refuses a name Purix never reads", () => {
    const r = checkSecretSet("MY_RANDOM_KEY", "k1", ctx());
    expect(reason(r)).toContain("not a credential Purix uses");
  });
  test("refuses when a dead sibling entry exists for the same provider", () => {
    const r = checkSecretSet("GEMINI_API_KEY", "k1", ctx({ stored: { gemini: "old" } }));
    expect(reason(r)).toContain("secret remove gemini");
  });
  test("refuses when the environment holds a different key", () => {
    const r = checkSecretSet("GEMINI_API_KEY", "k1", ctx({ env: { GEMINI_API_KEY: "other" } }));
    expect(r.ok).toBe(false);
    expect(reason(r)).toContain("different value");
  });
  test("allows the same key as the environment, with a note", () => {
    const r = checkSecretSet("GEMINI_API_KEY", "k1", ctx({ env: { GEMINI_API_KEY: "k1" } }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.notes.length).toBe(1);
  });
  test("a different provider's stored key does not block", () => {
    expect(checkSecretSet("GEMINI_API_KEY", "k1", ctx({ stored: { OPENAI_API_KEY: "o" } })).ok).toBe(true);
  });
  test("never echoes the key in a refusal", () => {
    const r = checkSecretSet("GEMINI_API_KEY", "SECRETVALUE", ctx({ stored: { GEMINI_API_KEY: "k1" }, env: { GEMINI_API_KEY: "X" } }));
    expect(reason(r)).not.toContain("SECRETVALUE");
  });
});

describe("checkSecretRotate", () => {
  test("rotates an existing entry", () => expect(checkSecretRotate("GEMINI_API_KEY", "k2", ctx({ stored: { GEMINI_API_KEY: "k1" } })).ok).toBe(true));
  test("refuses a name that is not stored", () => expect(reason(checkSecretRotate("GEMINI_API_KEY", "k2", ctx()))).toContain("nothing to rotate"));
  test("suggests the real name for a loose one", () => expect(reason(checkSecretRotate("gemini", "k2", ctx()))).toContain("GEMINI_API_KEY"));
  test("refuses when the environment holds a different key", () => {
    expect(checkSecretRotate("GEMINI_API_KEY", "k2", ctx({ stored: { GEMINI_API_KEY: "k1" }, env: { GEMINI_API_KEY: "z" } })).ok).toBe(false);
  });
});

describe("nameMeant", () => {
  const known = ctx().known;
  for (const n of ["gemini", "Gemini_Api_Key", "gemini-key", "GEMINI_API_KEY"]) test(`${n} -> GEMINI_API_KEY`, () => expect(nameMeant(n, known)?.name).toBe("GEMINI_API_KEY"));
  test("unrelated -> undefined", () => expect(nameMeant("banana", known)).toBeUndefined());
});

describe("auditStoredSecrets", () => {
  test("flags an unused entry and a stored/env difference, returns lengths only", () => {
    const a = auditStoredSecrets(ctx({ stored: { gemini: "abc", GEMINI_API_KEY: "12345" }, env: { GEMINI_API_KEY: "zzzzz" } }));
    const g = a.find((x) => x.name === "gemini")!;
    const k = a.find((x) => x.name === "GEMINI_API_KEY")!;
    expect(g.unused).toBe(true);
    expect(g.meant).toBe("GEMINI_API_KEY");
    expect(k.unused).toBe(false);
    expect(k.differsFromEnvironment).toBe(true);
    expect(k.length).toBe(5);
    expect(JSON.stringify(a)).not.toContain("12345");
  });
});
