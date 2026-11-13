// src/manifest/indexer_file_list.test.ts
//
// F05-06 / research 05 section 2.1: which files `purix index` looks at. The old walk skipped any folder named `build` or `dist`
// (wrong when it is real source) and read `.gitignore` as literal prefixes, so a glob, an anchored pattern, a nested ignore file
// or a negation did nothing. Research 05 (experiment E3: 3 of 5 cases wrong) recommends Git's own list inside a repository
// (`git ls-files --cached --others --exclude-standard`), and today's walk with its name list outside one. The indexed set must
// equal what Git lists, for supported extensions. The result names which source was used, so a person can tell.
//
// Written first; the git-repository tests failed against the old walk. Needs `git` on PATH (the repo's own CI has it).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawnSync } from "node:child_process";
import { runIndex } from "./indexer";
import { closeDb } from "./store";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmp: string;
let savedPath: string | undefined;

function put(rel: string, body = "export const x = 1;\n") {
  const p = join(tmp, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, body);
}
function git(...args: string[]) {
  const r = spawnSync("git", args, { cwd: tmp, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout;
}
const indexedFiles = (r: Awaited<ReturnType<typeof runIndex>>) => [...new Set(r.components.map((c) => c.file_location))].sort();

beforeEach(() => {
  originalCwd = process.cwd();
  savedPath = process.env.PATH;
  tmp = mkdtempSync(join(tmpdir(), "purix-index-list-"));
  process.chdir(tmp);
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath;
  safeRmSync(tmp);
});

describe("purix index: the file set inside a git repository equals what git lists", () => {
  it("indexes real source folders named build and dist", async () => {
    git("init", "-q");
    put("src/build/tool.ts"); put("src/dist/emit.ts"); put("src/app.ts");
    git("add", ".");
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["src/app.ts", "src/build/tool.ts", "src/dist/emit.ts"]);
    expect(r.fileListSource).toBe("git");
  });

  it("honours globs, anchored patterns, directory patterns, ** with a negation, and a nested ignore file", async () => {
    git("init", "-q");
    writeFileSync(join(tmp, ".gitignore"), "*.generated.ts\ngen/\n/rootonly.ts\ndocs/**\n!docs/keep.ts\n");
    put("pkg/.gitignore", "sub/\n");
    put("src/gen.generated.ts"); put("gen/top.ts"); put("src/gen/out.ts");
    put("rootonly.ts"); put("src/rootonly.ts");
    put("docs/x.ts"); put("docs/keep.ts");
    put("pkg/sub/deep.ts"); put("pkg/ok.ts");
    put("debug.log.ts"); put("src/real.ts");
    git("add", "-A");
    const r = await runIndex(tmp);
    const expected = git("ls-files", "--cached", "--others", "--exclude-standard").split("\n").filter((f) => f.endsWith(".ts")).sort();
    expect(indexedFiles(r)).toEqual(expected);
    // spot checks on the cases the old walk got wrong
    for (const gone of ["src/gen.generated.ts", "gen/top.ts", "src/gen/out.ts", "rootonly.ts", "docs/x.ts", "pkg/sub/deep.ts"]) expect(indexedFiles(r)).not.toContain(gone);
    for (const kept of ["src/rootonly.ts", "docs/keep.ts", "pkg/ok.ts", "debug.log.ts"]) expect(indexedFiles(r)).toContain(kept);
  });

  it("includes an untracked file that is not ignored, and leaves out a tracked file that was deleted from disk", async () => {
    git("init", "-q");
    put("tracked.ts"); put("gone.ts");
    git("add", ".");
    rmSync(join(tmp, "gone.ts"));
    put("untracked.ts");
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["tracked.ts", "untracked.ts"]);
  });

  it("still never indexes node_modules, .git or .purix, even when git would list them", async () => {
    git("init", "-q");
    put("a.ts"); put("node_modules/dep/index.ts"); put(".purix/state.ts");
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["a.ts"]);
  });

  it("keeps .purixignore working, as literal path prefixes", async () => {
    git("init", "-q");
    writeFileSync(join(tmp, ".purixignore"), "legacy\n");
    put("legacy/old.ts"); put("src/new.ts");
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["src/new.ts"]);
  });

  it("lists non-ASCII paths exactly (git is asked for NUL-separated names, so nothing is quoted)", async () => {
    git("init", "-q");
    put("src/ü/日本.ts"); put("src/plain.ts");
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["src/plain.ts", "src/ü/日本.ts"]);
  });

  it("skips a symlink to a file, as the walk always did", async () => {
    git("init", "-q");
    put("real.ts");
    symlinkSync(join(tmp, "real.ts"), join(tmp, "link.ts"));
    const r = await runIndex(tmp);
    expect(indexedFiles(r)).toEqual(["real.ts"]);
  });

  it("run from a subfolder of the repository, lists only that folder with paths relative to it", async () => {
    git("init", "-q");
    put("top.ts"); put("sub/inner.ts"); put("sub/deeper/x.ts");
    // The CLI indexes the folder it is run from, so the folder and the working directory are the same (F05-07 is about where the
    // store and the recorded paths land when that folder is not the project root; not changed here).
    process.chdir(join(tmp, "sub"));
    const r = await runIndex(join(tmp, "sub"));
    expect(indexedFiles(r)).toEqual(["deeper/x.ts", "inner.ts"]);
    expect(r.fileListSource).toBe("git");
  });
});

describe("purix index: outside a git repository, or when git cannot run, it uses the folder walk and says so", () => {
  it("walks the folder (its name list still skips build, dist and node_modules) and reports fileListSource: walk", async () => {
    put("src/app.ts"); put("src/build/tool.ts"); put("node_modules/d/i.ts");
    const r = await runIndex(tmp);
    expect(r.fileListSource).toBe("walk");
    expect(indexedFiles(r)).toEqual(["src/app.ts"]);
  });

  it("falls back to the walk when git is not installed, instead of failing", async () => {
    git("init", "-q");
    put("src/app.ts");
    const empty = mkdtempSync(join(tmpdir(), "purix-nopath-"));
    process.env.PATH = empty;
    try {
      const r = await runIndex(tmp);
      expect(r.fileListSource).toBe("walk");
      expect(indexedFiles(r)).toEqual(["src/app.ts"]);
    } finally {
      process.env.PATH = savedPath;
      safeRmSync(empty);
    }
  });
});
