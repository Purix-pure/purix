// A3-2: rebuild of the E2 replay (research 04). For real commits of real repositories, apply each file's diff with ingestDiff to the
// parent's version and compare with the file in the commit. Also shifts every hunk header by 1, 3, 10, 60 and 300 lines. Needs git clones,
// so it is a script, not a unit test:   node --import tsx scripts/replay-ingest-corpus.mts <repoDir> [maxCommits]
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ingestDiff } from "../packages/core/src/entrypoints/ingest.ts";

const repo = process.argv[2]!;
const max = Number(process.argv[3] ?? 100);
const git = (...a: string[]): Buffer => execFileSync("git", ["-C", repo, ...a], { maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] });
const shiftHeaders = (d: string, s: number): string =>
  d.replace(/^@@ -(\d+)(,\d+)? \+(\d+)(,\d+)? @@/gm, (_m, a, b, c, e) => `@@ -${Number(a) + s}${b ?? ""} +${Number(c) + s}${e ?? ""} @@`);

const commits = git("rev-list", "--no-merges", "-n", String(max), "HEAD").toString().trim().split("\n").filter(Boolean);
const tally: Record<string, { tried: number; same: number; refused: number; wrong: number }> = {};
const bump = (k: string, f: "tried" | "same" | "refused" | "wrong") => ((tally[k] ??= { tried: 0, same: 0, refused: 0, wrong: 0 })[f]++);
const wrongs: string[] = [];

for (const c of commits) {
  let parents: string;
  try { parents = git("rev-list", "--parents", "-n", "1", c).toString().trim(); } catch { continue; }
  const parent = parents.split(" ")[1];
  if (!parent) continue;
  let files: string[];
  try { files = git("diff", "--name-status", "--no-renames", parent, c).toString().trim().split("\n").filter(Boolean); } catch { continue; }
  for (const row of files) {
    const [st, path] = row.split("\t");
    if (!path || (st !== "M" && st !== "A")) continue;
    let after: Buffer, before: Buffer | null = null;
    try { after = git("show", `${c}:${path}`); if (st === "M") before = git("show", `${parent}:${path}`); } catch { continue; }
    if (after.includes(0) || (before && before.includes(0))) continue; // binary
    let diff: string;
    try { diff = git("diff", "--no-renames", "--no-color", "-U3", parent, c, "--", path).toString("utf-8"); } catch { continue; }
    if (!diff.includes("@@")) continue; // empty added file has no hunk
    const kind = st === "A" ? "added" : "modified";
    for (const shift of st === "A" ? [0] : [0, 1, 3, 10, 60, 300]) {
      const key = `${kind} shift ${shift}`;
      const dir = mkdtempSync(join(tmpdir(), "replay-"));
      try {
        if (before) { mkdirSync(dirname(join(dir, path)), { recursive: true }); writeFileSync(join(dir, path), before); }
        if (shift > 0) {
          // The file really is `shift` lines longer at the top, as if an agent had edited it since the diff was made.
          const pad = Array.from({ length: shift }, (_, i) => `// pad ${i}`).join("\n") + "\n";
          writeFileSync(join(dir, path), Buffer.concat([Buffer.from(pad), before!]));
        }
        bump(key, "tried");
        const r = await ingestDiff(diff, null, dir);
        if (!r.ok) { bump(key, "refused"); if (wrongs.length < 5 && shift === 1) wrongs.push(`REFUSED ${c.slice(0, 8)} ${path}: ${r.reason.slice(0, 140)}`); continue; }
        const got = r.files[0]!.new_content;
        const want = shift > 0 ? "// pad " + Array.from({ length: shift }, (_, i) => i).join("\n// pad ").replace(/\n\/\/ pad (\d+)/g, "\n// pad $1") + "\n" + after.toString("utf-8") : after.toString("utf-8");
        if (got === (shift > 0 ? want : after.toString("utf-8"))) bump(key, "same"); else { bump(key, "wrong"); if (wrongs.length < 5) wrongs.push(`${c.slice(0, 8)} ${path} shift ${shift}`); }
      } finally { rmSync(dir, { recursive: true, force: true }); }
    }
  }
}
console.log(JSON.stringify({ repo, commits: commits.length, tally, wrongs }, null, 1));
