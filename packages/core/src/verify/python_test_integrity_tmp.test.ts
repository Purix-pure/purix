// packages/core/src/verify/python_test_integrity_tmp.test.ts
//
// H3 (catalogue, "randomness"): the Python test-integrity check wrote the Python it then RUNS to
// `<tmpdir>/purix-py-script-<Math.random()>.py` in the shared temp folder. The name came from Math.random, which is not secret, and the
// file sat in a folder other local users can write to, between being written and being read by python. (The write is an atomic rename,
// so a pre-planted symlink is already replaced rather than followed; what was left is the window and the guessable name.)
// Not reproduced as an attack: no second user or race was set up here. What is shown is where the files are put. A stand-in `python3`
// on PATH records where it was asked to read from; Linux only.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync, readdirSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { checkPythonTestIntegrity } from "./python_test_integrity.js";
import { safeRmSync } from "../platform/fs_retry.js";

const unix = { skip: process.platform === "win32" ? "needs a POSIX shell" : false };

let root: string;
let tmp: string;
let savedPath: string | undefined;
let savedTmpdir: string | undefined;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(realpathSync(tmpdir()), "purix-pyint-")));
  tmp = join(root, "tmp");
  mkdirSync(tmp);
  mkdirSync(join(root, "bin"));
  savedPath = process.env.PATH;
  savedTmpdir = process.env.TMPDIR;
});
afterEach(() => {
  process.env.PATH = savedPath;
  if (savedTmpdir === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = savedTmpdir;
  safeRmSync(root);
});

function standIn(): { log: string } {
  const bin = join(root, "bin");
  const log = join(root, "calls.log");
  // Answers `--version`; for a script run it records the script path, its folder's mode, and replies with a valid profile.
  const sh = `#!/bin/sh
if [ "$1" = "--version" ]; then echo "Python 3.12.0"; exit 0; fi
d=$(dirname "$1")
echo "$1|$d|$(stat -c %a "$d")" >> "${log}"
echo '{"assertionCount":1,"assertionTargets":[],"skipCount":0,"weakeners":{}}'
`;
  for (const name of ["python3", "python"]) { writeFileSync(join(bin, name), sh); chmodSync(join(bin, name), 0o755); }
  return { log };
}

describe("python test integrity: where the temporary files go", unix, () => {
  it("runs python on a script inside a private, freshly made folder, not directly in the shared temp folder", () => {
    const { log } = standIn();
    process.env.PATH = `${join(root, "bin")}:${savedPath}`;
    process.env.TMPDIR = join(root, "tmp");
    const before = [{ path: "tests/test_a.py", content: "def test_a():\n    assert 1 == 1\n" }];
    const after = [{ path: "tests/test_a.py", content: "def test_a():\n    assert 1 == 1\n    assert 2 == 2\n" }];
    checkPythonTestIntegrity(before, after);
    expect(existsSync(log)).toBe(true);
    const lines = readFileSync(log, "utf-8").trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const [script, folder, mode] = line.split("|") as [string, string, string];
      expect(dirname(script)).toBe(folder);
      expect(folder).not.toBe(join(root, "tmp")); // not the shared folder itself
      expect(dirname(folder)).toBe(join(root, "tmp")); // a folder made inside it for this call
      expect(mode).toBe("700"); // only the owner can write or list it
    }
  });

  it("leaves nothing behind in the temp folder afterwards", () => {
    standIn();
    process.env.PATH = `${join(root, "bin")}:${savedPath}`;
    process.env.TMPDIR = join(root, "tmp");
    checkPythonTestIntegrity(
      [{ path: "tests/test_a.py", content: "def test_a():\n    assert 1 == 1\n" }],
      [{ path: "tests/test_a.py", content: "def test_a():\n    assert 1 == 1\n    assert 2 == 2\n" }]
    );
    expect(readdirSync(join(root, "tmp"))).toEqual([]);
  });
});
