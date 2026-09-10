// src/llm/circuit.test.ts
//
// Verifies the review finding #3 fix for circuit.ts: state now lives as a
// single SQLite row with an atomic CASE-based UPDATE, instead of a
// read-mutate-write JSON file. Confirms the threshold still trips at
// exactly 5, not 4 or 6 (the original report's own assertion), and that
// the atomic increment doesn't lose failures across sequential calls.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb } from "../manifest/store";
import { assertCircuitClosed, recordCircuitFailure, recordCircuitSuccess } from "./circuit";

let originalCwd: string;
let tmpDir: string;

beforeEach(() => {
  originalCwd = process.cwd();
  tmpDir = mkdtempSync(join(tmpdir(), "purix-circuit-test-"));
  process.chdir(tmpDir);
});

afterEach(() => {
  closeDb();
  process.chdir(originalCwd);
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("circuit breaker state (SQLite-backed)", () => {
  it("stays closed under the failure threshold", () => {
    for (let i = 0; i < 4; i++) recordCircuitFailure();
    expect(() => assertCircuitClosed()).not.toThrow();
  });

  it("opens at exactly 5 consecutive failures, not 4 or 6", () => {
    for (let i = 0; i < 4; i++) recordCircuitFailure();
    expect(() => assertCircuitClosed()).not.toThrow(); // still closed at 4
    recordCircuitFailure(); // 5th failure
    expect(() => assertCircuitClosed()).toThrow(/Circuit breaker open/);
  });

  it("resets to closed on recordCircuitSuccess after prior failures", () => {
    for (let i = 0; i < 5; i++) recordCircuitFailure();
    expect(() => assertCircuitClosed()).toThrow();
    recordCircuitSuccess();
    expect(() => assertCircuitClosed()).not.toThrow();
  });
});