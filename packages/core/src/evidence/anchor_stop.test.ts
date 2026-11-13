// src/evidence/anchor_stop.test.ts
//
// N3 follow-up (F02-03): findAnchorInGit read `exitCode === null` from git as "git is not installed", and any failing `git log` as "no
// commits yet". A git that a signal ended or that timed out is neither. whyGitDidNotRun words each case; real git is used for the end to end test.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { whyGitDidNotRun, findAnchorInGit } from "./anchor.js";

describe("whyGitDidNotRun", () => {
  it("a normal exit gives nothing, whatever its code", () => {
    expect(whyGitDidNotRun({ exitCode: 0 })).toBeUndefined();
    expect(whyGitDidNotRun({ exitCode: 128 })).toBeUndefined();
  });
  it("no exit code and no marker: git is not installed (as before)", () => {
    expect(whyGitDidNotRun({ exitCode: null })).toMatch(/not installed/);
  });
  it("not_found and spawn_error: not installed / could not start", () => {
    expect(whyGitDidNotRun({ exitCode: null, stopped: "not_found" })).toMatch(/not installed/);
    expect(whyGitDidNotRun({ exitCode: null, stopped: "spawn_error" })).toMatch(/could not be started/);
  });
  it("a signal is named and is NOT 'not installed'", () => {
    const why = whyGitDidNotRun({ exitCode: null, stopped: "signal", signal: "SIGKILL" });
    expect(why).toContain("SIGKILL");
    expect(why).not.toMatch(/not installed/);
  });
  it("a timeout or output overflow is said to be stopped, not 'not installed'", () => {
    for (const stopped of ["timeout", "output_limit", "resource_limit"] as const) {
      const why = whyGitDidNotRun({ exitCode: null, stopped });
      expect(why).toMatch(/did not finish/);
      expect(why).not.toMatch(/not installed/);
    }
  });
});

describe("findAnchorInGit end to end", () => {
  it("a folder that is not a repository is still said to be so (control)", () => {
    const d = mkdtempSync(join(tmpdir(), "purix-anchor-stop-"));
    try {
      const r = findAnchorInGit(d);
      expect(r.found).toBe(false);
      if (!r.found) expect(r.reason).toMatch(/not a git repository/);
    } finally { rmSync(d, { recursive: true, force: true }); }
  });
});
