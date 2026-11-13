// packages/core/src/eval/dry.ts
//
// AI-10 (PURIX-33): the canned "model" behind `--dry` and the harness tests.
//
// It answers from the case itself (it knows the original line), with failures injected at fixed, seed-stable rates that
// are worse on the low tier. That exercises every path in the harness: invalid JSON, unclassified, an anchor that only
// the cascade can rescue (a two-line anchor on a CRLF file), a line number off by one, a stale hash. The numbers a dry
// run prints say nothing about any real model. The report says so on its first line.
import { createHash } from "node:crypto";
import type { CallContext, CallModel, ModelReply } from "./runner.js";
import type { PromptPair } from "../llm/prompts/frames.js";
import type { EvalCase } from "./mutations.js";
import { splitFile } from "./line_ops.js";

/** Stable value in [0, 1) for a string. */
function unit(text: string): number {
  const h = createHash("sha1").update(text).digest();
  return h.readUInt32BE(0) / 4294967296;
}

const hash2 = (line: string) => createHash("sha1").update(line.replace(/[ \t\r]+$/, "")).digest("hex").slice(0, 2);
const tokens = (s: string) => Math.ceil(s.length / 3.5);

function reply(prompt: PromptPair, text: string): ModelReply {
  return { text, inputTokens: tokens(prompt.system) + tokens(prompt.user), outputTokens: tokens(text) };
}

export function dryReplyText(ctx: CallContext): string {
  const c = ctx.case;
  const roll = unit(`${c.id}|${ctx.arm}|${ctx.tier}|${ctx.trial}`);
  // Failure rates: [invalid JSON, unclassified/empty, wrong target]. The low tier is the weaker one.
  const [pInvalid, pEmpty, pWrong] = ctx.tier === "low" ? [0.08, 0.07, 0.12] : [0.02, 0.03, 0.04];
  if (roll < pInvalid) return "Sure! Here is the change you asked for.";
  if (roll < pInvalid + pEmpty) {
    return ctx.arm === "A0" || ctx.arm === "A1"
      ? JSON.stringify({ reasoning: "no safe edit", operation: "unclassified", contract_changing: false, confidence: 0.3, edits: [], suspicious_injected_instruction: false })
      : JSON.stringify({ reasoning: "no safe edit", edits: [], content: "" });
  }
  const wrong = roll < pInvalid + pEmpty + pWrong;

  const mutated = splitFile(c.mutated).lines;
  const original = splitFile(c.original).lines;
  const i = c.line - 1;
  const badLine = mutated[i] ?? "";
  const goodLine = original[i] ?? "";

  switch (ctx.arm) {
    case "A0":
    case "A1": {
      // On CRLF files the model joins a two-line anchor with "\n", which only a cascade can match.
      const multi = c.eol === "crlf" && i > 0 && unit(`${c.id}|multi`) < 0.6;
      const oldText = multi ? `${mutated[i - 1]}\n${badLine}` : badLine;
      const newText = multi ? `${original[i - 1]}\n${goodLine}` : goodLine;
      return JSON.stringify({
        reasoning: "fixture",
        operation: "update_prompt_text",
        contract_changing: false,
        confidence: 0.9,
        edits: [{ path: c.path, kind: "prompt_text", old_text: wrong ? `${badLine} // not in the file` : oldText, new_text: newText }],
        suspicious_injected_instruction: false,
      });
    }
    case "A2": {
      const off = unit(`${c.id}|off`) < 0.3 ? 1 : 0; // stated line is one off; the expect text lets the tool recover
      return JSON.stringify({
        reasoning: "fixture",
        edits: [{ op: "replace_range", start: c.line + off, end: c.line + off, expect: wrong ? "does not exist anywhere" : badLine.trim().slice(0, 40), new_lines: [goodLine] }],
      });
    }
    case "A3": {
      const ref = wrong ? `${c.line}:${hash2(badLine) === "00" ? "01" : "00"}` : `${c.line}:${hash2(badLine)}`;
      return JSON.stringify({ reasoning: "fixture", edits: [{ op: "replace", ref, new_lines: [goodLine] }] });
    }
    case "A4": {
      const lines = [...mutated];
      lines[i] = wrong ? badLine : goodLine;
      return JSON.stringify({ reasoning: "fixture", content: lines.join("\n") + (c.mutated.endsWith("\n") ? "\n" : "") });
    }
  }
}

export const dryModel: CallModel = (prompt, _tier, ctx) => Promise.resolve(reply(prompt, dryReplyText(ctx)));
