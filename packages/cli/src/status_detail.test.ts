// Register item 8 (CLI-01, CLI-02): `purix status --detail full` and `purix status --json` exist, and print what the MCP tool
// purix_status prints for detail "full". Before this, both were "error: unknown option".
import { describe, it, afterEach } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { closeDb, writeManifest, listManifest } from "@purix/core/manifest/store";
import { computeSyncHash } from "@purix/core/state/hash";
import { createToolCaller } from "@purix/mcp-server";

const tsxLoader = createRequire(import.meta.url).resolve("tsx");
const dirs: string[] = [];
afterEach(() => { closeDb(); for (const d of dirs.splice(0)) safeRmSync(d); });

function project(withState: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "purix-status-detail-"));
  dirs.push(dir);
  if (!withState) return dir;
  const cwd = process.cwd();
  process.chdir(dir);
  try {
    writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
    writeManifest({
      component_id: "comp-a", component_type: "module", current_version: 1, schema_version: 5,
      parts: { tools: [], config: {} }, files: ["a.ts"], depends_on: [], depended_on_by: [], version_history: [],
      verification_status: "pass", last_synced_hash: computeSyncHash([{ path: "a.ts", content: "export const a = 1;\n" }]),
    } as never);
  } finally { closeDb(); process.chdir(cwd); }
  return dir;
}

function status(cwd: string, ...args: string[]): { out: string; err: string; code: number | null } {
  const home = join(cwd, "home");
  const r = spawnSync(process.execPath, ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), "status", ...args], {
    cwd, env: { ...process.env, HOME: home, USERPROFILE: home, PURIX_USER_DIR: join(home, ".purix") }, encoding: "utf8", timeout: 30_000,
  });
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status };
}

describe("purix status --detail and --json", () => {
  it("--detail full prints every manifest entry as JSON, exit 0", () => {
    const dir = project(true);
    const r = status(dir, "--detail", "full");
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.out) as { component_id: string }[];
    expect(parsed.map((e) => e.component_id)).toEqual(["comp-a"]);
  });

  it("--json prints exactly what --detail full prints", () => {
    const dir = project(true);
    expect(status(dir, "--json").out).toBe(status(dir, "--detail", "full").out);
  });

  it("prints what the MCP tool purix_status prints for detail full", async () => {
    const dir = project(true);
    const cwd = process.cwd();
    process.chdir(dir);
    let mcpText: string;
    try {
      mcpText = (await createToolCaller()("purix_status", { detail: "full" })).content[0]!.text;
      expect(JSON.parse(mcpText)).toEqual(listManifest());
    } finally { closeDb(); process.chdir(cwd); }
    expect(JSON.parse(status(dir, "--detail", "full").out)).toEqual(JSON.parse(mcpText));
  });

  it("with no state yet, full is an empty JSON list, as on MCP", () => {
    const r = status(project(false), "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual([]);
  });

  it("the default and --detail concise are the one-line list, unchanged", () => {
    const dir = project(true);
    const plain = status(dir).out;
    expect(plain).toContain("comp-a");
    expect(plain.trimStart().startsWith("[")).toBe(false);
    expect(status(dir, "--detail", "concise").out).toBe(plain);
  });

  it("refuses an unknown level and a --json that contradicts --detail concise, naming the fix, exit 2 (invalid usage)", () => {
    const dir = project(true);
    const bad = status(dir, "--detail", "everything");
    expect(bad.code).toBe(2);
    expect(bad.err).toContain("concise");
    expect(bad.err).toContain("full");
    const clash = status(dir, "--json", "--detail", "concise");
    expect(clash.code).toBe(2);
    expect(clash.err).toContain("--detail full");
  });
});
