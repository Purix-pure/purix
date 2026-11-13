// src/verify/precheck.ts
//
// AI-07. The cheapest check there is, run first: does the edited text still parse? A patch with a stray brace used to cost a
// full sandbox copy and a whole-project compile before anyone said so. Now it is refused in milliseconds, before any
// temporary directory exists, with a line in the same shape the compiler uses so the repair step reads it the same way.
//
// One rule keeps this from ever being wrong in a way the compiler would not be: a file fails only if its ORIGINAL text (read
// from the target directory) parsed clean through the same parser and the new text does not. A newer syntax than the bundled
// parser knows therefore cannot block an edit to a file that already used it. A file with no original (a new file) is left to
// the compiler for the same reason: there is nothing to prove the parser agrees with the project on that file.
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { getLanguageProvider, listLanguageIds } from "../language/registry.js";
import type { ParseCheckResult } from "../language/provider.js";

export interface PrecheckFailure {
  reason: string;
  errorClass: "syntax";
  files: string[];
}

const MAX_REPORTED = 5;

function jsonCheck(path: string, content: string): ParseCheckResult | undefined {
  if (!/\.json$/i.test(path)) return undefined;
  try {
    JSON.parse(content);
    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const at = /position (\d+)/.exec(message);
    let line = 1, column = 1;
    if (at) {
      const before = content.slice(0, Number(at[1]!));
      line = before.split("\n").length;
      column = before.length - before.lastIndexOf("\n");
    }
    return { ok: false, line, column, message: message.replace(/ in JSON at position \d+.*$/, "").replace(/ \(line \d+ column \d+\)/, ""), code: "JSON" };
  }
}

/** First answer from any language provider that handles this file, JSON handled here. Undefined: nobody checked it. */
function checkOne(path: string, content: string): ParseCheckResult | undefined {
  const json = jsonCheck(path, content);
  if (json) return json;
  for (const id of listLanguageIds()) {
    const result = getLanguageProvider(id)?.parseCheck?.(path, content);
    if (result) return result;
  }
  return undefined;
}

function readOriginal(targetDir: string, path: string): string | null {
  const full = resolve(targetDir, path);
  const rel = relative(resolve(targetDir), full);
  if (rel.startsWith("..") || isAbsolute(rel)) return null; // never read outside the project
  try {
    return existsSync(full) ? readFileSync(full, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Null when nothing is provably broken by this edit. */
export function precheckEdits(changes: { path: string; new_content: string }[], targetDir: string): PrecheckFailure | null {
  const lines: string[] = [];
  const files: string[] = [];
  for (const change of changes) {
    const now = checkOne(change.path, change.new_content);
    if (!now || now.ok) continue;
    const original = readOriginal(targetDir, change.path);
    if (original === null) continue;
    const before = checkOne(change.path, original);
    if (!before || !before.ok) continue; // the original does not parse clean through this parser: no claim to make
    files.push(change.path);
    if (lines.length < MAX_REPORTED) lines.push(`${change.path}(${now.line},${now.column}): error ${now.code ?? "SYNTAX"}: ${now.message}`);
  }
  if (files.length === 0) return null;
  const more = files.length > lines.length ? `\n(${files.length - lines.length} more file(s) with syntax errors)` : "";
  return { reason: `${lines.join("\n")}${more}`, errorClass: "syntax", files };
}
