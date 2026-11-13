// F04-04: `purix status` shows a row's latest pass followed an edit that kept the rest of a line, the same way it shows a not-tested gap.
import { describe, it, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import { recordEvent } from "@purix/core/manifest/events";
import { computeSyncHash } from "@purix/core/state/hash";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) safeRmSync(d); });

function project(partial: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "purix-status-partial-"));
  dirs.push(dir);
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeManifest({
      component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5,
      parts: { tools: [], config: {} }, files: ["a.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: "export const a = 1;\n" }]),
    } as never);
    if (partial) recordEvent("anchor_match", { component_id: "comp-a", detail: { outcome: "partial_line", paths: ["a.ts"] } });
    recordEvent("verification_pass", { component_id: "comp-a", operation: "modify", detail: { isolation: "none" } });
  } finally { closeDb(); process.chdir(cwd); }
  return dir;
}

function status(cwd: string): string {
  const home = join(cwd, "home");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), "status"], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home, PURIX_USER_DIR: join(home, ".purix") }, encoding: "utf8", timeout: 30_000,
  });
  return `${r.stdout ?? ""}${r.stderr ?? ""}`;
}

describe("purix status and partial-line edits", () => {
  it("marks the row when the latest pass followed a partial-line edit", () => {
    expect(status(project(true))).toContain("edited inside a line: 1 file(s), rest of that line kept");
  });
  it("shows nothing extra otherwise", () => {
    const out = status(project(false));
    expect(out).toContain("comp-a");
    expect(out).not.toContain("edited inside a line");
  });
});
