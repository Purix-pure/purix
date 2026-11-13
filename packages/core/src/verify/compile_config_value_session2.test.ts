// A3-2 (research 04, task 1 option D and task 6; blocker 3, the "wrong text, reports success" part). The five E7 cases plus the replay case.
import { describe, it } from "node:test";
import { expect } from "expect";
import { applyEdits } from "./compile";

const edit = (over: object) => ({ path: "c.txt", kind: "config_value", key: "port", old_value: "80", new_value: "81", ...over }) as any;
const run = (e: object, content: string) => applyEdits([edit(e)], [{ path: "c.txt", content }]);
const out = (e: object, content: string) => { const r = run(e, content); return r.ok ? r.files[0]!.new_content : `REFUSED: ${r.reason}`; };

describe("config_value: the value is edited, never the key", () => {
  it("E7 case 1: old value inside the key (retry1: 1)", () => {
    expect(out({ key: "retry1", old_value: "1", new_value: "9" }, "retry1: 1\n")).toBe("retry1: 9\n");
  });
  it("replaces the value after the key even when the key text contains the old value elsewhere on the line", () => {
    expect(out({ key: "x5", old_value: "5", new_value: "6" }, "x5 = 5\n")).toBe("x5 = 6\n");
  });
});

describe("config_value: comment lines are not config", () => {
  it("E7 case 2: a comment that mentions the key and old value above the real line is left alone, the real line is refused or edited, never the comment", () => {
    const r = out({}, "# port: 80 is default\nport: 90\n");
    expect(r).not.toContain("# port: 81");
    expect(r.startsWith("REFUSED")).toBe(true);
  });
  it("edits the live line when the comment above it has the same key and value", () => {
    expect(out({}, "# port: 80 was the old default\nport: 80\n")).toBe("# port: 80 was the old default\nport: 81\n");
  });
  it("skips //, /* and * comment lines and ; lines", () => {
    for (const c of ["// port: 80", "/* port: 80 */", " * port: 80", "; port=80", "  # port: 80"]) {
      expect(out({}, `${c}\nport: 80\n`)).toBe(`${c}\nport: 81\n`);
    }
  });
  it("a file whose only match is a comment is refused", () => {
    expect(out({}, "// port: 80\n").startsWith("REFUSED")).toBe(true);
  });
  it("a trailing comment after the value is left alone", () => {
    expect(out({}, "port: 80 # was 80 before\n")).toBe("port: 81 # was 80 before\n");
  });
});

describe("config_value: the key is a whole word", () => {
  it("a longer name that contains the key is not the key (report_dir, support)", () => {
    expect(out({ old_value: "1", new_value: "2" }, "report_dir: 1\nsupport: 1\nport: 1\n")).toBe("report_dir: 1\nsupport: 1\nport: 2\n");
  });
  it("still matches code-style and dotted keys", () => {
    expect(out({ key: "timeout", old_value: "30", new_value: "60" }, "const timeout = 30;\n")).toBe("const timeout = 60;\n");
    expect(out({}, "server.port = 80\n")).toBe("server.port = 81\n");
    expect(out({}, '{"port": 80}\n')).toBe('{"port": 81}\n');
  });
  it("a key with a hyphen is not cut at the hyphen", () => {
    expect(out({ old_value: "1", new_value: "2" }, "port-forward: 1\n").startsWith("REFUSED")).toBe(true);
  });
  it("a value that only appears in a longer name is not the value of the key", () => {
    expect(out({ key: "max", old_value: "5", new_value: "6" }, "max_retries = 5\n").startsWith("REFUSED")).toBe(true);
  });
});

describe("config_value: replay must not apply twice", () => {
  it("E7: 5 -> 50 applied a second time is refused, not turned into 500", () => {
    const once = out({ key: "max", old_value: "5", new_value: "50" }, "max = 5\n");
    expect(once).toBe("max = 50\n");
    const twice = out({ key: "max", old_value: "5", new_value: "50" }, once);
    expect(twice.startsWith("REFUSED")).toBe(true);
    expect(twice).toMatch(/already/i);
  });
  it("applies normally when the new value merely appears elsewhere on the line", () => {
    expect(out({ key: "max", old_value: "5", new_value: "50" }, "max = 5, other = 50\n")).toBe("max = 50, other = 50\n");
  });
});
