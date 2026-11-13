// packages/core/src/security/savings_sync.test.ts
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { syncSavingsEvents, readSyncState, SYNC_BATCH_SIZE } from "./savings_sync";
import { ApiRequestError, ApiUnreachableError, type SavingsEventPayload } from "./api_client";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "purix-sync-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const makeEvents = (n: number): SavingsEventPayload["events"] =>
  Array.from({ length: n }, (_, i) => ({ localSeq: i + 1, occurredAt: "2026-10-08T00:00:00.000Z", callType: "escalation", deltaUsd: 0.01 }));

function deps(all: SavingsEventPayload["events"], send: (p: SavingsEventPayload) => Promise<{ ackedThroughSeq?: number }>) {
  return { baseDir: dir, machineId: "m1", listEventsAfter: (after: number, limit: number) => all.filter((e) => e.localSeq > after).slice(0, limit), send };
}

describe("savings event sync", () => {
  test("sends each event once, keyed by machine, random alias and local sequence, then sends nothing more", async () => {
    const all = makeEvents(3);
    const calls: SavingsEventPayload[] = [];
    const send = async (p: SavingsEventPayload) => (calls.push(p), {});
    expect(await syncSavingsEvents(deps(all, send))).toEqual({ status: "synced", sent: 3, lastAckedSeq: 3 });
    expect(calls[0]!.machineId).toBe("m1");
    expect(calls[0]!.projectAlias).toMatch(/^[0-9a-f-]{36}$/);
    expect(await syncSavingsEvents(deps(all, send))).toEqual({ status: "nothing_to_send" });
    expect(calls).toHaveLength(1);
  });

  test("a failed upload keeps the resume point and the retry sends only what was not acknowledged", async () => {
    const all = makeEvents(SYNC_BATCH_SIZE + 10);
    let n = 0;
    const flaky = async () => {
      if (++n === 2) throw new ApiUnreachableError(new Error("offline"));
      return {};
    };
    const first = await syncSavingsEvents(deps(all, flaky));
    expect(first.status).toBe("failed");
    expect(readSyncState(dir).lastAckedSeq).toBe(SYNC_BATCH_SIZE);
    const seen: number[] = [];
    await syncSavingsEvents(deps(all, async (p) => (seen.push(...p.events.map((e) => e.localSeq)), {})));
    expect(seen[0]).toBe(SYNC_BATCH_SIZE + 1);
    expect(seen).toHaveLength(10);
  });

  test("the alias stays the same across runs", async () => {
    const all = makeEvents(1);
    const aliases: string[] = [];
    await syncSavingsEvents(deps(all, async (p) => (aliases.push(p.projectAlias), {})));
    await syncSavingsEvents(deps(makeEvents(2), async (p) => (aliases.push(p.projectAlias), {})));
    expect(new Set(aliases).size).toBe(1);
  });

  test("a 404 or 405 means the server has no event endpoint yet; nothing is marked as sent", async () => {
    for (const status of [404, 405]) {
      const out = await syncSavingsEvents(deps(makeEvents(2), async () => { throw new ApiRequestError(status, "no route"); }));
      expect(out).toEqual({ status: "unsupported" });
    }
    expect(readSyncState(dir).lastAckedSeq).toBe(0);
  });

  test("a partial acknowledgement only advances to what the server confirmed", async () => {
    const out = await syncSavingsEvents(deps(makeEvents(5), async () => ({ ackedThroughSeq: 2 })));
    expect(out).toMatchObject({ status: "synced", lastAckedSeq: 2 });
  });
});
