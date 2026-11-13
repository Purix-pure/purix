// src/hooks/decide_unadopted.test.ts
//
// C5 (plan v4, F00-07, decision 3 of 2026-11-08): the door guards governed files only. A write to a file Purix has not adopted is
// allowed (blocking it would stop all ordinary work), but it is named: in the hook's answer, as a recorded event, and in `purix check`.
// decideHook is pure, so it only reports which targets were unadopted; run.ts records and answers.
// What these are: the real decideHook, and the real hook + store + check in a temp project. Not a run inside any agent.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decideHook, type GovernedContext } from "./decide";
import { classifyTool, type NormalizedCall } from "./protocol";
import { runHook } from "./run";
import { runCheck } from "../entrypoints/check";
import { writeManifest, closeDb } from "../manifest/store";
import { listEvents } from "../manifest/events";
import { computeSyncHash } from "../state/hash";
import { safeRmSync } from "../platform/fs_retry";
import type { ManifestEntry } from "../manifest/schema";

const root0 = realpathSync(mkdtempSync(join(tmpdir(), "purix-unad-")));
process.on("exit", () => safeRmSync(root0));
const ctx: GovernedContext = {
  projectRoot: root0,
  governed: new Map([["src/auth.ts", "auth"]]),
  protectedFiles: new Set([".mcp.json"]),
  protectedAbsolute: [join(root0, ".purix")],
  state: "ok", lockUsed: false, caseInsensitive: false,
};
function write(paths: string[], c: GovernedContext = ctx) {
  const call: NormalizedCall = { agent: "claude-code", event: "pre-tool-use", tool: "Write", toolClass: classifyTool("Write"), cwd: root0, roots: [], paths, command: null, stopHookActive: false };
  return decideHook(call, c, root0);
}

describe("decideHook names unadopted targets on an allow", () => {
  test("a new file in the project is allowed and named", () => {
    const d = write(["src/new.ts"]);
    expect(d.action).toBe("allow");
    expect(d.unadopted).toEqual(["src/new.ts"]);
  });
  test("a governed file is still denied (unchanged), even with an unadopted file beside it", () => {
    expect(write(["src/auth.ts"]).action).toBe("deny");
    const d = write(["src/new.ts", "src/auth.ts"]);
    expect(d.action).toBe("deny");
    expect(d.unadopted).toBeUndefined();
  });
  test("dependency and build folders are not named (noise, not work)", () => {
    for (const p of ["node_modules/x/index.js", "dist/a.js", "packages/web/build/b.js", ".git/info/exclude", "coverage/lcov.info"]) {
      const d = write([p]);
      expect(d.action).toBe("allow");
      expect(d.unadopted).toBeUndefined();
    }
  });
  test("a file outside the project is allowed and not named (it is not this project's file)", () => {
    const d = write([join(tmpdir(), "elsewhere-purix-unad.txt")]);
    expect(d.action).toBe("allow");
    expect(d.unadopted).toBeUndefined();
  });
  test("a project with nothing governed names nothing", () => {
    const d = write(["src/new.ts"], { ...ctx, governed: new Map(), state: "absent" });
    expect(d.action).toBe("allow");
    expect(d.unadopted).toBeUndefined();
  });
  test("LIMIT: a shell command that writes a file is not named (the text screen cannot tell what it writes)", () => {
    const call: NormalizedCall = { agent: "claude-code", event: "pre-tool-use", tool: "Bash", toolClass: "shell", cwd: root0, roots: [], paths: [], command: "echo hi > src/new.ts", stopHookActive: false };
    expect(decideHook(call, ctx, root0).unadopted).toBeUndefined();
  });
});

function entry(id: string, files: string[], type = "module"): ManifestEntry {
  return {
    component_id: id, component_type: type, current_version: 1, schema_version: 4,
    parts: { tools: [], config: {} }, files, depends_on: [], depended_on_by: [], version_history: [],
    verification_status: "pass", last_synced_hash: "h",
  } as unknown as ManifestEntry;
}

describe("hook + store + purix check, end to end", () => {
  let root: string;
  let prevCwd: string;
  beforeEach(() => {
    prevCwd = process.cwd();
    root = realpathSync(mkdtempSync(join(tmpdir(), "purix-unad-run-")));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
    process.chdir(root);
    const alpha = entry("alpha", ["src/a.ts"]);
    alpha.last_synced_hash = computeSyncHash([{ path: "src/a.ts", content: "export const a = 1;\n" }]);
    writeManifest(alpha);
    closeDb();
  });
  afterEach(() => { closeDb(); process.chdir(prevCwd); safeRmSync(root); });
  const payload = (file: string) => JSON.stringify({ tool_name: "Write", tool_input: { file_path: join(root, file), content: "x" }, cwd: root });

  test("the write is allowed, the answer names the file, and an event is recorded", () => {
    const a = runHook("claude-code", "pre-tool-use", payload("src/new.ts"));
    expect(a.exitCode).toBe(0);
    expect(a.stdout).toBe("");
    expect(a.stderr).toContain("src/new.ts");
    expect(a.stderr).toMatch(/not governed by Purix/);
    const ev = listEvents({ kind: "unadopted_write" });
    expect(ev.length).toBe(1);
    expect(ev[0]!.detail?.files).toEqual(["src/new.ts"]);
  });

  test("purix check lists the file as not verified, and strict mode treats that as a problem", () => {
    runHook("claude-code", "pre-tool-use", payload("src/new.ts"));
    writeFileSync(join(root, "src", "new.ts"), "x"); // the agent's write, once the hook allowed it
    const loose = runCheck({ baseDir: root });
    const item = loose.sections.find((s) => s.id === "drift")!.items.find((i) => i.subject === "src/new.ts");
    expect(item?.outcome).toBe("skipped");
    expect(item?.message).toMatch(/written by an agent.*not governed/i);
    expect(loose.exitCode).toBe(0);
    expect(runCheck({ baseDir: root, strict: true }).exitCode).toBe(1);
  });

  test("once the file is governed, check stops naming it", () => {
    runHook("claude-code", "pre-tool-use", payload("src/new.ts"));
    writeFileSync(join(root, "src", "new.ts"), "export const n = 1;\n");
    const n = entry("newc", ["src/new.ts"]);
    n.last_synced_hash = computeSyncHash([{ path: "src/new.ts", content: "export const n = 1;\n" }]);
    writeManifest(n);
    closeDb();
    const item = runCheck({ baseDir: root }).sections.find((s) => s.id === "drift")!.items.find((i) => i.subject === "src/new.ts");
    expect(item).toBeUndefined();
  });

  test("a write to a governed file is still blocked and records no unadopted event", () => {
    const a = runHook("claude-code", "pre-tool-use", payload("src/a.ts"));
    expect(a.exitCode).toBe(2);
    expect(listEvents({ kind: "unadopted_write" }).length).toBe(0);
  });
});
