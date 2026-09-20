// src/llm/sqlite_retry.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { withSqliteRetry } from "./sqlite_retry";

describe("SQLite Retry with Backoff", () => {
  it("returns successfully on first attempt when no error is thrown", () => {
    const res = withSqliteRetry(() => "success", "test");
    expect(res).toBe("success");
  });

  it("retries on SQLITE_BUSY and succeeds eventually", () => {
    let attempts = 0;
    const res = withSqliteRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_BUSY: database is locked");
      }
      return "recovered";
    }, "test");

    expect(res).toBe("recovered");
    expect(attempts).toBe(3);
  });

  // Regression test for the bug this file's isRetryableSqliteError()
  // comment documents: budget_worktree.test.ts observed a real
  // "disk I/O error" (SQLITE_IOERR) escaping unretried under WAL-mode
  // contention, because the old regex only matched SQLITE_BUSY/"database
  // is locked".
  it("retries on SQLITE_IOERR (disk I/O error) and succeeds eventually", () => {
    let attempts = 0;
    const res = withSqliteRetry(() => {
      attempts++;
      if (attempts < 3) {
        throw new Error("SQLITE_IOERR: disk I/O error");
      }
      return "recovered";
    }, "test");

    expect(res).toBe("recovered");
    expect(attempts).toBe(3);
  });

  it("gives up with SqliteRetryExhaustedError when contention never clears", () => {
    expect(() => {
      withSqliteRetry(() => {
        throw new Error("disk I/O error");
      }, "test");
    }).toThrow(/still busy after 5 attempts/);
  });

  it("throws immediately on non-busy errors", () => {
    expect(() => {
      withSqliteRetry(() => {
        throw new Error("syntax error");
      }, "test");
    }).toThrow(/syntax error/);
  });
});
