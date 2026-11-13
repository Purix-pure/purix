// src/llm/context/failure_windows.ts
//
// AI-12 (PURIX-33): the files block for a repair or escalation prompt.
//
// The classify and refine prompts already narrow a large component with focusFiles, guided by words in the instruction. A
// repair round knows something better: the verifier named the lines that are wrong. So when the component is over the
// full-view threshold, the files the verifier pointed at are shown as windows around those lines (forty lines either side,
// plus the head of the file for its imports), and every other file goes through the existing focused view.
//
// Below the threshold, or with the context policy switched off, the result is exactly legacyFilesBlock(files): the same
// bytes the prompt carried before this module existed, so existing prompts and goldens do not move.
//
// Safety property, same as focus.ts: a window only decides what the model SEES. Edits are still applied against the full
// current files by applyEdits, which fails loudly on a missing or ambiguous anchor. A window cannot cause a silent wrong edit;
// the worst case is an honest "edits did not apply", which the repair loop already handles.
//
// The size is enforced, not hoped for: the window width shrinks (40, 20, 10, 5, 2 lines) until the windows fit in three
// quarters of the focused budget, and the remaining files share what is left. If even two lines either side of every location
// do not fit, the later locations are dropped and the file is named in the notice.
import { estimateTokens } from "./tokens.js";
import { focusFiles, legacyFilesBlock, type SourceFile } from "./focus.js";
import { samePath, type FailureLocation } from "../../verify/failure_shape.js";

export const WINDOW_CONTEXT_STEPS = [40, 20, 10, 5, 2] as const;
export const HEAD_LINES = 30;
/** Estimated tokens kept free for the notice sentence that closes a partial view. */
const NOTICE_RESERVE = 160;

export interface RepairViewConfig {
  enabled: boolean;
  fullMaxTokens: number;
  focusedMaxTokens: number;
}

export interface RepairFilesView {
  filesBlock: string;
  /** "full" is byte-identical to the legacy block. "windowed" means at least one file is shown in part. */
  mode: "full" | "windowed";
  windowedPaths: string[];
  /** Files whose location lines were dropped to stay inside the budget. */
  droppedLocationPaths: string[];
  estTokens: number;
}

interface Located {
  file: SourceFile;
  /** 0-based line indexes of the verifier's lines in this file, ascending, no repeats. */
  lines: number[];
}

function locate(files: SourceFile[], locations: FailureLocation[]): Located[] {
  const out: Located[] = [];
  for (const f of files) {
    const total = f.content.split("\n").length;
    const lines = [...new Set(locations.filter((l) => samePath(l.path, f.path) && l.line >= 1 && l.line <= total).map((l) => l.line - 1))].sort((a, b) => a - b);
    if (lines.length > 0) out.push({ file: f, lines });
  }
  return out;
}

function windowText(file: SourceFile, lines: number[], context: number, head: number = HEAD_LINES): { text: string; shown: number; total: number } {
  const all = file.content.split("\n");
  const keep = new Set<number>();
  for (let k = 0; k < Math.min(all.length, head); k++) keep.add(k);
  for (const at of lines) for (let k = Math.max(0, at - context); k <= Math.min(all.length - 1, at + context); k++) keep.add(k);
  const ordered = [...keep].sort((a, b) => a - b);
  const parts: string[] = [];
  let prev = -2;
  for (const i of ordered) {
    if (i !== prev + 1) parts.push(`… (lines ${prev + 2}-${i} omitted) …`);
    parts.push(all[i]!);
    prev = i;
  }
  if (prev < all.length - 1) parts.push(`… (lines ${prev + 2}-${all.length} omitted) …`);
  const whole = ordered.length === all.length;
  return {
    text: whole ? `--- ${file.path} ---\n${file.content}` : `--- ${file.path} (partial view: ${ordered.length} of ${all.length} lines) ---\n${parts.join("\n")}`,
    shown: ordered.length,
    total: all.length,
  };
}

const NOTICE =
  `[Context budget notice: this component is larger than the context budget, so some content is not shown. ` +
  `Only propose edits whose anchor text appears verbatim above; if the change needs content that is not shown, ` +
  `say so in your reasoning and lower your confidence instead of guessing.]`;

export function buildRepairFilesBlock(files: SourceFile[], locations: FailureLocation[], cfg: RepairViewConfig, hint: string = ""): RepairFilesView {
  const legacy = legacyFilesBlock(files);
  const total = estimateTokens(legacy);
  if (!cfg.enabled || total <= cfg.fullMaxTokens) {
    return { filesBlock: legacy, mode: "full", windowedPaths: [], droppedLocationPaths: [], estTokens: total };
  }

  const located = locate(files, locations);
  if (located.length === 0) {
    // The verifier named no place we can find in these files. Fall back to the instruction-guided focused view.
    const f = focusFiles(files, hint, cfg.fullMaxTokens, cfg.focusedMaxTokens);
    return { filesBlock: f.filesBlock, mode: f.mode === "full" ? "full" : "windowed", windowedPaths: [], droppedLocationPaths: [], estTokens: f.estTokens };
  }

  const windowBudget = Math.floor(cfg.focusedMaxTokens * 0.75);
  let chosen: { located: Located[]; texts: string[]; context: number } | null = null;
  for (const context of WINDOW_CONTEXT_STEPS) {
    const texts = located.map((l) => windowText(l.file, l.lines, context).text);
    if (texts.reduce((n, t) => n + estimateTokens(t) + 2, 0) <= windowBudget) {
      chosen = { located, texts, context };
      break;
    }
  }

  const dropped: string[] = [];
  if (chosen === null) {
    // Even the narrowest window around every location is too big: keep whole files' worth of locations in order until the budget is used.
    const context = WINDOW_CONTEXT_STEPS[WINDOW_CONTEXT_STEPS.length - 1]!;
    const keptLocated: Located[] = [];
    const texts: string[] = [];
    let used = 0;
    for (const l of located) {
      let lines = l.lines;
      // Last resort only: the file head is the first thing given up, then locations from the end.
      let head: number = HEAD_LINES;
      let text = windowText(l.file, lines, context, head).text;
      while ((lines.length > 1 || head > 0) && used + estimateTokens(text) + 2 > windowBudget) {
        if (head > 0) head = head > 10 ? 10 : 0;
        else lines = lines.slice(0, -1);
        text = windowText(l.file, lines, context, head).text;
        if (lines.length < l.lines.length && !dropped.includes(l.file.path)) dropped.push(l.file.path);
      }
      if (used + estimateTokens(text) + 2 > windowBudget) {
        if (!dropped.includes(l.file.path)) dropped.push(l.file.path);
        continue;
      }
      keptLocated.push({ file: l.file, lines });
      texts.push(text);
      used += estimateTokens(text) + 2;
    }
    chosen = { located: keptLocated, texts, context };
  }

  const shownPaths = new Set(chosen.located.map((l) => l.file.path));
  const used = chosen.texts.reduce((n, t) => n + estimateTokens(t) + 2, 0);
  const others = files.filter((f) => !shownPaths.has(f.path));
  const remaining = Math.max(0, cfg.focusedMaxTokens - used - NOTICE_RESERVE);

  const blocks = [...chosen.texts];
  let othersPartial = false;
  if (others.length > 0) {
    const focus = focusFiles(others, hint, remaining, remaining);
    blocks.push(focus.filesBlock);
    othersPartial = focus.mode === "focused";
  }

  const windowedPaths = chosen.located.filter((l) => windowText(l.file, l.lines, chosen.context).shown < l.file.content.split("\n").length).map((l) => l.file.path);
  let filesBlock = blocks.join("\n\n");
  // focusFiles already closes its own partial view with this notice; add it only when it did not.
  if ((windowedPaths.length > 0 || dropped.length > 0) && !othersPartial) filesBlock += `\n\n${NOTICE}`;
  return { filesBlock, mode: "windowed", windowedPaths, droppedLocationPaths: dropped, estTokens: estimateTokens(filesBlock) };
}
