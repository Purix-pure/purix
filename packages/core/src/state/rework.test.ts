import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { reworkWithin, reworkOfChange, parseGitReverts, readGitReverts, GIT_LOG_FORMAT } from "./rework.js";
import { safeRmSync } from "../platform/fs_retry.js";

const day = (n: number) => new Date(Date.UTC(2026, 10, 1 + n)).toISOString();
const row = (kind: string, component: string, at: string, event = "component_change") => ({ payload: JSON.stringify({ event, kind, component_id: component }), timestamp: at });
const ASOF = new Date(Date.UTC(2026, 11, 31));

describe("reworkWithin", () => {
  it("counts a change as reworked when the same component changed again inside 14 days", () => {
    const r = reworkWithin([row("modify", "a", day(0)), row("modify", "a", day(5)), row("modify", "b", day(1))], ASOF);
    // a@0 reworked by a@5; a@5 and b@1 are not
    expect(r).toEqual({ windowDays: 14, considered: 3, reworked: 1, tooRecent: 0 });
  });

  it("a later change outside the window, or on another component, is not rework", () => {
    const r = reworkWithin([row("modify", "a", day(0)), row("modify", "a", day(20)), row("modify", "b", day(2))], ASOF);
    expect(r.reworked).toBe(0);
    expect(r.considered).toBe(3);
  });

  it("the window edge: exactly 14 days later counts, 14 days and a second does not", () => {
    expect(reworkWithin([row("modify", "a", day(0)), row("modify", "a", day(14))], ASOF).reworked).toBe(1);
    expect(reworkWithin([row("modify", "a", day(0)), row("modify", "a", new Date(Date.parse(day(14)) + 1000).toISOString())], ASOF).reworked).toBe(0);
  });

  it("changes whose window has not closed yet are left out of both numbers", () => {
    const r = reworkWithin([row("modify", "a", day(0)), row("modify", "b", day(50))], new Date(Date.parse(day(55))));
    expect(r).toEqual({ windowDays: 14, considered: 1, reworked: 0, tooRecent: 1 });
  });

  it("adopt and delete are not judged; a delete after a modify counts as touching it again", () => {
    const r = reworkWithin([row("adopt", "a", day(0)), row("modify", "a", day(1)), row("delete", "a", day(3))], ASOF);
    expect(r).toEqual({ windowDays: 14, considered: 1, reworked: 1, tooRecent: 0 });
  });

  it("ignores other chain records and unreadable rows; a different window is respected", () => {
    const rows = [{ payload: "nope", timestamp: day(0) }, row("modify", "a", day(0), "approval"), row("modify", "a", day(0)), row("modify", "a", day(5))];
    expect(reworkWithin(rows, ASOF, 3).reworked).toBe(0);
    expect(reworkWithin(rows, ASOF, 7).reworked).toBe(1);
  });
});

const rec = (sha: string, secs: number, subject: string, body = "") => `${sha}\x1f${secs}\x1f${subject}\x1f${body}\x1e\n`;
const SHA1 = "a".repeat(40);
const SHA2 = "b".repeat(40);
const SHA3 = "c".repeat(40);

describe("parseGitReverts", () => {
  it("finds what `git revert` writes and ignores a commit that only mentions the word", () => {
    const log = rec(SHA1, 1_700_000_000, 'Revert "add parser"', `This reverts commit ${SHA2}.\n`) + rec(SHA3, 1_700_000_100, "document how to revert a deploy") + rec(SHA2, 1_699_999_000, "add parser");
    const r = parseGitReverts(log);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ sha: SHA1, subject: 'Revert "add parser"', reverts: SHA2, at: new Date(1_700_000_000 * 1000).toISOString() });
  });

  it("a body line alone is enough, and garbage records are skipped", () => {
    const r = parseGitReverts(rec(SHA1, 1_700_000_000, "undo the thing", `This reverts commit ${SHA2}.`) + "junk\x1e" + rec("zz", 1, 'Revert "x"'));
    expect(r.map((x) => x.sha)).toEqual([SHA1]);
  });
});

describe("readGitReverts (real git)", () => {
  it("reads a real repository, and says not-checked outside one", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-rework-"));
    try {
      expect(readGitReverts(dir).state).toBe("not_checked");
      const git = (...a: string[]) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...a], { stdio: "pipe" });
      git("init", "-q");
      writeFileSync(join(dir, "f.txt"), "one\n");
      git("add", ".");
      git("commit", "-q", "-m", "first");
      writeFileSync(join(dir, "f.txt"), "two\n");
      git("commit", "-q", "-am", "second");
      git("revert", "--no-edit", "HEAD");
      const r = readGitReverts(dir);
      expect(r.state).toBe("ok");
      if (r.state === "ok") {
        expect(r.commitsRead).toBe(3);
        expect(r.reverts).toHaveLength(1);
        expect(r.reverts[0]!.subject).toBe('Revert "second"');
        expect(r.reverts[0]!.reverts).toMatch(/^[0-9a-f]{40}$/);
      }
      expect(GIT_LOG_FORMAT).toContain("%H");
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("reworkOfChange (one change, for its receipt)", () => {
  const rows = [row("modify", "a", day(0)), row("modify", "a", day(5)), row("create", "b", day(1))];

  it("says which later change touched the component and how many days later", () => {
    expect(reworkOfChange(rows, "a", "modify", day(0), ASOF)).toEqual({ state: "again", daysLater: 5, kind: "modify", windowDays: 14 });
  });

  it("agrees with reworkWithin: a change with no later one on its component has none in the window", () => {
    expect(reworkOfChange(rows, "a", "modify", day(5), ASOF)).toEqual({ state: "none_in_window", windowDays: 14 });
    expect(reworkOfChange(rows, "b", "create", day(1), ASOF)).toEqual({ state: "none_in_window", windowDays: 14 });
  });

  it("is never 'none' while the window is open: too recent to judge, with the closing time", () => {
    const asOf = new Date(Date.parse(day(10)));
    expect(reworkOfChange(rows, "b", "create", day(1), asOf)).toEqual({ state: "window_open", closesAt: day(15), windowDays: 14 });
  });

  it("does not judge adopt, delete or accepted drift, and says why", () => {
    for (const k of ["adopt", "delete", "accept_drift"]) {
      const r = reworkOfChange(rows, "a", k, day(0), ASOF);
      expect(r.state).toBe("not_judged");
    }
  });

  it("an unreadable landing time is not judged, not 'none'", () => {
    expect(reworkOfChange(rows, "a", "modify", "garbage", ASOF).state).toBe("not_judged");
  });

  it("a later change outside the window is not rework (14 days and one second)", () => {
    const late = [row("modify", "a", day(0)), row("modify", "a", new Date(Date.parse(day(14)) + 1000).toISOString())];
    expect(reworkOfChange(late, "a", "modify", day(0), ASOF).state).toBe("none_in_window");
  });
});
