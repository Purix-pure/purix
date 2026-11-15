// P7: the shared briefing, read from a real store in a temp folder. No model is involved anywhere in it.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildBriefing, briefingSimilar, briefingComponentIds, briefingConventions } from "./briefing.js";
import { recordCreateMemory } from "./create_plan.js";
import { closeDb, writeManifest } from "../manifest/store.js";
import { rememberNote } from "../manifest/memory.js";
import type { ManifestEntry } from "../manifest/schema.js";
import { safeRmSync } from "../platform/fs_retry.js";

let tmpDir: string, userDir: string, oldCwd: string;
const comp = (id: string, o: Partial<ManifestEntry> = {}): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files: [`${id}.ts`], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null, ...o,
});

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "purix-briefing-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-briefing-user-"));
  process.env.PURIX_USER_DIR = userDir;
  oldCwd = process.cwd();
  process.chdir(tmpDir);
});
afterEach(() => {
  process.chdir(oldCwd);
  closeDb();
  safeRmSync(tmpDir);
  safeRmSync(userDir);
});

describe("briefing", () => {
  test("an empty project gives an empty briefing and touches nothing on disk", () => {
    expect(buildBriefing("add a payments page")).toEqual({ conventions: [], knownComponentIds: [], similar: [] });
  });

  test("shows conventions, existing ids and what the request resembles", () => {
    writeManifest(comp("payment-gateway"));
    writeManifest(comp("team-board"));
    rememberNote({ note: "all money amounts are integer cents", source: "person" });
    const b = buildBriefing("payments should support refunds");
    expect(b.knownComponentIds).toEqual(["payment-gateway", "team-board"]);
    expect(b.conventions.join("\n")).toContain("integer cents");
    expect(b.similar.map((s) => s.componentId)).toEqual(["payment-gateway"]);
  });

  test("the purpose line a create records makes the component findable by what it is for", () => {
    const e = comp("mailer-x", { files: ["mailer-x.ts"] });
    writeManifest(e);
    recordCreateMemory(e, "sends welcome emails after signup");
    expect(briefingSimilar("send a welcome email to new users").map((s) => s.componentId)).toEqual(["mailer-x"]);
    expect(briefingConventions()).toEqual([]); // a component's own note is not a repo-wide convention
    expect(briefingComponentIds()).toEqual(["mailer-x"]);
  });
});
