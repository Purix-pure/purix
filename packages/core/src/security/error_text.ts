// src/security/error_text.ts
//
// H3 remainder: failure text that is shown to a model (an MCP tool error) or built from a provider's reply must not carry the
// person's machine layout, a secret, or a stack trace. This is the one place that cleans such text.
//
// What it does, in order:
//   1. redacts known secret formats (the same list as the write gate, via outbound_scrub);
//   2. redacts a masked key fragment such as "sk-proj-****abcd" (providers echo these back; no format list can match them);
//   3. replaces the project root with "<project>" and the home directory with "~", then any other user-folder prefix
//      (/home/<name>, /Users/<name>, C:\Users\<name>) with "~";
//   4. drops stack frames ("    at ...");
//   5. cuts the text at a length cap.
//
// What it does not do: it does not rewrite paths outside those shapes (for example /srv/data/x), and it cannot know a secret
// in a format the list lacks. Purix's own error sentences pass through unchanged unless they contain one of the above.
import { homedir } from "node:os";
import { scrubOutboundText } from "./outbound_scrub.js";

export interface SanitizeErrorOptions {
  /** Directories shown as "<project>". Usually the project root and its real path. */
  roots?: readonly string[];
  /** Shown as "~". Defaults to the current user's home directory. */
  home?: string;
  /** Length cap in characters. Default 2000. */
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 2000;
const STACK_FRAME = /^\s+at\s.*$/gm;
// The key is masked with a run of * (or x) and a visible tail or head; the prefix before the run is part of the key as well.
const MASKED_KEY = /[A-Za-z0-9_-]*[*]{4,}[A-Za-z0-9_-]*/g;
// A user folder. A name may contain spaces, so it runs to the next separator when there is one, else to the next space.
const NIX_USER_DIR = /\/(?:home|Users)\/(?:[^/\\'"\n]+?(?=[/\\])|[^/\\'"\s]+)/g;
const WIN_USER_DIR = /[A-Za-z]:[\\/]Users[\\/](?:[^/\\'"\n]+?(?=[/\\])|[^/\\'"\s]+)/g;

function isPathBoundary(ch: string | undefined): boolean {
  return ch === undefined || !/[A-Za-z0-9_.-]/.test(ch);
}

/** Replaces every occurrence of `dir` that ends at a path boundary. Tries the forward-slash and backslash spellings. */
function replaceDir(text: string, dir: string, label: string): string {
  const trimmed = dir.replace(/[\\/]+$/, "");
  if (trimmed.length < 2) return text;
  let out = text;
  for (const spelling of new Set([trimmed, trimmed.replace(/\\/g, "/"), trimmed.replace(/\//g, "\\")])) {
    let from = 0;
    for (;;) {
      const at = out.indexOf(spelling, from);
      if (at === -1) break;
      const end = at + spelling.length;
      if (isPathBoundary(out[end]) || out[end] === "/" || out[end] === "\\") {
        out = out.slice(0, at) + label + out.slice(end);
        from = at + label.length;
      } else {
        from = end;
      }
    }
  }
  return out;
}

export function sanitizeErrorText(text: string, options: SanitizeErrorOptions = {}): string {
  if (text.length === 0) return text;
  const max = options.maxChars ?? DEFAULT_MAX_CHARS;
  let out = scrubOutboundText(text).text;
  out = out.replace(MASKED_KEY, "[REDACTED:masked key]");
  // A key echoed as "sk-proj-[REDACTED...]" leaves its prefix; the masked rule above already took the whole token.
  const roots = [...(options.roots ?? [])].filter((r) => r.length > 0).sort((a, b) => b.length - a.length);
  for (const root of roots) out = replaceDir(out, root, "<project>");
  const home = options.home ?? safeHome();
  if (home) out = replaceDir(out, home, "~");
  out = out.replace(NIX_USER_DIR, "~").replace(WIN_USER_DIR, "~");
  out = out.replace(STACK_FRAME, "").replace(/\n{2,}/g, "\n").trim();
  if (out.length > max) out = `${out.slice(0, max)} [Purix: error text cut at ${max} characters.]`;
  return out;
}

function safeHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}
