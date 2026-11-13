// src/entrypoints/ingest.ts
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Provenance } from "../manifest/schema.js";
import { resolveSafePath } from "../gates/path_guard.js";

export interface IngestedFileChange {
  path: string;
  new_content: string;
  status: "added" | "modified" | "deleted";
}

export type IngestResult =
  | { ok: true; files: IngestedFileChange[]; provenance: Provenance }
  | { ok: false; reason: string };

interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[]; // each entry starts with ' ', '+', or '-'
  /** The diff says the new side of this hunk ends without a final newline ("\\ No newline at end of file" after a ' ' or '+' line). */
  noNewlineAtEndOfNew?: boolean;
  /** A3-2: the same for the old side (the marker after a ' ' or '-' line). With it and no new-side marker, the commit ADDED a final newline. */
  noNewlineAtEndOfOld?: boolean;
}

interface FileDiff {
  oldPath: string | null; // null when the old side is /dev/null (new file)
  newPath: string | null; // null when the new side is /dev/null (deleted file)
  hunks: DiffHunk[];
  /** Set on the last file of a diff whose last hunk has fewer lines than its header says: the text was cut off. */
  cutOff?: { hunkOldStart: number; expectedOld: number; expectedNew: number; sawOld: number; sawNew: number };
}

function stripGitPrefix(path: string): string {
  return path.replace(/^[ab]\//, "");
}

function normalizeHeaderPath(raw: string): string | null {
  // Header paths look like "a/src/foo.ts", "b/src/foo.ts", or "/dev/null".
  // Some diff producers append a trailing tab + timestamp — strip that too.
  const trimmed = raw.split("\t")[0]!.trim();
  if (trimmed === "/dev/null") return null;
  return stripGitPrefix(trimmed);
}

/**
 * Node 0 (§3.2). Parses a unified diff — the format `git diff`, GitHub's
 * PR patch endpoint, and every major coding agent all emit — into the
 * same shape compile.ts's own Executor produces. No external diff-parsing
 * package: the format is small and stable enough that hand-rolling it
 * means one fewer supply-chain dependency touching every ingested diff,
 * which is exactly the kind of surface §9.3 asks us to be paranoid about.
 *
 * Handles both git-style diffs (with the "diff --git a/x b/x" envelope)
 * and bare unified diffs (just "--- " / "+++ " / "@@ ... @@"), since not
 * every upstream agent wraps its output in the git envelope.
 */
function parseUnifiedDiff(diffText: string): FileDiff[] {
  const lines = diffText.split("\n");
  // A diff that ends in a newline splits into a last "" that is not a line of the diff.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldSeen = 0;
  let newSeen = 0;

  const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  // A header that miscounts in the middle of a diff is recounted from the lines that are really there. Only the LAST hunk of the
  // diff is held to its header, because a hunk with fewer lines than it says and nothing after it is what a cut-off looks like.
  const closeHunk = () => {
    if (currentHunk) {
      currentHunk.oldLines = oldSeen;
      currentHunk.newLines = newSeen;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("--- ")) {
      closeHunk();
      if (current) files.push(current);
      current = { oldPath: normalizeHeaderPath(line.slice(4)), newPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      closeHunk();
      if (!current) current = { oldPath: null, newPath: null, hunks: [] };
      current.newPath = normalizeHeaderPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    const hunkMatch = line.match(hunkHeaderRe);
    if (hunkMatch) {
      closeHunk();
      if (!current) { currentHunk = null; continue; } // malformed input — no file header yet, skip stray hunk
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      oldSeen = 0;
      newSeen = 0;
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      currentHunk.lines.push(line);
      if (line[0] !== "+") oldSeen++;
      if (line[0] !== "-") newSeen++;
      continue;
    }

    // A blank line inside a hunk that still expects lines is a blank CONTEXT line whose leading space was stripped (editors and chat
    // tools do this). It is read that way when a content line follows it, or when the blank lines are exactly what the header still
    // needs. Anywhere else a blank line is a separator and carries nothing.
    if (currentHunk && line === "") {
      let j = i;
      while (j < lines.length && lines[j] === "") j++;
      const run = j - i;
      const next = lines[j];
      const nextIsContent = next !== undefined && /^[ +-]/.test(next) && !next.startsWith("--- ") && !next.startsWith("+++ ");
      const needOld = currentHunk.oldLines - oldSeen;
      const needNew = currentHunk.newLines - newSeen;
      if (needOld > 0 && needNew > 0 && (nextIsContent || (needOld === run && needNew === run))) {
        currentHunk.lines.push(" ");
        oldSeen++;
        newSeen++;
      }
      continue;
    }

    // "\ No newline at end of file" says the line before it has no newline. After a ' ' or '+' line that is the new side, which an
    // added file needs to be written exactly as it is.
    if (currentHunk && line.startsWith("\\")) {
      const before = currentHunk.lines[currentHunk.lines.length - 1];
      if (before !== undefined && (before.startsWith("+") || before.startsWith(" "))) currentHunk.noNewlineAtEndOfNew = true;
      if (before !== undefined && (before.startsWith("-") || before.startsWith(" "))) currentHunk.noNewlineAtEndOfOld = true;
      continue;
    }

    // "diff --git", "index ...", blank separator lines between file
    // sections — none of these carry content we need; ignored rather
    // than treated as an error.
  }

  // The last hunk of the diff keeps its header counts: fewer lines than the header says means the diff was cut off.
  if (current && currentHunk) {
    const last: DiffHunk = currentHunk;
    if (oldSeen < last.oldLines || newSeen < last.newLines) {
      current.cutOff = { hunkOldStart: last.oldStart, expectedOld: last.oldLines, expectedNew: last.newLines, sawOld: oldSeen, sawNew: newSeen };
    } else {
      closeHunk();
    }
  }

  if (current) files.push(current);
  return files.filter((f) => f.hunks.length > 0 || f.oldPath === null || f.newPath === null);
}

type ApplyResult = { ok: true; lines: string[] } | { ok: false; reason: string };

/**
 * Applies hunks against the real original content and verifies every
 * context (' ') and removed ('-') line actually matches what's on disk
 * at that position. A mismatch means the diff was generated against a
 * different base than what's currently on disk (stale PR, concurrent
 * edit) — fails closed instead of silently applying a hunk against the
 * wrong base and corrupting the file.
 */
/** Fewest non-blank old-side lines a hunk needs before it may be moved away from the line its header gives. */
const MIN_SHIFT_ANCHOR_LINES = 3;

/**
 * Where a hunk's old side (its context and removed lines) sits in the file, when it is not at the line the header gives. It is
 * accepted only when it matches in exactly ONE place in the whole file, the way `git apply` treats context: there is no fixed
 * distance to tune, and a block that appears twice (near or far) is refused, because it could be either. A hunk with no old-side
 * lines (a bare insertion) is refused too: it has nothing to anchor on. The caller's file-hash re-check at write time is what
 * covers a file that changed after the diff was read.
 */
function locateHunk(originalLines: string[], oldSide: string[], _stated: number, notBefore: number): number | null {
  if (oldSide.length === 0) return null;
  const substantial = oldSide.filter((l) => l.trim() !== "").length;
  if (substantial === 0) return null; // blank lines match everywhere, so they anchor nothing
  const found: number[] = [];
  for (let pos = 0; pos + oldSide.length <= originalLines.length; pos++) {
    let fits = true;
    for (let i = 0; i < oldSide.length; i++) {
      if (originalLines[pos + i] !== oldSide[i]) { fits = false; break; }
    }
    if (fits) {
      found.push(pos);
      if (found.length > 1) return null;
    }
  }
  // A single match that sits inside an earlier hunk's lines is not usable (the hunks would overlap).
  if (found.length !== 1 || found[0]! < notBefore) return null;
  // A thin anchor (a lone `}` or a blank line) can be unique by luck. Below MIN_SHIFT_ANCHOR_LINES non-blank old-side lines the
  // hunk is moved only when it sits flush against the start or end of the file, the one place a diff legitimately carries less
  // context (git writes fewer than three context lines only there). Anywhere else the stated position has to be right.
  if (substantial < MIN_SHIFT_ANCHOR_LINES) {
    const atStart = found[0] === 0;
    // the split of a file that ends in a newline carries one empty last element that is not a line of the file
    const realLength = originalLines.length > 0 && originalLines[originalLines.length - 1] === "" ? originalLines.length - 1 : originalLines.length;
    const atEnd = found[0]! + oldSide.length === realLength;
    if (!atStart && !atEnd) return null;
  }
  return found[0]!;
}

function applyHunks(originalLines: string[], hunks: DiffHunk[]): ApplyResult {
  const result: string[] = [];
  let origIdx = 0;
  let carried = 0; // how far the previous hunks turned out to be from where their headers said

  for (const hunk of hunks) {
    let hunkStart = (hunk.oldStart > 0 ? hunk.oldStart - 1 : 0) + carried;
    const oldSide = hunk.lines.filter((l) => l[0] === " " || l[0] === "-").map((l) => l.slice(1));
    const exact = oldSide.every((t, i) => originalLines[hunkStart + i] === t);
    if (!exact) {
      const found = locateHunk(originalLines, oldSide, hunkStart, origIdx);
      if (found !== null) {
        carried += found - hunkStart;
        hunkStart = found;
      }
    }
    if (hunkStart < origIdx) {
      return { ok: false, reason: `hunk at old-line ${hunk.oldStart} overlaps a previous hunk — malformed or out-of-order diff` };
    }
    while (origIdx < hunkStart) {
      result.push(originalLines[origIdx]!);
      origIdx++;
    }

    for (const line of hunk.lines) {
      const marker = line[0];
      const text = line.slice(1);
      if (marker === " " || marker === "-") {
        if (origIdx >= originalLines.length || originalLines[origIdx] !== text) {
          return {
            ok: false,
            reason: `context/removed line ${origIdx + 1} doesn't match the file on disk ("${originalLines[origIdx] ?? "<end of file>"}" vs expected "${text}") — diff doesn't apply cleanly against the current base`,
          };
        }
        origIdx++;
        if (marker === " ") result.push(text);
      } else if (marker === "+") {
        result.push(text);
      }
    }
  }

  while (origIdx < originalLines.length) {
    result.push(originalLines[origIdx]!);
    origIdx++;
  }

  return { ok: true, lines: result };
}

/**
 * Reads whatever original files the diff touches straight off disk
 * (targetDir), applies the diff against them, and returns the resulting
 * full file contents in the same { path, new_content } shape compile.ts
 * emits from the Instruction Path — so everything downstream (State
 * Resolver, Verifier, TrustGate) stays genuinely author-agnostic
 * (Principle 12) and never needs a special case for "this came from a
 * diff instead of a classifier."
 *
 * source_agent should be the actual upstream tool if known ("cursor",
 * "claude-code", "devin", "human") — pass null if the ingestion source
 * (a bare webhook payload, a manually pasted patch) doesn't say.
 */
export async function ingestDiff(
  diffText: string,
  sourceAgent: string | null,
  targetDir: string = process.cwd()
): Promise<IngestResult> {
  const parsed = parseUnifiedDiff(diffText);
  if (parsed.length === 0) {
    return {
      ok: false,
      reason: `no recognizable unified-diff file section found — expected "--- a/..." / "+++ b/..." headers followed by "@@ ... @@" hunks`,
    };
  }

  const files: IngestedFileChange[] = [];

  for (const fileDiff of parsed) {
    if (fileDiff.cutOff) {
      const c = fileDiff.cutOff;
      return {
        ok: false,
        reason:
          `the diff ends in the middle of a hunk (the hunk at old-line ${c.hunkOldStart} of "${fileDiff.newPath ?? fileDiff.oldPath}" says ${c.expectedOld} old and ${c.expectedNew} new lines, ` +
          `the text has ${c.sawOld} and ${c.sawNew}): it looks cut off, so nothing was applied. Send the whole diff again.`,
      };
    }
    const isNewFile = fileDiff.oldPath === null;
    const isDeleted = fileDiff.newPath === null;
    const relPath = fileDiff.newPath ?? fileDiff.oldPath;
    if (!relPath) {
      return { ok: false, reason: `a diff section has both sides as /dev/null — can't determine the target path` };
    }

    // Path-traversal guard. A diff header is untrusted input (it can
    // come from an external PR, a webhook payload, or an upstream
    // agent) — "--- a/../../../../etc/cron.d/x" is syntactically a
    // valid unified-diff header. Reject before this path is ever used
    // to read the "existing" original off disk or to compute a write
    // target below.
    const pathCheck = resolveSafePath(targetDir, relPath);
    if (!pathCheck.ok) {
      return { ok: false, reason: `diff touches "${relPath}": ${pathCheck.reason}` };
    }

    if (isDeleted) {
      // BUG FIX (GAPS-REPORT-2 §5): every other diff section
      // (added/modified) reads the real file off disk and runs it
      // through applyHunks(), which verifies every context/removed line
      // actually matches what's there before accepting the change — the
      // same stale-base protection that keeps a diff generated against
      // an old commit from silently corrupting a file that's since
      // moved on. Deletion sections skipped all of that: a diff
      // section claiming "delete src/x.ts" was accepted unconditionally,
      // with no check that the file even exists, let alone that its
      // content matches what the diff was generated against. A stale
      // PR, a diff replayed out of order, or a malicious payload could
      // delete a file that had since been rewritten with unrelated,
      // uncommitted content the diff never saw.
      let originalContent: string;
      try {
        originalContent = await readFile(join(targetDir, relPath), "utf-8");
      } catch {
        return {
          ok: false,
          reason: `diff deletes "${relPath}", but it isn't on disk at ${join(targetDir, relPath)} — refusing to accept a deletion for a file that doesn't exist`,
        };
      }
      const applied = applyHunks(originalContent.split("\n"), fileDiff.hunks);
      if (!applied.ok) {
        return { ok: false, reason: `${relPath}: ${applied.reason}` };
      }
      files.push({ path: relPath, new_content: "", status: "deleted" });
      continue;
    }

    let originalLines: string[] = [];
    if (!isNewFile) {
      let originalContent: string;
      try {
        originalContent = await readFile(join(targetDir, relPath), "utf-8");
      } catch {
        return {
          ok: false,
          reason: `diff treats "${relPath}" as an existing file, but it isn't on disk at ${join(targetDir, relPath)} — refusing to guess a base to apply against`,
        };
      }
      originalLines = originalContent.split("\n");
    }

    const applied = applyHunks(originalLines, fileDiff.hunks);
    if (!applied.ok) {
      return { ok: false, reason: `${relPath}: ${applied.reason}` };
    }

    let newContent = applied.lines.join("\n");
    if (!isNewFile) {
      // A3-2: a modified file keeps the ending the original had, unless the diff's markers say the commit changed it. The new side
      // lacking a final newline wins; otherwise an old side that lacked one and a new side that does means one was added.
      const newLacksNewline = fileDiff.hunks.some((h) => h.noNewlineAtEndOfNew);
      const oldLackedNewline = fileDiff.hunks.some((h) => h.noNewlineAtEndOfOld);
      if (newLacksNewline) newContent = newContent.replace(/\n$/, "");
      else if (oldLackedNewline && !newContent.endsWith("\n")) newContent += "\n";
    }
    if (isNewFile) {
      // A new file has no original to carry its last newline: the lines are joined with "\n", so the one after the last line
      // has to be put back, unless the diff says the file ends without one (60 of 64 added files lost it, research 04).
      const noFinalNewline = fileDiff.hunks.some((h) => h.noNewlineAtEndOfNew);
      if (applied.lines.length > 0 && !noFinalNewline) newContent += "\n";
    }
    files.push({
      path: relPath,
      new_content: newContent,
      status: isNewFile ? "added" : "modified",
    });
  }

  return {
    ok: true,
    files,
    provenance: { source_type: "external_diff", source_agent: sourceAgent },
  };
}

/** Convenience wrapper for the CLI/webhook layer — reads the diff from a file path (e.g. a saved PR patch) instead of an in-memory string. */
export async function ingestDiffFromFile(
  diffFilePath: string,
  sourceAgent: string | null,
  targetDir: string = process.cwd()
): Promise<IngestResult> {
  let diffText: string;
  try {
    diffText = await readFile(diffFilePath, "utf-8");
  } catch (err) {
    return { ok: false, reason: `couldn't read diff file "${diffFilePath}": ${err instanceof Error ? err.message : String(err)}` };
  }
  return ingestDiff(diffText, sourceAgent, targetDir);
}