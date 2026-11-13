// A10a-1: which files are source code in a language Purix has no provider for. Documents and data are not in this list.
import { describe, it } from "node:test";
import { expect } from "expect";
import { unsupportedLanguageOfFile } from "./unsupported_languages.js";

describe("unsupportedLanguageOfFile", () => {
  it("names common source languages Purix has no provider for", () => {
    expect(unsupportedLanguageOfFile("cmd/main.go")).toBe("Go");
    expect(unsupportedLanguageOfFile("src/Main.java")).toBe("Java");
    expect(unsupportedLanguageOfFile("lib/a.RS")).toBe("Rust");
    expect(unsupportedLanguageOfFile("app/Program.cs")).toBe("C#");
    expect(unsupportedLanguageOfFile("x.rb")).toBe("Ruby");
  });
  it("says nothing about languages that have a provider", () => {
    for (const f of ["a.ts", "a.tsx", "a.js", "a.mjs", "a.py"]) expect(unsupportedLanguageOfFile(f)).toBeUndefined();
  });
  it("says nothing about documents, data and config", () => {
    for (const f of ["README.md", "data.json", "ci.yml", "notes.txt", "Makefile", "LICENSE"]) expect(unsupportedLanguageOfFile(f)).toBeUndefined();
  });
});
