// What `purix index` prints. Indexing records symbols and runs no compile and no test, so the summary must say "not verified"
// and must never use the words the old per-file verification printed ("did not pass verification", "[fail]").
import { describe, it } from "node:test";
import { expect } from "expect";
import { indexSummaryLines } from "./index";

describe("indexSummaryLines", () => {
  it("says indexed, not verified, and that nothing was compiled or tested", () => {
    const text = indexSummaryLines({ componentCount: 12, fileCount: 4, unsupportedFileCount: 0 }).join("\n");
    expect(text).toContain("Indexed 12 components across 4 files");
    expect(text).toContain("Indexed, not verified");
    expect(text).toContain("nothing was compiled or tested");
  });
  it("never claims a pass or a failure", () => {
    const text = indexSummaryLines({ componentCount: 1, fileCount: 1, unsupportedFileCount: 3 }).join("\n");
    expect(text).not.toMatch(/did not pass|\[fail\]|\[pass\]|verified successfully/i);
  });
  it("mentions files left out because no verifier exists for their language, only when there are some", () => {
    expect(indexSummaryLines({ componentCount: 1, fileCount: 1, unsupportedFileCount: 0 }).join("\n")).not.toContain("left out");
    expect(indexSummaryLines({ componentCount: 1, fileCount: 1, unsupportedFileCount: 2 }).join("\n")).toContain("2 file(s) in languages Purix has no verifier for were left out");
  });
  it("says the file list is a folder walk, with what that skips, only when it was one", () => {
    const walk = indexSummaryLines({ componentCount: 1, fileCount: 1, unsupportedFileCount: 0, fileListSource: "walk" }).join("\n");
    expect(walk).toContain("a folder walk");
    expect(walk).toContain("build and dist");
    const git = indexSummaryLines({ componentCount: 1, fileCount: 1, unsupportedFileCount: 0, fileListSource: "git" }).join("\n");
    expect(git).not.toContain("folder walk");
  });
});
