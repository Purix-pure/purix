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

  it("throws immediately on non-busy errors", () => {
    expect(() => {
      withSqliteRetry(() => {
        throw new Error("syntax error");
      }, "test");
    }).toThrow(/syntax error/);
  });
});
