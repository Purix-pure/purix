// Real multi-process races for the create-if-absent primitive and its three users (repo lock, machine id,
// secrets master key). Each child is a separate node process started at one shared timestamp, so they collide
// on the same file instead of taking turns.
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { createSecretsStore } from "../security/secrets_manager.js";

const WORKER = join(import.meta.dirname, "exclusive_create_race_worker.ts");
const N = 6;

interface Child {
  idx: number;
  out: Record<string, unknown>;
  stderr: string;
  code: number | null;
}

async function race(mode: "lock" | "machine" | "key", dir: string): Promise<Child[]> {
  const startAt = Date.now() + 2500; // tsx start-up is slower than this on a cold cache only; spinners align after it
  const runs = Array.from({ length: N }, (_, idx) =>
    new Promise<Child>((resolve, reject) => {
      const c = spawn(process.execPath, ["--import", "tsx", WORKER, mode, dir, String(startAt), String(idx)], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      c.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      c.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      c.on("error", reject);
      c.on("close", (code) => {
        let out: Record<string, unknown> = {};
        try {
          out = JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;
        } catch {
          // leave empty; the assertions below will fail with the stderr attached
        }
        resolve({ idx, out, stderr, code });
      });
    }),
  );
  return Promise.all(runs);
}

const why = (cs: Child[]): string => cs.map((c) => `#${c.idx} code=${c.code} out=${JSON.stringify(c.out)} err=${c.stderr.slice(0, 300)}`).join("\n");

describe("create-if-absent under real process races", { timeout: 60_000 }, () => {
  it(`repo lock: of ${N} simultaneous acquirers exactly one wins`, async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-race-lock-"));
    try {
      const cs = await race("lock", d);
      const won = cs.filter((c) => c.out.result === "WON");
      const lost = cs.filter((c) => c.out.result === "LOST");
      assert.equal(won.length, 1, `expected one winner\n${why(cs)}`);
      assert.equal(lost.length, N - 1, why(cs));
      for (const l of lost) assert.match(String(l.out.message), /already locked by active process/);
      // the winner released on exit; nothing left behind
      assert.deepEqual(readdirSync(join(d, ".purix")).filter((f) => f.includes("repo.lock") || f.endsWith(".tmp")), []);
    } finally {
      safeRmSync(d);
    }
  });

  it(`machine id: ${N} simultaneous first calls all return the same id, and it is the stored one`, async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-race-mid-"));
    try {
      const cs = await race("machine", d);
      const ids = new Set(cs.map((c) => c.out.id));
      assert.equal(ids.size, 1, `processes disagreed on the machine id\n${why(cs)}`);
      const stored = readFileSync(join(d, ".purix", "machine-id"), "utf8");
      assert.equal([...ids][0], stored);
      assert.deepEqual(readdirSync(join(d, ".purix")).filter((f) => f.endsWith(".tmp")), []);
    } finally {
      safeRmSync(d);
    }
  });

  it(`master key: ${N} simultaneous first uses end with one key that decrypts everyone's secrets`, async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-race-key-"));
    try {
      const cs = await race("key", d);
      for (const c of cs) assert.equal(c.out.ok, true, `process ${c.idx} could not read back its own secret\n${why(cs)}`);
      // Re-open every store with the key as it is on disk NOW. Before, a process that had lost the race still held
      // a key that was no longer on disk, so its secret failed here.
      for (let i = 0; i < N; i++) {
        assert.equal(createSecretsStore(d, `s${i}.enc.json`).getSecret("k"), `value-${i}`, `secret ${i} no longer decrypts`);
      }
      assert.deepEqual(readdirSync(d).filter((f) => f.endsWith(".tmp")), []);
    } finally {
      safeRmSync(d);
    }
  });
});
