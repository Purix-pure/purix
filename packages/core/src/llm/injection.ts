// src/llm/injection.ts
// §9.3's shared, fast, local injection-heuristic pass. One definition,
// imported by both the escalation path (dependency-context scanning)
// and diff-classify (external diff content) — a second, independent
// copy of this marker list is exactly the kind of drift that leaves
// one call site catching a phrase the other one doesn't.
//
// Two forms of the text are scanned. `flat` is lower-cased, accent-stripped,
// confusable-folded, free of invisible characters, with every run of
// whitespace (newlines included) collapsed to one space, so a phrase split
// across lines or padded with zero-width characters still reads as one phrase.
// `lines` keeps the line breaks, for the few markers that only mean something at
// the start of a line (a fake "system:" turn). Encoded text (base64) is decoded
// and scanned with the same patterns.
//
// This is a tripwire for a person to look, never a boundary: the answer to a hit is
// "ask a human" (TrustGate), and a phrase nobody listed still gets through. The
// boundary is the sandbox, the security gate and the confirmation step.

/** Characters that render as nothing (or reorder text) and can be dropped into a phrase to break a plain match. */
const INVISIBLE = /[­͏؜ᅟᅠ឴឵᠋-᠎​-‏‪-‮⁠-⁯ㅤ︀-️﻿ﾠ]/g;

/** Look-alike letters from Cyrillic and Greek that read as Latin to a person. Not exhaustive; it covers what an attacker reaches for first. */
const CONFUSABLES: Record<string, string> = {
  а: "a", в: "b", е: "e", з: "3", і: "i", ї: "i", ј: "j", к: "k", м: "m", н: "h", о: "o", р: "p", с: "c", т: "t", у: "y", х: "x", ѕ: "s", ԁ: "d", ԍ: "g", ӏ: "l",
  α: "a", β: "b", γ: "y", ε: "e", ι: "i", κ: "k", ν: "v", ο: "o", ρ: "p", τ: "t", υ: "u", χ: "x", ω: "w",
};

/** A folded copy of the text plus, for every folded character, the span of the original it came from (UTF-16 offsets). */
interface Folded {
  text: string;
  from: number[];
  to: number[];
}

function foldOne(ch: string): string {
  const base = ch.normalize("NFKD").replace(/\p{M}/gu, "").replace(INVISIBLE, "").toLowerCase();
  let out = "";
  for (const c of base) out += CONFUSABLES[c] ?? c;
  return out;
}

function fold(text: string, collapseWhitespace: boolean): Folded {
  const f: Folded = { text: "", from: [], to: [] };
  let offset = 0;
  let inSpace = false;
  for (const cp of text) {
    const start = offset;
    const end = offset + cp.length;
    offset = end;
    for (const c of foldOne(cp)) {
      if (collapseWhitespace && /\s/.test(c)) {
        if (inSpace) {
          f.to[f.to.length - 1] = end;
          continue;
        }
        inSpace = true;
        f.text += " ";
      } else {
        inSpace = false;
        f.text += c;
      }
      f.from.push(start);
      f.to.push(end);
    }
  }
  return f;
}

const DET = String.raw`(?:all\s+|any\s+|every\s+|the\s+|your\s+|these\s+|those\s+|my\s+|of\s+|what\s+)*`;
const EARLIER = String.raw`(?:previous|prior|above|earlier|preceding|former|original|existing|foregoing)`;
const THING = String.raw`(?:instructions?|rules?|prompts?|guidelines?|directions?|context|constraints?|polic(?:y|ies)|messages?|commands?|guidance|orders?)`;

/** Patterns run against the flat text. */
export const INJECTION_MARKERS: RegExp[] = [
  // "ignore (all|the|your) previous instructions / rules / prompts ..."
  new RegExp(String.raw`\b(?:ignore|disregard|forget|override|bypass|skip|discard)\s+${DET}${EARLIER}\s+${THING}\b`),
  /disregard (all |any )?(previous|prior|above)/,
  // "forget everything above", "ignore all of the above"
  /\b(?:forget|ignore|disregard|discard)\s+(?:everything|all(?:\s+of)?(?:\s+the)?)\s+(?:above|before|prior|previously|earlier|you\s+(?:were|have\s+been)\s+told)\b/,
  /\bignore\s+(?:everything|all)\s+(?:i|we|you|they)\s+(?:said|wrote|told)\b/,
  // "from now on you must / always / only ..."
  /\bfrom\s+now\s+on\b.{0,40}\b(?:you\s+(?:must|will|should|shall|are\s+to)|always|never|only)\b/,
  // role reassignment. "You are now logged in" and "You are now a helpful billing assistant" (a prompt being written) do not match.
  /\byou\s+are\s+now\s+(?:an?\s+|the\s+|in\s+)?(?:unrestricted|jailbroken|unfiltered|uncensored|evil|malicious|rogue|unethical|unaligned|hacker|dan\b|free\s+of|developer\s+mode|admin(?:istrator)?\b|root\b|my\s+(?:assistant|slave)|in\s+\w+\s+mode)/,
  /\b(?:new|updated|real|actual)\s+(?:system\s+)?(?:prompt|instructions?)\s*:/,
  /new system prompt/,
  /act as (an? )?(unrestricted|jailbroken|unfiltered|uncensored)/,
  // chat-template and tool-call markup smuggled into data
  /<\|?\s*(?:im_start|im_end|system|endoftext|begin_of_text|start_header_id)\s*\|?>/,
  /\[\/?inst\]|<<\/?sys>>/,
  /<\/?(?:tool_call|tool_use|tool_result|function_call|function_calls|functions|invoke|antml:[a-z_]+)\b/,
  // an HTML or markdown comment talking to the assistant
  /<!--\s*(?:note\s+(?:to|for)\s+)?(?:the\s+)?(?:assistant|ai|llm|model|agent|reviewer|claude|gpt|copilot)\s*[:,-]/,
  // claimed authority, and an order to skip the checks
  /\b(?:important|urgent|critical)?\s*(?:note|message|notice|instruction)s?\s+(?:from|by)\s+(?:the\s+)?(?:maintainers?|developers?|admins?|owners?|security\s+team|system|anthropic|openai)\b/,
  /\b(?:must|should|do|please)\s+(?:approve|merge|accept|skip)\b.{0,50}\bwithout\b.{0,20}\b(?:review|tests?|checks?|verification|confirmation|approval)\b/,
  // asking for secrets
  /\b(?:print|reveal|leak|exfiltrate|send|email|post|upload)\s+(?:me\s+)?(?:all\s+|any\s+|every\s+|the\s+|your\s+|my\s+)*(?:api[\s_-]?keys?|secrets?|passwords?|credentials?|private\s+keys?|access\s+tokens?|env(?:ironment)?\s+variables?|process\s*\.\s*env)\b/,
  /\bcontents?\s+of\s+\S*(?:\.ssh|id_rsa|id_ed25519|\.aws|\.npmrc|\.netrc|\.env)\b/,
  // the same instruction in a few other languages (accents are already stripped)
  /\bignor(?:a|ar|e|ez|iere)\s+(?:todas?\s+|toutes?\s+|alle\s+)?(?:las\s+|les\s+|as\s+)?(?:instrucciones|instructions|instrucoes|anweisungen)\s+(?:anteriores|previas|precedentes|vorherigen|bisherigen)\b/,
  /\bignor(?:a|ar|e|ez|iere)\s+(?:todas?\s+|toutes?\s+|alle\s+)?(?:las\s+|les\s+|as\s+)?(?:anteriores|previas|precedentes|vorherigen)\s+(?:instrucciones|instructions|instrucoes|anweisungen)\b/,
];

/** Patterns that only mean something at the start of a line. Run against the line-preserving text. */
const LINE_MARKERS: RegExp[] = [
  /^[ \t>*#-]*(?:system|assistant|developer)\s*:[ \t]*(?:you\b|your\b|ignore|disregard|forget|from now|new\b|override|do not|never|always|must|act\b|obey|comply)/m,
];

const BASE64_RUN = /[A-Za-z0-9+/]{24,}={0,2}/g;
const MAX_ENCODED_RUNS = 20;
const MAX_ENCODED_LENGTH = 8192;

export const INJECTION_PLACEHOLDER = "[NEUTRALIZED_INJECTION_PLACEHOLDER]";

function globalCopy(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
}

/** Every match of every marker in one folded view, as the matched text and the matching span of the ORIGINAL text. */
function collect(folded: Folded, markers: RegExp[], label: (t: string) => string): { hit: string; start: number; end: number }[] {
  const found: { hit: string; start: number; end: number }[] = [];
  for (const re of markers) {
    for (const m of folded.text.matchAll(globalCopy(re))) {
      if (m[0].length === 0) continue;
      const a = m.index;
      const b = a + m[0].length - 1;
      found.push({ hit: label(m[0].trim()), start: folded.from[a]!, end: folded.to[b]! });
    }
  }
  return found;
}

/**
 * Finds instruction-like text and replaces each match, in the ORIGINAL text, with a placeholder. `hits` has one entry per
 * marker that matched (the first match of it, read in its folded form), so a caller can print what was seen or count it.
 * The replacement works on the original characters even when the match was found through look-alike letters, invisible
 * characters or collapsed whitespace, which is why callers use this instead of replacing the printed hit themselves.
 */
export function neutralizeInjectionAttempts(text: string, placeholder: string = INJECTION_PLACEHOLDER): { cleaned: string; hits: string[] } {
  const flat = fold(text, true);
  const lines = fold(text, false);
  const spans = [...collect(flat, INJECTION_MARKERS, (t) => t), ...collect(lines, LINE_MARKERS, (t) => t)];

  // Encoded payloads: decode what looks like base64 in the original text (case matters there) and scan the decoded text.
  let runs = 0;
  for (const m of text.matchAll(BASE64_RUN)) {
    if (runs >= MAX_ENCODED_RUNS) break;
    const run = m[0];
    if (run.length > MAX_ENCODED_LENGTH) continue;
    const decoded = Buffer.from(run, "base64").toString("utf8");
    const printable = decoded.replace(/[^\x20-\x7E\n\t]/g, "");
    if (decoded.length < 12 || printable.length / decoded.length <= 0.9) continue;
    runs += 1;
    const inner = [...collect(fold(decoded, true), INJECTION_MARKERS, (t) => `(base64) ${t}`), ...collect(fold(decoded, false), LINE_MARKERS, (t) => `(base64) ${t}`)];
    for (const hit of inner) spans.push({ hit: hit.hit, start: m.index, end: m.index + run.length });
  }

  // One hit per distinct text, in the order the markers matched.
  const hits: string[] = [];
  for (const s of spans) if (!hits.includes(s.hit)) hits.push(s.hit);

  spans.sort((x, y) => x.start - y.start || y.end - x.end);
  let cleaned = "";
  let cursor = 0;
  for (const s of spans) {
    if (s.end <= cursor) continue;
    cleaned += text.slice(cursor, Math.max(cursor, s.start)) + placeholder;
    cursor = s.end;
  }
  cleaned += text.slice(cursor);
  return { cleaned: spans.length > 0 ? cleaned : text, hits };
}

/** Heuristic, not a guarantee — same honest tradeoff secrets.ts makes. Fails toward "ask a human," not toward silently trusting the content. */
export function scanForInjectionAttempts(text: string): string[] {
  return neutralizeInjectionAttempts(text).hits;
}
