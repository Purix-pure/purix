// src/language/providers/python_stop_handling.test.ts
//
// F02-03 remainder (independent read, 2026-11-10): the direct Python call sites in python.ts (parse check), python.pack.ts
// (runtime probe) and verify/python_test_integrity.ts were not traced for what they do when the interpreter does not answer.
// Traced by reading, and reproduced here with a stand-in `python`/`python3` that never exits:
//   - None reads a stop as a pass. A stopped parse check returns undefined ("could not check", the provider contract), a stopped
//     integrity analysis becomes a flag for a person, hooks/doctor.ts labels the stop and fails its canary, and the OpenCode plugin
//     blocks on any non-zero or missing status.
//   - But none named a time budget, so each got the default tier (T3, ten minutes). platform/spawn_sync.ts assigns the parse check
//     to T1 (ten seconds). One hung interpreter held every Purix command that parses Python for ten minutes per call, and the
//     integrity check started a fresh probe for each of the two reads of every changed test file.
//   - python.pack.ts reported a probe that was stopped as "Python runtime not found on PATH", the same wrong label F02-03 removed
//     elsewhere for a child that was stopped.
// Linux only (a POSIX stand-in). The stand-in sleeps 40 s; each fixed call is ended at the 10 s T1 deadline, so these tests take
// about 10 s each. Written first; all three failed against the old code (the old calls waited for the stand-in to finish).
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pythonProvider } from "./python.js";
import { pythonPack } from "./python.pack.js";
import { checkPythonTestIntegrity } from "../../verify/python_test_integrity.js";
import { safeRmSync } from "../../platform/fs_retry.js";

const unix = { skip: process.platform === "win32" ? "needs a POSIX shell" : false };

let root: string;
let savedPath: string | undefined;

function hangingPython(names: string[]) {
  const bin = join(root, "bin");
  mkdirSync(bin, { recursive: true });
  for (const n of names) {
    const p = join(bin, n);
    writeFileSync(p, "#!/bin/sh\nexec /bin/sleep 40\n");
    chmodSync(p, 0o755);
  }
  // PATH holds only the stand-ins (the script names /bin/sh and /bin/sleep by absolute path), so no real python on this machine answers.
  process.env.PATH = bin;
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "purix-pystop-")));
  savedPath = process.env.PATH;
});
afterEach(() => {
  process.env.PATH = savedPath;
  safeRmSync(root);
});

describe("Python call sites when the interpreter never answers", () => {
  it("parse check: gives up inside its T1 budget and says 'could not check' (undefined), not pass and not a syntax error", unix, () => {
    hangingPython(["python3"]);
    const t0 = Date.now();
    const r = pythonProvider.parseCheck!("a.py", "def f(:\n  pass\n");
    const ms = Date.now() - t0;
    expect(r).toBeUndefined();
    expect(ms).toBeLessThan(25_000);
  });

  it("runtime probe: a probe that was stopped is not reported as 'not found on PATH'", unix, () => {
    hangingPython(["python"]);
    const t0 = Date.now();
    const r = pythonPack.checkRuntimePresent(root);
    const ms = Date.now() - t0;
    expect(r.present).toBe(false);
    expect(r.message ?? "").not.toMatch(/not found on PATH/i);
    expect(r.message ?? "").toMatch(/did not answer|stopped/i);
    expect(ms).toBeLessThan(25_000);
  });

  it("test integrity: a changed Python test file is flagged for a person (never passed), inside the T1 budget, with one probe per call", unix, () => {
    hangingPython(["python3", "python"]);
    const t0 = Date.now();
    const res = checkPythonTestIntegrity(
      [{ path: "tests/test_a.py", content: "def test_a():\n    assert 1 == 1\n" }],
      [{ path: "tests/test_a.py", content: "def test_a():\n    pass\n" }],
    );
    const ms = Date.now() - t0;
    expect(res.findings.length).toBe(1);
    expect(res.findings[0]!.path).toBe("tests/test_a.py");
    // Two reads of the file used to mean two probes of 40 s and two analyses of 40 s. Now one probe, ended at 10 s, covers both reads.
    expect(ms).toBeLessThan(25_000);
  });
});
