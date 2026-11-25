// Direct tests for the pure helpers that word "not tested", "not checked" and "the search was cut". They are small, and each
// sentence is something a person reads on a receipt, so each branch is pinned here.
import { describe, it } from "node:test";
import { expect } from "expect";
import {
  checkKindOfTestRun,
  checkKindOfVerification,
  isRepairEligibleKind,
  listFiles,
  notCheckedMessage,
  notTestedBadge,
  notTestedInline,
  notTestedMessage,
  notTestedValue,
  pendingNotTestedMessage,
  storedStatusLabel,
  testRunOutcome,
  verificationOutcome,
} from "./outcome.js";
import {
  changedFilesNotVouchedFor,
  detailSaysSearchCut,
  detailSearchCutFiles,
  detailSecurityNotes,
  searchCutDetail,
  securityNotesDetail,
  withCutNote,
} from "./discovery_cut.js";

describe("outcome kinds and labels", () => {
  it("maps test-run and verification statuses to a kind and an outcome", () => {
    expect(checkKindOfTestRun("pass")).toBe("pass");
    expect(checkKindOfTestRun("fail")).toBe("fail");
    expect(checkKindOfTestRun("no_tests")).toBe("no_tests_ran");
    expect(checkKindOfTestRun("not_installed")).toBe("infrastructure");
    expect(testRunOutcome("pass")).toBe("pass");
    expect(testRunOutcome("fail")).toBe("fail");
    expect(testRunOutcome("no_tests")).toBe("skipped");
    expect(testRunOutcome("not_installed")).toBe("error");
    expect(checkKindOfVerification({ status: "pass" })).toBe("pass");
    expect(checkKindOfVerification({ status: "not_installed" })).toBe("infrastructure");
    expect(checkKindOfVerification({ status: "fail" })).toBe("fail");
    expect(checkKindOfVerification({ status: "fail", infrastructure: "timeout" })).toBe("infrastructure");
    expect(isRepairEligibleKind("fail")).toBe(true);
    expect(isRepairEligibleKind("infrastructure")).toBe(false);
  });
  it("never reports a pass with unchecked or untested files as a pass", () => {
    expect(verificationOutcome({ status: "pass" })).toBe("pass");
    expect(verificationOutcome({ status: "pass", notTested: ["a.ts"] })).toBe("skipped");
    expect(verificationOutcome({ status: "pass", notChecked: ["a.go"] })).toBe("skipped");
    expect(verificationOutcome({ status: "fail" })).toBe("fail");
    expect(verificationOutcome({ status: "fail", infrastructure: "timeout" })).toBe("error");
    expect(verificationOutcome({ status: "not_installed" })).toBe("error");
  });
  it("words the gaps without ever saying clean or verified", () => {
    expect(listFiles(["a", "b", "a"])).toBe("a, b");
    expect(listFiles(["a", "b", "c", "d", "e", "f", "g"])).toBe("a, b, c, d, e and 2 more");
    expect(notTestedMessage(undefined)).toBeUndefined();
    expect(notTestedMessage(["a.ts"])).toContain("Not tested: no test is related to a.ts");
    expect(notTestedMessage(["a.ts"], { searchCut: true })).toContain("stopped at its file limit");
    const mixed = notTestedMessage(["a.ts", "b.py"], { searchCut: true, cutFiles: ["b.py"] })!;
    expect(mixed).toContain("no test is related to a.ts");
    expect(mixed).toContain("could be shown to cover b.py");
    expect(notCheckedMessage([])).toBeUndefined();
    expect(notCheckedMessage(["x.go"])).toContain("Nothing was compiled or tested");
    expect(notTestedInline(["a.ts"])!.startsWith("not tested")).toBe(true);
    expect(notTestedInline(undefined)).toBeUndefined();
    expect(pendingNotTestedMessage()).toContain("pending");
    expect(notTestedValue(["a", "a", "b"])).toBe("2 file(s)");
    expect(notTestedBadge(["a", "b"])).toBe("not tested: 2 file(s)");
    expect(notTestedBadge(["a", "b"], { searchCut: true })).toContain("stopped at its file limit");
    expect(notTestedBadge(["a", "b"], { searchCut: true, cutFiles: ["a"] })).toContain("for 1 of them");
    expect(storedStatusLabel("pending")).toBe("pending, not tested");
    expect(storedStatusLabel("pass")).toBe("pass");
  });
});

describe("cut-off test search records", () => {
  it("adds the note only when the search was cut", () => {
    expect(withCutNote("no test", false)).toBe("no test");
    expect(withCutNote("no test", true)).toContain("Note:");
  });
  it("stores and reads back the cut flag, the files it covered and the security notes", () => {
    expect(searchCutDetail({})).toEqual({});
    expect(searchCutDetail({ testSearchCut: true })).toEqual({ test_search_cut: true });
    expect(searchCutDetail({ testSearchCut: true, testSearchCutFiles: ["a.ts"] })).toEqual({ test_search_cut: true, test_search_cut_files: ["a.ts"] });
    expect(detailSaysSearchCut({ test_search_cut: true })).toBe(true);
    expect(detailSaysSearchCut({ test_search_cut: "yes" })).toBe(false);
    expect(detailSaysSearchCut(undefined)).toBe(false);
    expect(detailSearchCutFiles({ test_search_cut_files: ["a.ts"] })).toEqual(["a.ts"]);
    expect(detailSearchCutFiles({ test_search_cut_files: [] })).toBeUndefined();
    expect(detailSearchCutFiles(undefined)).toBeUndefined();
    const d = securityNotesDetail({ securityAdvisories: [{ path: "a.ts", line: 3, category: "Dependency Check" }], securityNotRead: [{ path: "README.md" }] });
    expect(d.security_advisories).toEqual([{ path: "a.ts", line: 3, category: "Dependency Check" }]);
    expect(d.security_not_read).toEqual(["README.md"]);
    expect(securityNotesDetail({})).toEqual({});
    const back = detailSecurityNotes({ ...d });
    expect(back.advisories[0]!.path).toBe("a.ts");
    expect(back.notRead[0]!.path).toBe("README.md");
    expect(detailSecurityNotes(undefined)).toEqual({ advisories: [], notRead: [] });
  });
  it("does not vouch for changed files when the search was cut", () => {
    expect(changedFilesNotVouchedFor({ truncated: true }, ["a"])).toEqual(["a"]);
    expect(changedFilesNotVouchedFor({ truncated: false }, ["a"])).toEqual([]);
    expect(changedFilesNotVouchedFor(undefined, ["a"])).toEqual([]);
  });
});
