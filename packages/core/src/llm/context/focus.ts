// src/llm/context/focus.ts
//
// Reduces a component's files to fit a token budget when (and only when) the full
// text is too big. Design follows the "narrow hierarchically" idea from Agentless
// (Xia et al., arXiv 2407.01489: files -> classes/functions -> edit locations, at
// ~$0.34-0.70 per issue) and Anthropic's "smallest set of high-signal tokens"
// guidance — applied deterministically, with no extra LLM call, because the
// instruction usually names what it touches.
//
// Safety property that makes windowing acceptable here: the classifier's edits are
// exact-substring anchors, and compilePatch() applies them against the REAL full
// file, failing loudly when an anchor is missing or ambiguous. A window can never
// cause a silent wrong edit; the worst case is an honest compile failure (which
// the existing heal/escalate path already handles).
import { estimateTokens } from "./tokens.js";

export interface SourceFile { path: string; content: string }

export interface FocusResult {
  filesBlock: string;
  mode: "full" | "focused";
  totalFiles: number;
  fullFiles: number;
  windowedFiles: number;
  omittedPaths: string[];
  estTokens: number;
}

/** Exactly what the legacy prompts have always built. */
export function legacyFilesBlock(files: SourceFile[]): string {
  return files.map((f) => `--- ${f.path} ---\n${f.content}`).join("\n\n");
}

const STOP = new Set(["the", "and", "for", "with", "that", "this", "from", "into", "add", "change", "make", "fix", "update", "use", "all", "not", "when", "should", "function", "file", "code", "please"]);

/** Identifier-ish terms from the instruction, plus camelCase/snake_case pieces. */
export function queryTerms(instruction: string): string[] {
  const out = new Set<string>();
  for (const raw of instruction.split(/[^A-Za-z0-9_./-]+/)) {
    const w = raw.trim();
    if (w.length < 3) continue;
    if (!STOP.has(w.toLowerCase())) out.add(w);
    for (const part of w.split(/[._/-]+|(?<=[a-z0-9])(?=[A-Z])/)) {
      if (part.length >= 3 && !STOP.has(part.toLowerCase())) out.add(part);
    }
  }
  return [...out];
}

function score(file: SourceFile, terms: string[]): number {
  const path = file.path.toLowerCase();
  const base = path.split("/").pop() ?? path;
  const body = file.content.toLowerCase();
  let s = 0;
  for (const t of terms) {
    const lt = t.toLowerCase();
    if (path.includes(lt)) s += lt === base || t.includes("/") ? 100 : 25;
    let idx = body.indexOf(lt);
    let hits = 0;
    while (idx !== -1 && hits < 20) { hits++; idx = body.indexOf(lt, idx + lt.length); }
    s += hits * 3;
  }
  return s;
}

const CONTEXT_LINES = 8;
const MIN_WINDOW_TOKENS = 300;

function windowFile(file: SourceFile, terms: string[], budgetTokens: number): { text: string; shown: number } | null {
  const lines = file.content.split("\n");
  const lowerTerms = terms.map((t) => t.toLowerCase());
  const keep = new Set<number>();
  lines.forEach((line, i) => {
    const l = line.toLowerCase();
    if (lowerTerms.some((t) => l.includes(t))) {
      for (let k = Math.max(0, i - CONTEXT_LINES); k <= Math.min(lines.length - 1, i + CONTEXT_LINES); k++) keep.add(k);
    }
  });
  // Nothing in this file matched: show its head so the model at least sees imports/shape.
  if (keep.size === 0) for (let k = 0; k < Math.min(lines.length, 40); k++) keep.add(k);

  const ordered = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  let used = 0;
  let shown = 0;
  let prev = -2;
  for (const i of ordered) {
    const cost = estimateTokens(lines[i]! + "\n") + (i !== prev + 1 ? 12 : 0);
    if (used + cost > budgetTokens) break;
    if (i !== prev + 1) parts.push(`… (lines ${prev + 2}-${i} omitted) …`);
    parts.push(lines[i]!);
    used += cost; shown++; prev = i;
  }
  if (shown === 0) return null;
  if (prev < lines.length - 1) parts.push(`… (lines ${prev + 2}-${lines.length} omitted) …`);
  return { text: `--- ${file.path} (partial view: ${shown} of ${lines.length} lines) ---\n${parts.join("\n")}`, shown };
}

export function focusFiles(files: SourceFile[], instruction: string, fullMaxTokens: number, focusedMaxTokens: number): FocusResult {
  const legacy = legacyFilesBlock(files);
  const total = estimateTokens(legacy);
  if (total <= fullMaxTokens) {
    return { filesBlock: legacy, mode: "full", totalFiles: files.length, fullFiles: files.length, windowedFiles: 0, omittedPaths: [], estTokens: total };
  }

  const terms = queryTerms(instruction);
  const ranked = files
    .map((f) => ({ f, s: score(f, terms) }))
    .sort((a, b) => b.s - a.s || a.f.path.localeCompare(b.f.path));

  const blocks: string[] = [];
  const omitted: string[] = [];
  let remaining = focusedMaxTokens;
  let full = 0;
  let windowed = 0;
  for (const { f } of ranked) {
    const whole = `--- ${f.path} ---\n${f.content}`;
    const cost = estimateTokens(whole) + 2;
    if (cost <= remaining) { blocks.push(whole); remaining -= cost; full++; continue; }
    if (remaining >= MIN_WINDOW_TOKENS) {
      const w = windowFile(f, terms, remaining - 30);
      if (w) { blocks.push(w.text); remaining -= estimateTokens(w.text); windowed++; continue; }
    }
    omitted.push(f.path);
  }
  // Blocks were assembled in relevance order; that is also the order the model sees.
  let filesBlock = blocks.join("\n\n");
  if (omitted.length > 0 || windowed > 0) {
    filesBlock +=
      `\n\n[Context budget notice: this component is larger than the context budget, so some content is not shown` +
      (omitted.length > 0 ? ` (files not shown: ${omitted.join(", ")})` : "") +
      `. Only propose edits whose anchor text appears verbatim above; if the change needs content that is not shown, ` +
      `say so in your reasoning and lower your confidence instead of guessing.]`;
  }
  return { filesBlock, mode: "focused", totalFiles: files.length, fullFiles: full, windowedFiles: windowed, omittedPaths: omitted, estTokens: estimateTokens(filesBlock) };
}
