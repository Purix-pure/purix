// packages/core/src/gates/path_match.ts
//
// A1 shared rail (added after research 09): ONE path matcher for the hook and the trust floor.
//
// Today they hold separate rules. gates/trustgate.ts has a private globToRegExp that compares raw strings; hooks/decide.ts has its
// own lower-casing and separator handling. That is how the floor missed `src\auth\x.ts` and `src/Auth/x.ts` (research 08, D04).
// Both consumers are owned by later phases (A2a for the floor, A9 for the hook) and switch to this in their own sessions; A1 only
// builds it and proves it agrees with the trust floor's rule, so the switch changes what is matched only by adding the
// normalisation, never by changing the glob.
//
// Pattern language (deliberately the trust floor's, nothing more):
//   `**`   any depth, including zero; "**/x" also matches "x" at the root
//   `*`    any run of characters inside ONE segment (never crosses "/")
//   `?`    exactly one character inside a segment (new; the floor's patterns do not use it)
//   other  literal. Everything is compared after normalizeRepoPath, with case folded unless told otherwise.
//
// Known, accepted over-match, kept on purpose and inherited from the floor: "**/auth/**" also matches "src/notauth/x.ts",
// because "**" may absorb "not" in front of "auth". For a rule whose only job is to force a human look, matching too much is the
// safe direction; tighten the pattern ("auth/**" at the start, or "**/auth/" after a slash) if one false positive gets noisy.
// Do not use this matcher to ALLOW something on the strength of a match.
//
// Cost: matching is a dynamic-programming walk over (path characters x pattern tokens), not a regular expression, so no pattern
// and no path can make it backtrack. The worst case is MAX_PATH_LENGTH x MAX_PATTERN_LENGTH steps for one pair. Two stated bounds
// keep that small: a pattern longer than MAX_PATTERN_LENGTH is refused, and a path longer than MAX_PATH_LENGTH is not matched
// against anything (see `overLength`). Neither bound has been measured against a real worst case.
import { normalizeRepoPath, type NormalizeRepoPathOptions } from "./path_normalize.js";

export const MAX_PATH_LENGTH = 8192;
export const MAX_PATTERN_LENGTH = 512;

export interface PathMatchOptions extends Omit<NormalizeRepoPathOptions, "foldCase"> {
  /** Compare without regard to case. Default true: a floor must hold on a case-insensitive disk. */
  foldCase?: boolean;
  /**
   * What to do with a path longer than MAX_PATH_LENGTH. "throw" (default) raises a RangeError. "match" reports a hit, the safe
   * answer for a deny list, so a 1 MB "path" can only make the gate stricter, never skip it.
   */
  overLength?: "throw" | "match";
}

type Token = { t: "lit"; ch: string } | { t: "one" } | { t: "star" } | { t: "globstar" };

const cache = new Map<string, Token[]>();
const CACHE_LIMIT = 512;

function patternText(pattern: string, foldCase: boolean): string {
  // Separators and case only. normalizeRepoPath is for paths: it resolves ".." and would change what a pattern like "a/**/../b" means.
  let t = pattern.normalize("NFC").replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  while (t.startsWith("./")) t = t.slice(2);
  return foldCase ? t.toLowerCase() : t;
}

function compile(pattern: string, opts: PathMatchOptions): Token[] {
  const fold = opts.foldCase ?? true;
  const text = patternText(pattern, fold);
  const key = (fold ? "i:" : "s:") + text;
  const hit = cache.get(key);
  if (hit) return hit;
  if (text.length > MAX_PATTERN_LENGTH) throw new RangeError(`path pattern longer than ${MAX_PATTERN_LENGTH} characters`);

  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "*" && text[i + 1] === "*") {
      while (text[i] === "*") i += 1; // "***" is "**"
      if (text[i] === "/") i += 1; // "**/x" also matches "x" at the root
      if (tokens[tokens.length - 1]?.t !== "globstar") tokens.push({ t: "globstar" }); // "**/**" is "**"
      continue;
    }
    if (c === "*") {
      if (tokens[tokens.length - 1]?.t !== "star") tokens.push({ t: "star" }); // "**" was handled above, so "*" runs are collapsed here
      i += 1;
      continue;
    }
    tokens.push(c === "?" ? { t: "one" } : { t: "lit", ch: c });
    i += 1;
  }
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(key, tokens);
  return tokens;
}

/**
 * Does the whole of `path` match the whole pattern? Row-by-row over the tokens, keeping one row of "the first i characters of the
 * path match the tokens so far". "lit" and "one" consume exactly one character ("one" never a "/"); "star" consumes any run of
 * non-"/" characters; "globstar" consumes any run at all, "/" included. Same language as the trust floor's regex translation.
 */
function matches(tokens: readonly Token[], path: string): boolean {
  const n = path.length;
  let prev = new Uint8Array(n + 1);
  let cur = new Uint8Array(n + 1);
  prev[0] = 1;
  for (const tok of tokens) {
    switch (tok.t) {
      case "lit":
        cur[0] = 0;
        for (let i = 1; i <= n; i++) cur[i] = prev[i - 1] && path[i - 1] === tok.ch ? 1 : 0;
        break;
      case "one":
        cur[0] = 0;
        for (let i = 1; i <= n; i++) cur[i] = prev[i - 1] && path[i - 1] !== "/" ? 1 : 0;
        break;
      case "star":
        cur[0] = prev[0]!;
        for (let i = 1; i <= n; i++) cur[i] = prev[i] || (cur[i - 1] && path[i - 1] !== "/") ? 1 : 0;
        break;
      case "globstar":
        cur[0] = prev[0]!;
        for (let i = 1; i <= n; i++) cur[i] = prev[i] || cur[i - 1] ? 1 : 0;
        break;
    }
    [prev, cur] = [cur, prev];
  }
  return prev[n] === 1;
}

function prepare(path: string, opts: PathMatchOptions): string | null {
  if (path.length > MAX_PATH_LENGTH) {
    if (opts.overLength === "match") return null;
    throw new RangeError(`path longer than ${MAX_PATH_LENGTH} characters`);
  }
  return normalizeRepoPath(path, { foldCase: opts.foldCase ?? true, windowsNames: opts.windowsNames });
}

/** True when `path` matches `pattern` after both are normalised. See the file header for the pattern language and its limits. */
export function matchPath(path: string, pattern: string, opts: PathMatchOptions = {}): boolean {
  const p = prepare(path, opts);
  if (p === null) return true;
  return matches(compile(pattern, opts), p);
}

export interface PathMatchHit {
  hit: boolean;
  /** The path as given (not normalised), so a message can quote what the caller passed in. */
  matchedPath?: string;
  matchedPattern?: string;
  /** True when the hit is only because the path exceeded MAX_PATH_LENGTH and the caller chose overLength: "match". */
  overLength?: boolean;
}

/** First (path, pattern) pair that matches, in the order given. Same result shape as the trust floor's checkDeterministicOverrideFloor. */
export function matchAnyPath(paths: readonly string[], patterns: readonly string[], opts: PathMatchOptions = {}): PathMatchHit {
  for (const path of paths) {
    const p = prepare(path, opts);
    if (p === null) return { hit: true, matchedPath: path, matchedPattern: patterns[0], overLength: true };
    for (const pattern of patterns) {
      if (matches(compile(pattern, opts), p)) return { hit: true, matchedPath: path, matchedPattern: pattern };
    }
  }
  return { hit: false };
}
