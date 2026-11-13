// packages/core/src/language/unsupported_languages.ts
//
// A10a-1 (research 10, rule B; blocker 4): a source file in a language Purix has no provider for must be reported as "unsupported
// language, not checked". Before this, sandbox.ts handed every file that was not `.py` to resolveLanguage(), which ends in a silent
// "typescript": a Go file got a TypeScript error, and a file the TypeScript compiler happened to ignore read as clean.
//
// This list is NOT how Purix decides what a provider supports (that is the manifests, extension_table.ts). It only answers one
// question for a file that no provider claims: "is this source code in a language Purix knows it does not cover?" Documents, data
// and configuration (.md, .json, .yml, .txt) are not source code and are not named here, so they are never called unsupported.
// Adding Java, C# or Go support means adding a manifest and provider (research first, plan section 3 A10a); the entry here then
// stops applying because languageForFile() claims the extension.
import { extname } from "node:path";
import { languageForFile } from "./registry.js";

const NAMES: Record<string, string> = {
  ".go": "Go", ".java": "Java", ".kt": "Kotlin", ".kts": "Kotlin", ".scala": "Scala", ".groovy": "Groovy",
  ".cs": "C#", ".fs": "F#", ".vb": "Visual Basic",
  ".rs": "Rust", ".rb": "Ruby", ".php": "PHP", ".swift": "Swift", ".dart": "Dart", ".lua": "Lua", ".pl": "Perl",
  ".c": "C", ".h": "C", ".cc": "C++", ".cpp": "C++", ".cxx": "C++", ".hpp": "C++", ".hh": "C++", ".m": "Objective-C", ".mm": "Objective-C++",
  ".ex": "Elixir", ".exs": "Elixir", ".erl": "Erlang", ".hs": "Haskell", ".clj": "Clojure", ".ml": "OCaml", ".r": "R", ".jl": "Julia",
  ".sh": "Shell", ".bash": "Shell", ".zsh": "Shell", ".ps1": "PowerShell",
};

/** The name of the language, when `path` is source code Purix has no provider for. Undefined for a supported language and for non-code files. */
export function unsupportedLanguageOfFile(path: string): string | undefined {
  const name = NAMES[extname(path).toLowerCase()];
  if (!name) return undefined;
  return languageForFile(path) === undefined ? name : undefined;
}
