// F03-05: the gate judges what a change introduces, and does not read prose files as JavaScript.
// Research 03, tasks 1.1 (option C: scan old and new, block only findings that are new) and 1.2 (rules by file type).
import { describe, it } from "node:test";
import { expect } from "expect";
import { runSecurityGate } from "./security_gate";
import { getOverrideAudits } from "../security/override_audit";
import { isolateCwdForFile } from "../test-support/isolated_cwd.js";

isolateCwdForFile();

const OLD = "exec(cmd, cb);\n";

describe("F03-05: prose and text files are not read as JavaScript", () => {
  for (const path of ["README.md", "docs/guide.markdown", "docs/api.mdx", "notes.txt", "docs/howto.rst"]) {
    it(`${path}: an example call in the text does not block`, () => {
      const r = runSecurityGate([{ path, content: "# Usage\n\n```js\nexec(userCmd, cb)\ndb.query(\"SELECT * FROM t WHERE a = \" + x);\n```\n" }]);
      expect(r.blocked).toBe(false);
      expect(r.findings).toEqual([]);
    });
  }

  it("a real secret in a prose file still blocks", () => {
    const r = runSecurityGate([{ path: "README.md", content: 'Set the key: const awsKey = "AKIAIOSFODNN7EXAMPLE";\n' }]);
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === "Hardcoded Secret")).toBe(true);
  });

  it("code files and unknown types are still read with the code rules", () => {
    for (const path of ["src/a.ts", "src/a.js", "page.html", "src/a.py", "Makefile"]) {
      const r = runSecurityGate([{ path, content: 'eval("x" + y);\n' }]);
      expect(r.blocked).toBe(true);
    }
  });

  it("a shell script is read by the shell rules (C4 follow-up): JavaScript syntax in it is not code, an eval of a variable is", () => {
    expect(runSecurityGate([{ path: "tools/run.sh", content: 'eval "$y"\n' }]).blocked).toBe(true);
    expect(runSecurityGate([{ path: "tools/run.sh", content: 'eval("x" + y);\n' }]).blocked).toBe(false);
  });
});

describe("F03-05: only findings the change introduces block", () => {
  it("an unrelated edit to a file that already has a finding passes, and the old finding is reported as advisory", () => {
    const r = runSecurityGate([{ path: "src/a.ts", base: OLD, content: OLD + "export const version = 2;\n" }]);
    expect(r.blocked).toBe(false);
    expect(r.ok).toBe(true);
    const old = r.findings.filter((f) => f.category === "Command/Code Injection");
    expect(old.length).toBeGreaterThan(0);
    for (const f of old) {
      expect(f.severity).toBe("Low");
      expect(f.message).toContain("Pre-existing, not blocking");
    }
  });

  it("without a base the file is judged whole, as before", () => {
    const r = runSecurityGate([{ path: "src/a.ts", content: OLD + "export const version = 2;\n" }]);
    expect(r.blocked).toBe(true);
  });

  it("a second copy of the same finding is new and blocks", () => {
    const r = runSecurityGate([{ path: "src/a.ts", base: OLD, content: OLD + OLD }]);
    expect(r.blocked).toBe(true);
    expect(r.findings.filter((f) => f.severity === "Critical").length).toBeGreaterThan(0);
  });

  it("a different finding in the same file blocks, and the old one stays advisory", () => {
    const r = runSecurityGate([{ path: "src/a.ts", base: OLD, content: OLD + 'db.query("SELECT * FROM u WHERE id = " + id);\n' }]);
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === "SQL Injection" && f.severity === "Critical")).toBe(true);
  });

  it("an edit that changes the flagged line itself is a new finding and blocks", () => {
    const r = runSecurityGate([{ path: "src/a.ts", base: OLD, content: "exec(otherCmd, cb);\n" }]);
    expect(r.blocked).toBe(true);
  });

  it("moving or re-indenting the flagged line does not make it new", () => {
    const moved = runSecurityGate([{ path: "src/a.ts", base: OLD + "const a = 1;\n", content: "const a = 1;\n\n    exec(cmd,   cb);\n" }]);
    expect(moved.blocked).toBe(false);
    expect(moved.findings.some((f) => f.message.includes("Pre-existing"))).toBe(true);
  });

  it("a secret already in the file still blocks: secrets are never forgiven as old", () => {
    const secret = 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n';
    const r = runSecurityGate([{ path: "src/a.ts", base: secret, content: secret + "export const v = 1;\n" }]);
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.category === "Hardcoded Secret" && f.severity === "Critical")).toBe(true);
  });

  it("each file is compared with its own base", () => {
    const r = runSecurityGate([
      { path: "src/a.ts", base: OLD, content: OLD + "export const v = 1;\n" },
      { path: "src/b.ts", base: "export const b = 1;\n", content: OLD },
    ]);
    expect(r.blocked).toBe(true);
    expect(r.findings.some((f) => f.severity === "Critical" && f.path === "src/b.ts")).toBe(true);
    expect(r.findings.some((f) => f.severity === "Critical" && f.path === "src/a.ts")).toBe(false);
  });

  it("the comparison scan does not spend or record an override: one override, one audit entry", () => {
    const before = getOverrideAudits().length;
    const r = runSecurityGate(
      [{ path: "src/a.ts", base: OLD, content: OLD + 'db.query("SELECT * FROM u WHERE id = " + id);\n' }],
      "reviewed by hand"
    );
    expect(r.blocked).toBe(false);
    expect(getOverrideAudits().length - before).toBe(1);
  });
});
