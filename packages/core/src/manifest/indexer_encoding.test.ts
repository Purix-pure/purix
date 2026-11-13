// src/manifest/indexer_encoding.test.ts
//
// H4 (byte-order mark, line endings): a file saved by Windows editors often starts with a UTF-8 byte-order mark (U+FEFF) and uses
// CRLF line endings. Python reads both fine. The Python symbol regex is anchored at a line start, and the mark sits in front of
// the first line, so the first symbol of such a file was not recorded. Found by reading `extractSymbols`; this test reproduces it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runIndex } from "./indexer";
import { closeDb } from "./store";
import { safeRmSync } from "../platform/fs_retry.js";

let originalCwd: string;
let tmp: string;
beforeEach(() => {
  originalCwd = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "purix-index-enc-"));
  process.chdir(tmp);
});
afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  safeRmSync(tmp);
});
const names = (r: Awaited<ReturnType<typeof runIndex>>) => r.components.map((c) => c.symbol_name).sort();

describe("purix index: byte-order mark and CRLF", () => {
  it("records the first Python symbol when the file starts with a byte-order mark", async () => {
    writeFileSync(join(tmp, "m.py"), "\uFEFFdef first():\n    return 1\n\ndef second():\n    return 2\n");
    expect(names(await runIndex(tmp))).toEqual(["first", "second"]);
  });
  it("records every Python symbol in a CRLF file with a byte-order mark", async () => {
    writeFileSync(join(tmp, "m.py"), "\uFEFFclass A:\r\n    pass\r\n\r\ndef b():\r\n    return 1\r\n");
    expect(names(await runIndex(tmp))).toEqual(["A", "b"]);
  });
  it("records TypeScript exports in a CRLF file with a byte-order mark", async () => {
    writeFileSync(join(tmp, "m.ts"), "\uFEFFexport function a() {}\r\nexport const b = 1;\r\n");
    expect(names(await runIndex(tmp))).toEqual(["a", "b"]);
  });
});
