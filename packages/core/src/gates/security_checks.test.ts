// Drift guard: the list of what the security gate looks for (SECURITY_CHECK_GROUPS) must match the categories the code can actually emit.
import { describe, it } from "node:test";
import { expect } from "expect";
import { readFileSync } from "node:fs";
import { SECURITY_CHECK_GROUPS } from "./security_gate.js";

const FILES = ["security_gate.ts", "manifest_delta.ts", "lock_delta.ts", "../security/security_audit.ts"];

function emitted(): Set<string> {
  const out = new Set<string>();
  for (const f of FILES) {
    const text = readFileSync(new URL(`./${f}`, import.meta.url.replace("/dist/", "/src/")), "utf8");
    for (const m of text.matchAll(/category:\s*"([^"]+)"/g)) out.add(m[1]!);
  }
  return out;
}

describe("SECURITY_CHECK_GROUPS", () => {
  const listed = SECURITY_CHECK_GROUPS.flatMap((g) => [...g.categories]);

  it("lists every category the code emits, and no other", () => {
    const code = emitted();
    expect([...code].filter((c) => !listed.includes(c))).toEqual([]);
    expect(listed.filter((c) => !code.has(c))).toEqual([]);
  });

  it("lists each category once", () => {
    expect(new Set(listed).size).toBe(listed.length);
  });
});
