// src/cli/failure_text.test.ts
//
// H5: the line printed after "🛑" for a failed command. A full disk gets the full-disk sentence with the original text kept
// after it for diagnosis; every other message passes through unchanged.
import { test } from "node:test";
import { expect } from "expect";
import { failureMessage } from "./failure_text";
import { DISK_FULL_SENTENCE } from "@purix/core/platform/disk_full";
import { DATABASE_BUSY_SENTENCE } from "@purix/core/platform/db_busy";

const FULL = () => 0;
const ROOMY = () => 100 * 1024 * 1024;

test("ENOSPC gets the full-disk sentence and keeps the original text", () => {
  const m = failureMessage(new Error("ENOSPC: no space left on device, write"), ["/p"], ROOMY);
  expect(m.startsWith(DISK_FULL_SENTENCE)).toBe(true);
  expect(m).toContain("ENOSPC: no space left on device, write");
});

test("a bare 'disk I/O error' is a full disk only when a checked directory is nearly full", () => {
  expect(failureMessage(new Error("disk I/O error"), ["/p", "/h"], FULL).startsWith(DISK_FULL_SENTENCE)).toBe(true);
  expect(failureMessage(new Error("disk I/O error"), ["/p", "/h"], ROOMY)).toBe("disk I/O error");
});

test("any other message and any non-Error value pass through unchanged", () => {
  expect(failureMessage(new Error("No Purix state here yet."), ["/p"], FULL)).toBe("No Purix state here yet.");
  expect(failureMessage("plain string", ["/p"], FULL)).toBe("plain string");
});

test("a lock held by another Purix process gets the wait-and-retry sentence, original text kept, never 'damaged'", () => {
  const m = failureMessage(new Error("database is locked"), ["/p"], () => 100 * 1024 * 1024);
  expect(m.startsWith(DATABASE_BUSY_SENTENCE)).toBe(true);
  expect(m).toContain("database is locked");
  expect(m).not.toMatch(/damag/i);
});
