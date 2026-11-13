// src/security/error_text.test.ts
//
// H3 remainder: text that describes a failure and goes to a model (an MCP tool error) or into a provider error message must not
// carry absolute paths of the person's machine, known secret formats, masked key fragments or stack frames.
import { describe, it } from "node:test";
import { expect } from "expect";
import { sanitizeErrorText } from "./error_text";

describe("sanitizeErrorText", () => {
  it("leaves a plain Purix sentence untouched", () => {
    const t = 'path "src/a.ts" does not exist: nothing was written.';
    expect(sanitizeErrorText(t)).toBe(t);
  });

  it("replaces the project root with <project>, keeping the part below it", () => {
    const out = sanitizeErrorText("ENOENT: no such file or directory, open '/work/app/.purix/state.json'", { roots: ["/work/app"] });
    expect(out).toContain("<project>/.purix/state.json");
    expect(out).not.toContain("/work/app");
  });

  it("does not treat a sibling folder with the same prefix as the root", () => {
    const out = sanitizeErrorText("open '/work/app-two/x.ts'", { roots: ["/work/app"] });
    expect(out).toContain("/work/app-two/x.ts");
  });

  it("replaces a home directory with ~ on Linux, macOS and Windows shapes", () => {
    expect(sanitizeErrorText("EACCES: permission denied, open '/home/alice/.config/purix/key'")).toContain("~/.config/purix/key");
    expect(sanitizeErrorText("EACCES '/Users/Bob Smith/x'")).not.toContain("Bob");
    expect(sanitizeErrorText("EPERM 'C:\\Users\\carol\\AppData\\x'")).not.toContain("carol");
    expect(sanitizeErrorText("EPERM 'C:/Users/dave/x'")).not.toContain("dave");
  });

  it("uses the roots and home it is given before the generic user-folder rule", () => {
    const out = sanitizeErrorText("read '/srv/ci/home/eve/proj/a.ts'", { roots: ["/srv/ci/home/eve/proj"], home: "/srv/ci/home/eve" });
    expect(out).toBe("read '<project>/a.ts'");
  });

  it("redacts a known secret format", () => {
    const out = sanitizeErrorText("401: key AKIAIOSFODNN7EXAMPLE rejected");
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("[REDACTED");
  });

  it("redacts the masked key fragment a provider echoes back", () => {
    const out = sanitizeErrorText("Incorrect API key provided: sk-proj-********************abcd. You can find your key at ...");
    expect(out).not.toContain("abcd");
    expect(out).not.toContain("sk-proj");
  });

  it("drops stack frames", () => {
    const out = sanitizeErrorText("Error: boom\n    at foo (/home/alice/x.js:1:2)\n    at bar (node:internal/x:3:4)");
    expect(out).toBe("Error: boom");
  });

  it("caps the length and says so", () => {
    const out = sanitizeErrorText("x".repeat(5000), { maxChars: 100 });
    expect(out.length).toBeLessThan(200);
    expect(out).toContain("cut");
  });

  it("is safe on empty text and on a very long line of path-like text", () => {
    expect(sanitizeErrorText("")).toBe("");
    const t0 = Date.now();
    sanitizeErrorText("/home/".repeat(50_000));
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});
