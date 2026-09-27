// src/manifest/change_target.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { resolveChangeTarget } from "./change_target.js";
import type { ManifestEntry } from "./schema.js";

const e = (id: string, files: string[] = []): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 1,
  parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
  verification_status: "unverified" as ManifestEntry["verification_status"], last_synced_hash: null,
});
const manifest = [e("billing-service", ["src/billing/service.ts"]), e("auth-service", ["src/auth/service.ts"])];

describe("resolveChangeTarget", () => {
  it("override skips resolution and validates the id", async () => {
    const r = await resolveChangeTarget({ intent: "anything", manifest, componentId: "auth-service" });
    expect(r).toMatchObject({ outcome: "single", source: "override" });
    await expect(resolveChangeTarget({ intent: "x", manifest, componentId: "nope" })).rejects.toThrow(/No manifest entry/);
    await expect(resolveChangeTarget({ intent: "x", manifest: [e("purix-codebase-index")], componentId: "purix-codebase-index" })).rejects.toThrow();
  });
  it("resolves deterministically without calling the LLM", async () => {
    let called = 0;
    const r = await resolveChangeTarget({ intent: "round invoice totals in billing-service", manifest, extractWithLlm: async () => { called++; return []; } });
    expect(r).toMatchObject({ outcome: "single", source: "deterministic" });
    expect(called).toBe(0);
  });
  it("reports multiple when several match", async () => {
    const r = await resolveChangeTarget({ intent: "tweak service.ts", manifest });
    expect(r.outcome).toBe("multiple");
  });
  it("uses the LLM tier only after a deterministic miss, and only for verbatim strings", async () => {
    const intent = "tidy the Billing Service module";
    const r = await resolveChangeTarget({ intent, manifest: [e("billing-service")], extractWithLlm: async () => ["Billing Service", "auth-service"] });
    expect(r).toMatchObject({ outcome: "single", source: "deterministic" }); // n-gram join already catches it
    const r2 = await resolveChangeTarget({ intent: "improve the payroll thing", manifest, extractWithLlm: async () => ["auth-service"] });
    expect(r2.outcome).toBe("none"); // model-invented target rejected
  });
  it("an LLM failure fails closed instead of reading as 'none'", async () => {
    await expect(
      resolveChangeTarget({ intent: "improve the payroll thing", manifest, extractWithLlm: async () => { throw new Error("boom"); } })
    ).rejects.toThrow(/Nothing was changed/);
  });
  it("returns none with no LLM tier", async () => {
    expect((await resolveChangeTarget({ intent: "improve the payroll thing", manifest })).outcome).toBe("none");
  });
});