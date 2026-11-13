// packages/mcp-server/src/stdout_guard.test.ts
//
// The MCP stdio rule: nothing but protocol messages on stdout. While a tool call runs, console methods that
// write to stdout are diverted to stderr. These tests pin the two properties the old per-call save/restore
// lacked: overlapping calls, and console.info / console.debug.
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { stdoutDiversionDepth, withStdoutDiverted } from "./stdout_guard.js";

const REAL = { log: console.log, info: console.info, debug: console.debug, warn: console.warn };
const tick = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

describe("withStdoutDiverted", () => {
  beforeEach(() => {
    assert.equal(stdoutDiversionDepth(), 0);
  });
  afterEach(() => {
    Object.assign(console, REAL); // never leave a test's patch behind, whatever happened
  });

  it("restores the exact original console methods after one call", async () => {
    await withStdoutDiverted(async () => {
      assert.notEqual(console.log, REAL.log);
    });
    assert.equal(console.log, REAL.log);
    assert.equal(console.info, REAL.info);
    assert.equal(console.debug, REAL.debug);
    assert.equal(console.warn, REAL.warn);
  });

  it("restores after a call that throws", async () => {
    await assert.rejects(
      withStdoutDiverted(async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.equal(console.log, REAL.log);
    assert.equal(stdoutDiversionDepth(), 0);
  });

  it("diverts log, info, debug and warn to stderr", async () => {
    const seen: string[] = [];
    const realError = console.error;
    console.error = (...a: unknown[]) => void seen.push(a.join(" "));
    try {
      await withStdoutDiverted(async () => {
        console.log("L");
        console.info("I");
        console.debug("D");
        console.warn("W");
      });
    } finally {
      console.error = realError;
    }
    assert.deepEqual(seen, ["L", "I", "D", "W"]);
  });

  it("overlapping calls: the first to finish does not restore console while the second is still running", async () => {
    let secondSawDiverted = false;
    const a = withStdoutDiverted(async () => {
      await tick(10);
    });
    const b = withStdoutDiverted(async () => {
      await tick(60);
      secondSawDiverted = console.log !== REAL.log; // A finished at ~10ms; B must still be diverted
    });
    await Promise.all([a, b]);
    assert.equal(secondSawDiverted, true);
    assert.equal(console.log, REAL.log, "the real console.log is back once both are done");
    assert.equal(stdoutDiversionDepth(), 0);
  });

  it("overlapping calls: the real function is never mistaken for a patched one and left in place", async () => {
    const a = withStdoutDiverted(async () => tick(40));
    await tick(5);
    const b = withStdoutDiverted(async () => tick(5)); // enters while A is active, leaves first
    await Promise.all([a, b]);
    assert.equal(console.log, REAL.log);
    assert.equal(console.info, REAL.info);
  });

  it("nested calls (purix_change calling purix_modify) restore only at the outermost exit", async () => {
    await withStdoutDiverted(async () => {
      await withStdoutDiverted(async () => {
        assert.equal(stdoutDiversionDepth(), 2);
      });
      assert.notEqual(console.log, REAL.log, "still diverted after the inner call");
    });
    assert.equal(console.log, REAL.log);
  });

  // The old pattern, kept here as a replica so the test above demonstrably fails on it.
  it("the old save/restore pattern breaks on overlap (replica, documents why the guard exists)", async () => {
    async function oldStyle(ms: number): Promise<boolean> {
      const origLog = console.log;
      console.log = (...a: unknown[]) => console.error(...a);
      try {
        await tick(ms);
        return console.log !== REAL.log;
      } finally {
        console.log = origLog;
      }
    }
    const first = oldStyle(10);
    const second = oldStyle(60);
    const [, secondStillDiverted] = await Promise.all([first, second]);
    // After the first finished it put back its "original", which is the real log: the second ran undiverted,
    // and when it finished it restored the FIRST call's patched function, leaving console.log patched for good.
    assert.equal(secondStillDiverted, false);
    assert.notEqual(console.log, REAL.log);
  });
});
