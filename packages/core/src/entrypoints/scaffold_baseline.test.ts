// TEST-REPORT F3: a fresh component must start with a drift baseline (null meant "never drifted").
import { describe, it } from "node:test";
import { expect } from "expect";
import { buildManifestEntry } from "./scaffold";
import { computeSyncHash } from "../state/hash";

describe("buildManifestEntry — drift baseline", () => {
  it("records the hash of the starter content it will write", () => {
    const plan = {
      component_id: "greeter",
      component_type: "utility",
      depends_on: [],
      files: [
        { path: "src/greeter.ts", purpose: "fn", starter_content: "export const a = 1;\n" },
        { path: "src/greeter.test.ts", purpose: "tests", starter_content: "// t\n" },
      ],
    };
    const entry = buildManifestEntry(plan);
    expect(entry.last_synced_hash).not.toBeNull();
    expect(entry.last_synced_hash).toBe(computeSyncHash(plan.files.map((f) => ({ path: f.path, content: f.starter_content }))));
  });
});
