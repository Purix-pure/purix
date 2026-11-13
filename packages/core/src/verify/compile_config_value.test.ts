// packages/core/src/verify/compile_config_value.test.ts
//
// A3-2 (research 04 finding 9, probe E7; session handoff blocker 3, "wrong text, reports success"). A `config_value` edit used to
// match its key with line.includes(key), its value with line.includes(old_value), and replace the FIRST occurrence of the value
// in the whole line. Each of those could land on the wrong text with no error. These tests pin the repaired rules: the key is a
// whole name, comment lines are never edited, the value is the one that follows the key, and the value is a whole value (so a
// repeated application cannot turn "5" into "50" into "500").
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyEdits, compilePatch } from "./compile.js";

const file = (content: string, path = "config.yml") => [{ path, content }];
const edit = (over: object = {}) => ({ path: "config.yml", kind: "config_value", key: "timeout", old_value: "30", new_value: "60", ...over }) as any;
const run = (content: string, over: object = {}, path = "config.yml") => applyEdits([edit({ path, ...over })], file(content, path));
const after = (content: string, over: object = {}, path = "config.yml"): string => {
  const r = run(content, over, path);
  if (!r.ok) throw new Error(`expected the edit to apply, but it was refused: ${r.reason}`);
  return r.files[0]!.new_content;
};

describe("config_value: the old value is replaced after the key, never inside it (E7 case 1)", () => {
  it("retry1: 1 with key retry1, old 1, new 9 changes the value and leaves the key alone", () => {
    expect(after("retry1: 1\n", { key: "retry1", old_value: "1", new_value: "9" })).toBe("retry1: 9\n");
  });
  it("a number that also appears earlier on the line is not the one replaced", () => {
    expect(after("{ port: 3000, retries: 3 }\n", { key: "retries", old_value: "3", new_value: "5" })).toBe("{ port: 3000, retries: 5 }\n");
  });
  it("a text after the value (a trailing comment) is left as it was, even when it repeats the old value", () => {
    expect(after("retries: 3  # was 3\n", { key: "retries", old_value: "3", new_value: "5" })).toBe("retries: 5  # was 3\n");
  });
});

describe("config_value: the key is a whole name (E7 case 1, other direction)", () => {
  it("key retry does not match the key retry1", () => {
    const r = run("retry1: 1\n", { key: "retry", old_value: "1", new_value: "9" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('key "retry" not found');
  });
  it("a longer key that contains the wanted key is a different key: connect-timeout is not timeout", () => {
    expect(after("connect-timeout: 5\ntimeout: 5\n", { key: "timeout", old_value: "5", new_value: "7" })).toBe("connect-timeout: 5\ntimeout: 7\n");
  });
  it("export_dir is not the key dir, and PORT_NUMBER is not the key PORT", () => {
    expect(run("export_dir: 1\n", { key: "dir", old_value: "1", new_value: "2" }).ok).toBe(false);
    expect(run("PORT_NUMBER=80\n", { key: "PORT", old_value: "80", new_value: "81" }, ".env").ok).toBe(false);
  });
  it("timeout.ms is a different key from timeout", () => {
    expect(run("timeout.ms: 5\n", { key: "timeout", old_value: "5", new_value: "7" }).ok).toBe(false);
  });
});

describe("config_value: comment lines are never edited (E7 case 2)", () => {
  it("a comment that mentions the key and the old value is not edited when the real line holds another value", () => {
    const r = run("# port: 80 is default\nport: 90\n", { key: "port", old_value: "80", new_value: "81" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("doesn't appear on that line");
  });
  it("the real line is changed and the comment above it is untouched", () => {
    expect(after("# port: 80 is default\nport: 80\n", { key: "port", old_value: "80", new_value: "81" })).toBe("# port: 80 is default\nport: 81\n");
  });
  it("a key that only appears in comments says so", () => {
    for (const comment of ["# port: 80\n", "// port: 80\n", "; port: 80\n", "/* port: 80 */\n", " * port: 80\n"]) {
      const r = run(comment, { key: "port", old_value: "80", new_value: "81" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.reason).toMatch(/only in comment/i);
    }
  });
});

describe("config_value: the value is a whole value, so a repeat cannot compound (replay)", () => {
  it("8080 is not 80", () => {
    const r = run("port: 8080\n", { key: "port", old_value: "80", new_value: "81" });
    expect(r.ok).toBe(false);
  });
  it("applying 5 -> 50 twice is refused the second time (it used to give 500)", () => {
    const once = after("retries: 5\n", { key: "retries", old_value: "5", new_value: "50" });
    expect(once).toBe("retries: 50\n");
    const twice = run(once, { key: "retries", old_value: "5", new_value: "50" });
    expect(twice.ok).toBe(false);
  });
  it("a decimal is one value: 5 does not match 5.5", () => {
    expect(run("ratio: 5.5\n", { key: "ratio", old_value: "5", new_value: "6" }).ok).toBe(false);
  });
});

describe("config_value: the formats it is used on", () => {
  it("JSON with a quoted key and a number", () => {
    expect(after('{\n  "timeout": 30,\n  "retries": 3\n}\n', {}, "package.json")).toBe('{\n  "timeout": 60,\n  "retries": 3\n}\n');
  });
  it("JSON with a quoted number", () => {
    expect(after('  "timeout": "30"\n', {}, "settings.json")).toBe('  "timeout": "60"\n');
  });
  it("old value written with its quotes", () => {
    expect(after('mode: "fast"\n', { key: "mode", old_value: '"fast"', new_value: '"safe"' })).toBe('mode: "safe"\n');
  });
  it("TOML and .env with = and no spaces", () => {
    expect(after("timeout = 30\n", {}, "app.toml")).toBe("timeout = 60\n");
    expect(after("timeout=30\n", {}, ".env")).toBe("timeout=60\n");
  });
  it("a typed constant and a member assignment in code", () => {
    expect(after("export const DEFAULT_TIMEOUT: number = 30;\n", { key: "DEFAULT_TIMEOUT" }, "src/a.ts")).toBe("export const DEFAULT_TIMEOUT: number = 60;\n");
    expect(after("config.timeout = 30;\n", {}, "src/a.js")).toBe("config.timeout = 60;\n");
  });
  it("a directive that starts the line and has no separator", () => {
    expect(after("worker_connections 1024;\n", { key: "worker_connections", old_value: "1024", new_value: "2048" }, "nginx.conf")).toBe("worker_connections 2048;\n");
  });
  it("a CRLF file keeps its line endings", () => {
    expect(after("a: 1\r\ntimeout: 30\r\nb: 2\r\n")).toBe("a: 1\r\ntimeout: 60\r\nb: 2\r\n");
  });
});

describe("config_value: refusals that already worked still do", () => {
  it("the same key and value on two lines is ambiguous", () => {
    const r = run("timeout: 30\ntimeout: 30\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ambiguous");
  });
  it("the same key twice on one line is ambiguous", () => {
    const r = run("{ timeout: 30, retry: { timeout: 30 } }\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("ambiguous");
  });
  it("a value on the next line is refused, not guessed", () => {
    expect(run("timeout:\n  30\n").ok).toBe(false);
  });
  it("a missing key and a missing value keep their messages", () => {
    const k = run("a: 1\n", { key: "retries" });
    if (!k.ok) expect(k.reason).toContain('key "retries" not found');
    const v = run("timeout: 31\n", { old_value: "99" });
    if (!v.ok) expect(v.reason).toContain("doesn't appear on that line");
    expect(k.ok || v.ok).toBe(false);
  });
});

describe("compilePatch: an edit that changes nothing is refused (replay guard)", () => {
  it("old text equal to new text produces no change and says so", () => {
    const r = compilePatch(
      { operation: "update_prompt_text", edits: [{ path: "a.md", kind: "prompt_text", old_text: "hello", new_text: "hello" }] } as any,
      [{ path: "a.md", content: "hello world\n" }]
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no change/i);
  });
  it("a config edit whose new value equals the old value is refused as no change", () => {
    const r = run("timeout: 30\n", { new_value: "30" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/no change/i);
  });
});
