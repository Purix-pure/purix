// PURIX-17 P1-B, second slice: the remaining state writers (approvers file, repo lock, machine id,
// secrets master key and store) go through platform/atomic_write.ts. These tests pin the behaviour
// each one gained. The components.json writer in manifest/indexer.ts is covered by indexer.test.ts.
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { assertAuthorizedToApprove } from "../security/auth.js";
import { acquireRepoLock, isRepoLockHeld, releaseRepoLock } from "../state/repo_lock.js";
import { getMachineId } from "../state/machine_id.js";
import { createSecretsStore } from "../security/secrets_manager.js";
import { safeRmSync } from "./fs_retry.js";

const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));
const posixOnly = process.platform !== "win32";
interface LockFile {
  pid: number;
  updatedAt: string;
  token?: string;
}

describe("authorized_operators.json", () => {
  const AUTH = ".purix/authorized_operators.json";
  let cwd: string;
  let dir: string;
  let env: { node?: string; auto?: string };

  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "purix-auth-atomic-"));
    process.chdir(dir);
    mkdirSync(".purix", { recursive: true });
    env = { node: process.env.NODE_ENV, auto: process.env.AUTO_CONFIRM };
    process.env.NODE_ENV = "test"; // AUTO_CONFIRM is only honoured under NODE_ENV=test
    process.env.AUTO_CONFIRM = "1";
  });
  afterEach(() => {
    process.chdir(cwd);
    if (env.node === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = env.node;
    if (env.auto === undefined) delete process.env.AUTO_CONFIRM;
    else process.env.AUTO_CONFIRM = env.auto;
    safeRmSync(dir);
  });

  it("bootstrap writes 0600 (POSIX) and leaves no temp file", async () => {
    await assertAuthorizedToApprove();
    assert.deepEqual(JSON.parse(readFileSync(AUTH, "utf-8")), { authorized: [userInfo().username] });
    assert.deepEqual(leftovers(".purix"), []);
    if (posixOnly) assert.equal(statSync(AUTH).mode & 0o777, 0o600);
  });

  for (const [label, content] of [
    ["unparseable JSON", "{ not json"],
    ["an empty file (a truncated write)", ""],
    ["an object with no list", "{}"],
    ["a list that is not a list", '{"authorized":"bob"}'],
    ["a list with a non-string entry", '{"authorized":["bob",7]}'],
    ["a bare array", "[]"],
  ] as const) {
    it(`fails closed on ${label}: throws, keeps a copy, changes nothing, registers nobody`, async () => {
      writeFileSync(AUTH, content);
      await assert.rejects(assertAuthorizedToApprove(), /could not be read/);
      assert.equal(readFileSync(AUTH, "utf-8"), content);
      assert.equal(readFileSync(`${AUTH}.corrupt`, "utf-8"), content);
    });
  }

  it("a listed user passes and the file is not rewritten", async () => {
    const content = JSON.stringify({ authorized: [userInfo().username, "someone-else"] });
    writeFileSync(AUTH, content);
    await assertAuthorizedToApprove();
    assert.equal(readFileSync(AUTH, "utf-8"), content);
  });

  it("a user who is not listed is refused", async () => {
    writeFileSync(AUTH, JSON.stringify({ authorized: ["someone-else"] }));
    await assert.rejects(assertAuthorizedToApprove(), /not in the authorized-approvers list/);
  });
});

describe("repo lock heartbeat", () => {
  let dir: string;
  const lockPath = () => join(dir, ".purix", "repo.lock");

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-lock-atomic-"));
    mock.timers.enable({ apis: ["setInterval"] });
  });
  afterEach(() => {
    releaseRepoLock(dir);
    mock.timers.reset();
    safeRmSync(dir);
  });

  it("each beat rewrites the lock as complete JSON and leaves no temp file", () => {
    acquireRepoLock(dir);
    const first = JSON.parse(readFileSync(lockPath(), "utf-8")) as LockFile;
    mock.timers.tick(10_000);
    const second = JSON.parse(readFileSync(lockPath(), "utf-8")) as LockFile;
    assert.equal(second.pid, process.pid);
    assert.ok(Date.parse(second.updatedAt) >= Date.parse(first.updatedAt));
    assert.deepEqual(leftovers(join(dir, ".purix")), []);
  });

  it("a lock carries a token and isRepoLockHeld is true for the holder", () => {
    acquireRepoLock(dir);
    const onDisk = JSON.parse(readFileSync(lockPath(), "utf-8")) as LockFile;
    assert.match(String(onDisk.token), /^[0-9a-f]{16}$/);
    assert.equal(isRepoLockHeld(dir), true);
  });

  it("a holder whose lock was replaced stops beating and does not overwrite the new holder's lock", () => {
    acquireRepoLock(dir);
    const theirs = JSON.stringify({ pid: process.pid, timestamp: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", token: "someone-else" });
    writeFileSync(lockPath(), theirs);
    assert.equal(isRepoLockHeld(dir), false);
    mock.timers.tick(10_000);
    mock.timers.tick(10_000);
    assert.equal(readFileSync(lockPath(), "utf-8"), theirs); // untouched by our beats
  });

  it("releasing does not delete a lock that has been replaced by someone else's", () => {
    acquireRepoLock(dir);
    const theirs = JSON.stringify({ pid: process.pid, timestamp: "2026-10-05T00:00:00.000Z", updatedAt: "2026-10-05T00:00:00.000Z", token: "someone-else" });
    writeFileSync(lockPath(), theirs);
    releaseRepoLock(dir);
    assert.equal(readFileSync(lockPath(), "utf-8"), theirs);
  });

  it("a lock file from an older version (no token) is still released by its own pid", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    const now = new Date().toISOString();
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, timestamp: now, updatedAt: now }));
    releaseRepoLock(dir);
    assert.equal(existsSync(lockPath()), false);
  });

  it("a lock that is empty and brand new is being written: acquire waits, then fails, and never deletes it", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    writeFileSync(lockPath(), ""); // what the exclusive-open fallback shows for a moment (exFAT, some network mounts)
    assert.throws(() => acquireRepoLock(dir), /being written by another process/);
    assert.equal(existsSync(lockPath()), true);
    assert.equal(readFileSync(lockPath(), "utf-8"), "");
  });

  it("a lock that is empty and old is a dead creator's leftover: it is reclaimed", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    writeFileSync(lockPath(), "");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lockPath(), old, old);
    const log = mock.method(console, "log", () => {});
    try {
      acquireRepoLock(dir);
    } finally {
      log.mock.restore();
    }
    assert.equal(isRepoLockHeld(dir), true);
  });

  it("releasing does not delete an unreadable lock it cannot prove is its own", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    writeFileSync(lockPath(), "{not json");
    releaseRepoLock(dir);
    assert.equal(readFileSync(lockPath(), "utf-8"), "{not json");
  });

  it("a stale lock is replaced by a fresh one with a token, and no .reclaim file is left", () => {
    mkdirSync(join(dir, ".purix"), { recursive: true });
    const old = new Date(Date.now() - 120_000).toISOString();
    writeFileSync(lockPath(), JSON.stringify({ pid: process.pid, timestamp: old, updatedAt: old }));
    utimesSync(lockPath(), new Date(old), new Date(old)); // a holder that stopped beating has not touched the file either
    const log = mock.method(console, "log", () => {});
    try {
      acquireRepoLock(dir);
    } finally {
      log.mock.restore();
    }
    assert.equal(isRepoLockHeld(dir), true);
    assert.deepEqual(readdirSync(join(dir, ".purix")).filter((f) => f.includes(".reclaim.")), []);
  });
});

describe("machine id", () => {
  it("is stored as exactly the id, with no temp file left", () => {
    const d = mkdtempSync(join(tmpdir(), "purix-mid-atomic-"));
    try {
      const id = getMachineId(d);
      assert.equal(readFileSync(join(d, ".purix", "machine-id"), "utf-8"), id);
      assert.deepEqual(leftovers(join(d, ".purix")), []);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("secrets master key and store", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-secrets-atomic-"));
  });
  afterEach(() => safeRmSync(dir));

  it("key and store are written 0600 (POSIX) with no temp file left", () => {
    const warn = mock.method(console, "warn", () => {}); // the first-key notice is expected output
    try {
      createSecretsStore(dir).setSecret("K", "v");
    } finally {
      warn.mock.restore();
    }
    assert.equal(Buffer.from(readFileSync(join(dir, "secrets.master.key"), "utf-8"), "base64").length, 32);
    assert.deepEqual(leftovers(dir), []);
    if (posixOnly) {
      assert.equal(statSync(join(dir, "secrets.master.key")).mode & 0o777, 0o600);
      assert.equal(statSync(join(dir, "secrets.enc.json")).mode & 0o777, 0o600);
    }
  });

  for (const [label, damage] of [
    ["empty", ""],
    ["too short (16 bytes)", Buffer.alloc(16, 1).toString("base64")],
  ] as const) {
    it(`a ${label} master key throws and is never replaced by a new one`, () => {
      const warn = mock.method(console, "warn", () => {});
      try {
        createSecretsStore(dir).setSecret("keep", "me");
      } finally {
        warn.mock.restore();
      }
      const keyPath = join(dir, "secrets.master.key");
      const storePath = join(dir, "secrets.enc.json");
      const storeBefore = readFileSync(storePath, "utf-8");
      writeFileSync(keyPath, damage);
      if (posixOnly) chmodSync(keyPath, 0o600);
      const store = createSecretsStore(dir);
      assert.throws(() => store.getSecret("keep"), /master key .* is damaged/);
      assert.throws(() => store.setSecret("other", "x"), /master key .* is damaged/);
      assert.equal(readFileSync(keyPath, "utf-8"), damage);
      assert.equal(readFileSync(storePath, "utf-8"), storeBefore);
      assert.ok(existsSync(keyPath));
    });
  }
});
