// A3-1 (research 04): a diff that adds a file must produce the file as the diff describes it. 60 of 64 added files lost their final
// newline: the new file's lines were joined with "\n" and nothing put the last one back. The "\ No newline at end of file" marker
// is the diff's own way of saying the file really has none.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ingestDiff } from "./ingest";
import { safeRmSync } from "../platform/fs_retry.js";

describe("ingestDiff: added files", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-ingest-add-"));
  });
  afterEach(() => safeRmSync(dir));

  const added = async (diff: string) => {
    const r = await ingestDiff(diff, null, dir);
    if (!r.ok) throw new Error(r.reason);
    return r.files;
  };

  it("an added file ends with the newline the diff gives it", async () => {
    const files = await added("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+export const a = 1;\n+export const b = 2;\n");
    expect(files).toEqual([{ path: "src/new.ts", new_content: "export const a = 1;\nexport const b = 2;\n", status: "added" }]);
  });

  it("an added file the diff marks as having no final newline has none", async () => {
    const files = await added("--- /dev/null\n+++ b/src/new.ts\n@@ -0,0 +1,2 @@\n+one\n+two\n\\ No newline at end of file\n");
    expect(files[0]!.new_content).toBe("one\ntwo");
  });

  it("an added empty file is accepted and is empty", async () => {
    const files = await added("diff --git a/empty.txt b/empty.txt\nnew file mode 100644\n--- /dev/null\n+++ b/empty.txt\n");
    expect(files).toEqual([{ path: "empty.txt", new_content: "", status: "added" }]);
  });
});
