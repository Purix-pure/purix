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
}

interface FileDiff {
  oldPath: string | null; // null when the old side is /dev/null (new file)
  newPath: string | null; // null when the new side is /dev/null (deleted file)
  hunks: DiffHunk[];
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
  const files: FileDiff[] = [];
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;

  const hunkHeaderRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

  for (const line of lines) {
    if (line.startsWith("--- ")) {
      if (current) files.push(current);
      current = { oldPath: normalizeHeaderPath(line.slice(4)), newPath: null, hunks: [] };
      currentHunk = null;
      continue;
    }

    if (line.startsWith("+++ ")) {
      if (!current) current = { oldPath: null, newPath: null, hunks: [] };
      current.newPath = normalizeHeaderPath(line.slice(4));
      currentHunk = null;
      continue;
    }

    const hunkMatch = line.match(hunkHeaderRe);
    if (hunkMatch) {
      if (!current) continue; // malformed input — no file header yet, skip stray hunk
      currentHunk = {
        oldStart: Number(hunkMatch[1]),
        oldLines: hunkMatch[2] !== undefined ? Number(hunkMatch[2]) : 1,
        newStart: Number(hunkMatch[3]),
        newLines: hunkMatch[4] !== undefined ? Number(hunkMatch[4]) : 1,
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (currentHunk && (line.startsWith(" ") || line.startsWith("+") || line.startsWith("-"))) {
      currentHunk.lines.push(line);
      continue;
    }

    // "diff --git", "index ...", "\ No newline at end of file", blank
    // separator lines between file sections — none of these carry
    // content we need; ignored rather than treated as an error.
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
function applyHunks(originalLines: string[], hunks: DiffHunk[]): ApplyResult {
  const result: string[] = [];
  let origIdx = 0;

  for (const hunk of hunks) {
    const hunkStart = hunk.oldStart > 0 ? hunk.oldStart - 1 : 0;
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

    files.push({
      path: relPath,
      new_content: applied.lines.join("\n"),
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
    return { ok: false, reason: `couldn't read diff file "${diffFilePath}": ${err instanceof Error ? err.message : err}` };
  }
  return ingestDiff(diffText, sourceAgent, targetDir);
}