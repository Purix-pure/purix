// src/verify/anchor_match_eol_bom.test.ts
//
// H4 (line endings, byte-order mark), research 04: an edit that anchors on ONE line of a CRLF file and replaces it with several
// lines wrote bare LF into the file, leaving mixed line endings. And a UTF-8 byte-order mark in front of line 1 made an edit of
// line 1 look like a partial-line edit. Both reproduced with a probe before these tests were written.
import { describe, it } from "node:test";
import { expect } from "expect";
import { matchAnchor } from "./anchor_match";

describe("matchAnchor: replacement line endings follow the file", () => {
  it("a one-line anchor with a multi-line replacement in a CRLF file writes CRLF, never bare LF", () => {
    const r = matchAnchor("a = 1\r\nb = 2\r\nc = 3\r\n", "b = 2", "b = 2\nb2 = 3", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a = 1\r\nb = 2\r\nb2 = 3\r\nc = 3\r\n");
  });
  it("an anchor that itself contains CRLF keeps a multi-line replacement in CRLF", () => {
    const r = matchAnchor("a = 1\r\nb = 2\r\nc = 3\r\n", "b = 2\r\nc = 3", "b = 9\nc = 4", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a = 1\r\nb = 9\r\nc = 4\r\n");
  });
  it("an LF file stays LF", () => {
    const r = matchAnchor("a = 1\nb = 2\n", "b = 2", "b = 2\nb2 = 3", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a = 1\nb = 2\nb2 = 3\n");
  });
  it("a mixed file: an LF-only anchor region keeps LF", () => {
    const r = matchAnchor("a = 1\r\nb = 2\nc = 3\r\n", "b = 2\nc = 3", "b = 9\nc = 3", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.content).toBe("a = 1\r\nb = 9\nc = 3\r\n");
  });
});

describe("matchAnchor: a byte-order mark is not part of line 1", () => {
  it("editing the whole first line of a BOM file is not a partial-line edit, and the mark is kept", () => {
    const r = matchAnchor("﻿x = 1\ny = 2\n", "x = 1", "x = 5", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.content).toBe("﻿x = 5\ny = 2\n");
      expect(r.partialLine).toBeUndefined();
    }
  });
  it("a real partial-line edit on line 1 of a BOM file is still flagged", () => {
    const r = matchAnchor("﻿x = 1 + 2\n", "1 + 2", "3", "x.py");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.partialLine).toBe(true);
  });
});
