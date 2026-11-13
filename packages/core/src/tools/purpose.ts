// packages/core/src/tools/purpose.ts
//
// `purix tools "<purpose>"`: turn a few free words into catalog tools. Pure and offline by
// construction: it reads the shipped catalog and nothing else, so it cannot reach a network,
// a registry, or the disk. This is the only purpose matcher.
//
// Matching is deliberately plain: vocabulary tables, no scoring model. Every match carries the
// words that caused it, so the output can say why.
import type { Capability, CatalogEntry } from "./types.js";

const CAPABILITY_WORDS: Record<Capability, readonly string[]> = {
  "run-tests": ["test", "tests", "testing", "tester", "unittest", "unit", "spec", "specs", "runner"],
  "type-check": ["type", "types", "typing", "typecheck", "typechecking", "typechecker", "compile", "compiler", "static"],
  lint: ["lint", "linter", "linting", "style", "format", "formatter", "formatting", "idiom", "idioms"],
  "dep-audit": ["audit", "auditing", "vulnerability", "vulnerabilities", "vuln", "vulns", "cve", "cves", "security", "dependency", "dependencies", "advisories"],
};

const LANGUAGE_WORDS: Record<string, readonly string[]> = {
  python: ["python", "py", "python3", "pip", "pypi"],
  typescript: ["typescript", "ts", "javascript", "js", "node", "nodejs", "npm"],
};

export interface PurposeMatch {
  entry: CatalogEntry;
  /** Plain-language reasons, in the order they were found. */
  reasons: string[];
  score: number;
}

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 0);
}

function languagesNamed(tokens: readonly string[]): Set<string> {
  const out = new Set<string>();
  for (const [lang, words] of Object.entries(LANGUAGE_WORDS)) if (tokens.some((t) => words.includes(t))) out.add(lang);
  return out;
}

function capabilitiesNamed(tokens: readonly string[]): Map<Capability, string[]> {
  const out = new Map<Capability, string[]>();
  for (const [cap, words] of Object.entries(CAPABILITY_WORDS) as [Capability, readonly string[]][]) {
    const hit = tokens.filter((t) => words.includes(t));
    if (hit.length > 0) out.set(cap, hit);
  }
  return out;
}

function nameTokens(entry: CatalogEntry): Set<string> {
  return new Set([entry.id, entry.package, entry.bin, ...tokenize(entry.displayName)].map((s) => s.toLowerCase()));
}

/**
 * Catalog entries that fit `purpose`, best first (ties: group, then id, so output is stable).
 * Returns [] when nothing in the catalog fits; the caller says so rather than guessing.
 */
export function matchPurpose(purpose: string, catalog: readonly CatalogEntry[]): PurposeMatch[] {
  const tokens = tokenize(purpose);
  if (tokens.length === 0) return [];
  const languages = languagesNamed(tokens);
  const languageWords = new Set(Object.values(LANGUAGE_WORDS).flat());
  const capabilities = capabilitiesNamed(tokens);

  const out: PurposeMatch[] = [];
  for (const entry of catalog) {
    const reasons: string[] = [];
    let score = 0;

    // A language word ("typescript") is never a tool name, even when a tool shares it as its id.
    const named = [...nameTokens(entry)].find((n) => tokens.includes(n) && !languageWords.has(n));
    if (named) {
      score += 100;
      reasons.push(`you named it ("${named}")`);
    }

    const matchedCaps = entry.capabilities.filter((c) => capabilities.has(c));
    for (const cap of matchedCaps) {
      score += 10;
      reasons.push(`provides ${cap} (you said "${(capabilities.get(cap) ?? []).join('", "')}")`);
    }

    const matchedLangs = entry.languages.filter((l) => languages.has(l));
    if (matchedLangs.length > 0) {
      // A language alone is a weak signal (it lists the language's tools); with a capability it narrows.
      score += matchedCaps.length > 0 ? 5 : 3;
      reasons.push(`for ${matchedLangs.join(", ")}`);
    }

    // A language was named alongside a capability: drop tools for other languages.
    if (languages.size > 0 && capabilities.size > 0 && matchedLangs.length === 0 && !named) continue;
    // A capability was named but this tool does not provide it and the user did not name the tool.
    if (capabilities.size > 0 && matchedCaps.length === 0 && !named) continue;

    if (score > 0) out.push({ entry, reasons, score });
  }

  return out.sort((a, b) => b.score - a.score || a.entry.group.localeCompare(b.entry.group) || a.entry.id.localeCompare(b.entry.id));
}
