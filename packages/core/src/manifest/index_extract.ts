// packages/core/src/manifest/index_extract.ts
//
// The symbol extraction behind `purix index`. It replaces the single regex the indexer used before
// (problem register 2026-11-20, items 2 to 5, probes IDX-01 to IDX-06).
//
// What the regex got wrong, each reproduced against the released 0.4.0-beta.4:
//   - it ran on raw text, so `export function x` inside a comment or a string (352 of 1,845 TypeScript entries on Purix's own code,
//     mostly fixture strings in test files) became a component, and the same text in two strings became two entries;
//   - it missed `export default`, `export enum`, `export abstract class`, `export namespace`, `export { a }` and re-exports;
//   - it stored only the matched text (`export function hello`), so no parameters and no return type;
//   - it recorded no methods, and marked everything it found as reusable, test files included.
//
// How it works now.
//   TypeScript and JavaScript: the TypeScript compiler's own parser (the one inside ts-morph, which the verifier already loads). Parse
//     only: no type check, no program, no file system. A comment or a string is never a declaration because the parser says so.
//   Python: a scanner that follows strings (single, triple-quoted), comments and brackets, then reads definitions from lines that start
//     outside a string. Python has no parser in Node, and starting `python` for every file would make `purix index` depend on an
//     interpreter that may not be installed (BETA_SCOPE.md: indexing must run without one), so this is pattern work with the string
//     and comment cases handled. Its limits are listed at the foot of this header.
//
// What is recorded. Top-level exported declarations; for an exported class, its public methods as `Class.method`. For Python, top-level
// public `def` and `class`, and the public methods of those classes. Names starting with `_` are private in Python and are skipped.
// One entry per (name, file): overloads and merged declarations keep the first.
//
// `reusable` keeps its name and its place in the schema (renaming it needs a manifest migration, and the owner of manifest/ is an open
// ruling, F05-01). Its meaning is now exactly what the indexer can check: the symbol is exported (public) AND its file is not a test file.
// It still says nothing about whether the code was verified or is safe to reuse: nothing is verified at index time.
//
// Limits, reported not hidden:
//   - `export * from "./x"` names nothing, so it is not recorded. CommonJS (`module.exports = ...`) is not recorded.
//   - Initialisers are never copied into a signature (a value can be a secret or very long): `export const a: T`. A function-valued
//     constant keeps its parameters and return type.
//   - Python: only column-0 definitions and the methods one level inside a column-0 class; nested classes, definitions inside `if` or
//     `try` blocks and dynamically created names are not recorded. Decorators are not part of the signature.
//   - A file the TypeScript parser cannot read at all still yields what it could recover (the parser is error tolerant); a file with no
//     recoverable export gets the whole-file entry, as before.
import { createRequire } from "node:module";
import type { ts as TS } from "ts-morph";
import type { ComponentRecord } from "./schema.js";
import { isTestPath } from "../verify/test_discovery.js";
import { isPythonTestPath } from "../verify/python_test_discovery.js";

type TsApi = typeof import("ts-morph").ts;

let tsApi: TsApi | null | undefined;
/** The TypeScript compiler inside ts-morph, loaded on first use (about half a second), so a Python-only project never pays for it. */
function loadTs(): TsApi | null {
  if (tsApi !== undefined) return tsApi;
  try {
    tsApi = (createRequire(import.meta.url)("ts-morph") as typeof import("ts-morph")).ts;
  } catch {
    tsApi = null;
  }
  return tsApi;
}

const SIGNATURE_MAX = 300;

function tidy(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > SIGNATURE_MAX ? `${flat.slice(0, SIGNATURE_MAX - 1)}…` : flat;
}

export function isTestFile(relPath: string, lang: string): boolean {
  return lang === "python" ? isPythonTestPath(relPath) : isTestPath(relPath);
}

interface Found {
  name: string;
  signature: string;
}

function record(f: Found, relPath: string, lang: string, reusable: boolean): ComponentRecord {
  return {
    symbol_name: f.name,
    file_location: relPath,
    signature: f.signature,
    language: lang,
    // Indexing records that a symbol exists, not that anything was run on it.
    verification_status: "pending",
    last_verified_commit_hash: null,
    reusable,
    rationale: null,
  };
}

/** One entry per name in a file: the first wins (an overload list, `export const a` plus `export type a`, a Python redefinition). */
function firstPerName(found: Found[]): Found[] {
  const seen = new Set<string>();
  const out: Found[] = [];
  for (const f of found) {
    if (seen.has(f.name)) continue;
    seen.add(f.name);
    out.push(f);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------
// TypeScript and JavaScript
// ---------------------------------------------------------------------------------------------------------------------------------

function extractTypeScript(content: string, relPath: string): Found[] | null {
  const ts = loadTs();
  if (!ts) return null;
  // The word has to appear for there to be anything to find: skip the parse for the many files that export nothing.
  if (!content.includes("export")) return [];

  const sf = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, /* setParentNodes */ true);
  const found: Found[] = [];

  const modifiersOf = (node: TS.Node): readonly TS.Modifier[] => (ts.canHaveModifiers(node) ? ts.getModifiers(node) ?? [] : []);
  const hasMod = (node: TS.Node, kind: TS.SyntaxKind): boolean => modifiersOf(node).some((m) => m.kind === kind);
  const startOf = (node: TS.Node): number => {
    // After any decorators: `@Injectable() export class X` is signed `export class X`.
    const first = modifiersOf(node)[0];
    return first ? first.getStart(sf) : node.getStart(sf);
  };
  const text = (from: number, to: number): string => tidy(content.slice(from, to));
  const nameText = (n: TS.PropertyName | TS.BindingName | undefined): string | null => {
    if (!n) return null;
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) return n.text;
    if (ts.isPrivateIdentifier(n)) return null;
    return null; // computed names and destructuring are handled by the callers that can
  };

  const functionSignature = (fn: TS.FunctionDeclaration | TS.MethodDeclaration): string =>
    text(startOf(fn), fn.body ? fn.body.getStart(sf) : fn.end).replace(/;$/, "");

  const bindingNames = (b: TS.BindingName, out: string[]): void => {
    if (ts.isIdentifier(b)) { out.push(b.text); return; }
    for (const el of b.elements) {
      if (ts.isOmittedExpression(el)) continue;
      bindingNames(el.name, out);
    }
  };

  const variableSignature = (list: TS.VariableDeclarationList, d: TS.VariableDeclaration, name: string): string => {
    const kw = list.flags & ts.NodeFlags.Const ? "const" : list.flags & ts.NodeFlags.Let ? "let" : "var";
    const type = d.type ? `: ${text(d.type.getStart(sf), d.type.end)}` : "";
    let fn = "";
    const init = d.initializer;
    if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
      fn = ` = ${text(init.getStart(sf), init.body.getStart(sf))}`;
      if (ts.isFunctionExpression(init)) fn = fn.replace(/\{\s*$/, "").trimEnd();
    }
    return tidy(`export ${kw} ${name}${type}${fn}`);
  };

  const classMembers = (cls: TS.ClassDeclaration, className: string): Found[] => {
    const out: Found[] = [];
    for (const m of cls.members) {
      if (!ts.isMethodDeclaration(m)) continue;
      if (hasMod(m, ts.SyntaxKind.PrivateKeyword) || hasMod(m, ts.SyntaxKind.ProtectedKeyword)) continue;
      const n = nameText(m.name);
      if (n === null) continue;
      out.push({ name: `${className}.${n}`, signature: functionSignature(m) });
    }
    return out;
  };

  const declSignature = (s: TS.Statement): Found[] => {
    const out: Found[] = [];
    if (ts.isFunctionDeclaration(s)) {
      // A named default export (`export default function f`) is recorded under its own name; only an anonymous one is "default".
      out.push({ name: s.name?.text ?? "default", signature: functionSignature(s) });
    } else if (ts.isClassDeclaration(s)) {
      const n = s.name?.text ?? "default";
      out.push({ name: n, signature: text(startOf(s), s.members.pos - 1) });
      out.push(...classMembers(s, n));
    } else if (ts.isInterfaceDeclaration(s)) {
      out.push({ name: s.name.text, signature: text(startOf(s), s.members.pos - 1) });
    } else if (ts.isTypeAliasDeclaration(s)) {
      out.push({ name: s.name.text, signature: text(startOf(s), s.end).replace(/;$/, "") });
    } else if (ts.isEnumDeclaration(s)) {
      out.push({ name: s.name.text, signature: text(startOf(s), s.members.pos - 1) });
    } else if (ts.isModuleDeclaration(s)) {
      const n = nameText(s.name as TS.PropertyName);
      if (n !== null && ts.isIdentifier(s.name)) out.push({ name: n, signature: text(startOf(s), s.body ? s.body.getStart(sf) : s.end).replace(/;$/, "") });
    } else if (ts.isVariableStatement(s)) {
      for (const d of s.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(d.name, names);
        for (const n of names) out.push({ name: n, signature: variableSignature(s.declarationList, d, n) });
      }
    }
    return out;
  };

  // Declarations that `export { a, b as c }` can point at, by local name.
  const local = new Map<string, TS.Statement>();
  for (const s of sf.statements) {
    if (hasMod(s, ts.SyntaxKind.ExportKeyword)) continue;
    if ((ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s) || ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s) || ts.isEnumDeclaration(s)) && s.name) local.set(s.name.text, s);
    else if (ts.isVariableStatement(s)) for (const d of s.declarationList.declarations) { const ns: string[] = []; bindingNames(d.name, ns); for (const n of ns) local.set(n, s); }
  }

  for (const s of sf.statements) {
    if (ts.isExportAssignment(s)) {
      const e = s.expression;
      found.push({ name: s.isExportEquals ? "export=" : "default", signature: tidy(`export ${s.isExportEquals ? "= " : "default "}${ts.isIdentifier(e) ? e.text : ts.isArrowFunction(e) || ts.isFunctionExpression(e) ? text(e.getStart(sf), e.body.getStart(sf)) : "<expression>"}`) });
      continue;
    }
    if (ts.isExportDeclaration(s)) {
      const from = s.moduleSpecifier && ts.isStringLiteral(s.moduleSpecifier) ? ` from ${JSON.stringify(s.moduleSpecifier.text)}` : "";
      const clause = s.exportClause;
      if (!clause) continue; // `export * from "./x"` names nothing
      if (ts.isNamespaceExport(clause)) { found.push({ name: clause.name.text, signature: `export * as ${clause.name.text}${from}` }); continue; }
      for (const spec of clause.elements) {
        const exported = spec.name.text;
        const target = spec.propertyName?.text ?? exported;
        const decl = !from ? local.get(target) : undefined;
        const via = decl ? declSignature(decl).find((f) => f.name === target) : undefined;
        found.push({ name: exported, signature: via ? via.signature.replace(/^(?:export\s+)?/, "export ") : tidy(`export { ${spec.propertyName ? `${target} as ` : ""}${exported} }${from}`) });
      }
      continue;
    }
    if (!hasMod(s, ts.SyntaxKind.ExportKeyword)) continue;
    // `export declare ...` and `export default` take the same path: the keyword list is what differs, not the declaration.
    found.push(...declSignature(s));
  }
  return firstPerName(found);
}

// ---------------------------------------------------------------------------------------------------------------------------------
// Python
// ---------------------------------------------------------------------------------------------------------------------------------

interface PyLine { start: number; end: number; inString: boolean }

/**
 * Splits the file into lines and says, for each, whether it STARTS inside a triple-quoted string (a docstring body or a fixture
 * written as one). Single-quoted strings and comments cannot span a line break (a backslash-newline continues a string).
 */
function scanPythonLines(content: string): PyLine[] {
  const lines: PyLine[] = [];
  let i = 0;
  let lineStart = 0;
  let triple: string | null = null;
  let startedInString = false;
  const n = content.length;
  const close = (end: number): void => {
    lines.push({ start: lineStart, end, inString: startedInString });
    lineStart = end + 1;
    startedInString = triple !== null;
  };
  while (i < n) {
    const ch = content[i]!;
    if (ch === "\n") { close(i); i++; continue; }
    if (triple !== null) {
      // A backslash hides the next character, except a line break: that still ends the line for the line table.
      if (ch === "\\" && content[i + 1] !== "\n") { i += 2; continue; }
      if (content.startsWith(triple, i)) { i += 3; triple = null; continue; }
      i++;
      continue;
    }
    if (ch === "#") { while (i < n && content[i] !== "\n") i++; continue; }
    if (ch === "'" || ch === '"') {
      if (content.startsWith(ch.repeat(3), i)) { triple = ch.repeat(3); i += 3; continue; }
      // a one-line string: run to the matching quote or to the end of the line (a backslash-newline is treated as the end)
      i++;
      while (i < n && content[i] !== "\n") {
        if (content[i] === "\\" && content[i + 1] !== "\n") { i += 2; continue; }
        if (content[i] === ch) { i++; break; }
        i++;
      }
      continue;
    }
    i++;
  }
  if (lineStart <= n) lines.push({ start: lineStart, end: n, inString: startedInString });
  return lines;
}

/** The header of a definition from `from` to its closing colon, following strings, comments and brackets. */
function pythonHeader(content: string, from: number): string {
  let depth = 0;
  let i = from;
  const limit = Math.min(content.length, from + 2000);
  while (i < limit) {
    const ch = content[i]!;
    if (ch === "#") { while (i < limit && content[i] !== "\n") i++; continue; }
    if (ch === "'" || ch === '"') {
      const q = content.startsWith(ch.repeat(3), i) ? ch.repeat(3) : ch;
      i += q.length;
      while (i < limit && !content.startsWith(q, i)) { if (content[i] === "\\") i++; if (q.length === 1 && content[i] === "\n") break; i++; }
      i += q.length;
      continue;
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth = Math.max(0, depth - 1);
    else if (ch === ":" && depth === 0) return content.slice(from, i);
    i++;
  }
  return content.slice(from, Math.min(limit, content.indexOf("\n", from) === -1 ? limit : content.indexOf("\n", from)));
}

const PY_DEF = /^(\s*)((?:async\s+)?(?:def|class))\s+([A-Za-z_]\w*)/;

function extractPython(content: string): Found[] {
  const found: Found[] = [];
  const lines = scanPythonLines(content);
  let cls: { name: string; indent: string | null } | null = null;

  for (const ln of lines) {
    if (ln.inString) continue;
    const raw = content.slice(ln.start, ln.end).replace(/\r$/, "");
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const lead = raw.slice(0, raw.length - raw.trimStart().length);

    if (lead === "") {
      cls = null;
      const m = PY_DEF.exec(raw);
      if (!m) continue;
      const kind = m[2]!;
      const name = m[3]!;
      const isClass = kind.endsWith("class");
      if (!name.startsWith("_")) found.push({ name, signature: tidy(pythonHeader(content, ln.start + m[1]!.length)) });
      if (isClass && !name.startsWith("_")) cls = { name, indent: null };
      continue;
    }

    if (cls) {
      if (cls.indent === null) cls.indent = lead;
      if (lead !== cls.indent) continue;
      const m = PY_DEF.exec(raw);
      if (!m || m[2]!.endsWith("class")) continue;
      const name = m[3]!;
      if (name.startsWith("_")) continue;
      found.push({ name: `${cls.name}.${name}`, signature: tidy(pythonHeader(content, ln.start + lead.length)) });
    }
  }
  return firstPerName(found);
}

// ---------------------------------------------------------------------------------------------------------------------------------

/**
 * The records for one file. Empty result means the file has nothing to record and the caller adds the whole-file entry.
 * `null` from the TypeScript branch means the compiler could not be loaded (a broken install): the caller says so instead of
 * silently indexing nothing.
 */
export function extractFileRecords(relPath: string, content: string, lang: string): ComponentRecord[] | null {
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);
  const found = lang === "python" ? extractPython(content) : extractTypeScript(content, relPath);
  if (found === null) return null;
  const reusable = !isTestFile(relPath, lang);
  return found.map((f) => record(f, relPath, lang, reusable));
}
