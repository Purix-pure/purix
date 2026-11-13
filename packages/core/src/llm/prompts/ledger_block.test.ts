// AI-12: the ledger block is optional. Without it the repair and escalation prompts are exactly what they were (the golden
// file pins that); with it, one tagged data block is added after the failure block and the rest is unchanged.
import { describe, it } from "node:test";
import { expect } from "expect";
import { repairPrompt, escalatePrompt } from "./build.js";

const norm = (s: string) => s.replace(/PURIX_([A-Z]+)_[0-9A-F]{12}/g, "PURIX_$1_TAG");

const repairIn = { componentId: "c", operation: "update_prompt_text", files: "--- a.ts ---\nx", failure: "boom", attempt: 2 };
const escIn = { componentId: "c", operation: "update_prompt_text", instruction: "do it", failureReason: "boom", attempt: 2, failingFiles: "--- a.ts ---\nx", neighborFiles: "n" };

describe("ledger block in prompts", () => {
  it("repairPrompt: no ledger, an empty ledger and a blank ledger all give the same bytes", () => {
    const none = norm(repairPrompt(repairIn).user);
    expect(norm(repairPrompt({ ...repairIn, ledger: "" }).user)).toBe(none);
    expect(norm(repairPrompt({ ...repairIn, ledger: "  \n " }).user)).toBe(none);
    expect(none).not.toContain("LEDGER");
    expect(repairPrompt(repairIn).system).toBe(repairPrompt({ ...repairIn, ledger: "round 1: x" }).system);
  });

  it("repairPrompt: a ledger adds one tagged block after the failure block and before the attempt line", () => {
    const u = norm(repairPrompt({ ...repairIn, ledger: "round 1: prompt_text on a.ts -> verification failed [type]" }).user);
    expect(u).toContain("PURIX_LEDGER_TAG");
    expect(u).toContain("round 1: prompt_text on a.ts -> verification failed [type]");
    expect(u.indexOf("PURIX_FAILURE_TAG")).toBeLessThan(u.indexOf("PURIX_LEDGER_TAG"));
    expect(u.indexOf("PURIX_LEDGER_TAG")).toBeLessThan(u.indexOf("This is repair attempt 2."));
    expect(u.endsWith("This is repair attempt 2.")).toBe(true);
  });

  it("escalatePrompt: no ledger changes nothing; a ledger sits after the failure block, before the request", () => {
    const none = norm(escalatePrompt(escIn).user);
    expect(norm(escalatePrompt({ ...escIn, ledger: "" }).user)).toBe(none);
    expect(none).not.toContain("LEDGER");
    const u = norm(escalatePrompt({ ...escIn, ledger: "round 1: no edits -> no edits proposed" }).user);
    expect(u.indexOf("PURIX_FAILURE_TAG")).toBeLessThan(u.indexOf("PURIX_LEDGER_TAG"));
    expect(u.indexOf("PURIX_LEDGER_TAG")).toBeLessThan(u.indexOf("The developer's request:"));
  });
});
