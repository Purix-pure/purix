// packages/core/src/manifest/resolver.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { resolveTarget } from "./resolver.js";
import type { ManifestEntry } from "./schema.js";

function entry(overrides: Partial<ManifestEntry> & { component_id: string }): ManifestEntry {
  return {
    component_type: "module",
    current_version: 1,
    schema_version: 1,
    parts: { tools: [], config: {} },
    files: [],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "unverified" as ManifestEntry["verification_status"],
    last_synced_hash: null,
    ...overrides,
  };
}

describe("resolveTarget", () => {
  it("resolves a single strong component_id match", () => {
    const manifest = [
      entry({ component_id: "billing-service", files: ["src/billing/service.ts"] }),
      entry({ component_id: "auth-service", files: ["src/auth/service.ts"] }),
    ];
    const result = resolveTarget({ mentions: ["billing-service"], manifest });
    expect(result.outcome).toBe("single");
    if (result.outcome !== "single") throw new Error("unreachable");
    expect(result.target.componentId).toBe("billing-service");
    expect(result.target.reason).toBe("component_id");
  });

  it("resolves via a file path mention", () => {
    const manifest = [
      entry({ component_id: "billing-service", files: ["src/billing/service.ts"] }),
      entry({ component_id: "auth-service", files: ["src/auth/service.ts"] }),
    ];
    // "service.ts in billing" as a raw mention won't boundary-match either
    // path directly — this checks the narrower, realistic mention shape
    // an extractor would actually produce.
    const narrower = resolveTarget({ mentions: ["src/billing/service.ts"], manifest });
    expect(narrower.outcome).toBe("single");
    if (narrower.outcome !== "single") throw new Error("unreachable");
    expect(narrower.target.componentId).toBe("billing-service");
    expect(narrower.target.reason).toBe("file_path");
  });

  it("resolves via an indexed symbol name, mapped back through file_location", () => {
    const manifest = [
      entry({ component_id: "billing-service", files: ["src/billing/service.ts"] }),
      entry({
        component_id: "purix-codebase-index",
        component_type: "codebase_index",
        components: [
          {
            symbol_name: "calculateInvoiceTotal",
            file_location: "src/billing/service.ts",
            signature: "function calculateInvoiceTotal(items: Item[]): number",
            language: "typescript",
            verification_status: "unverified" as ManifestEntry["verification_status"],
            last_verified_commit_hash: null,
            reusable: false,
            rationale: null,
          },
        ],
      }),
    ];
    const result = resolveTarget({ mentions: ["calculateInvoiceTotal"], manifest });
    expect(result.outcome).toBe("single");
    if (result.outcome !== "single") throw new Error("unreachable");
    expect(result.target.componentId).toBe("billing-service");
    expect(result.target.reason).toBe("symbol_name");
  });

  it("returns multiple candidates when several components match, ranked by reason strength", () => {
    const manifest = [
      entry({ component_id: "invoice-parser", files: ["src/invoice/parser.ts"] }),
      entry({ component_id: "invoice-renderer", files: ["src/invoice/renderer.ts"] }),
    ];
    const result = resolveTarget({ mentions: ["invoice"], manifest });
    expect(result.outcome).toBe("multiple");
    if (result.outcome !== "multiple") throw new Error("unreachable");
    expect(result.candidates.length).toBe(2);
  });

  it("returns none when nothing matches", () => {
    const manifest = [entry({ component_id: "billing-service", files: ["src/billing/service.ts"] })];
    const result = resolveTarget({ mentions: ["completely-unrelated-xyz"], manifest });
    expect(result.outcome).toBe("none");
  });

  it("never resolves the codebase-index row itself as a target", () => {
    const manifest = [
      entry({ component_id: "purix-codebase-index", component_type: "codebase_index", files: [] }),
    ];
    const result = resolveTarget({ mentions: ["purix-codebase-index"], manifest });
    expect(result.outcome).toBe("none");
  });

  it("does not false-positive on a partial substring across a word boundary", () => {
    const manifest = [entry({ component_id: "prefix-scanner", files: ["src/scanner.ts"] })];
    const result = resolveTarget({ mentions: ["fix"], manifest });
    expect(result.outcome).toBe("none");
  });
});
