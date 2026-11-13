import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileExclusive, moveFileAside, quarantineCorruptFile, readJsonFile, writeFileAtomic, writeJsonAtomic } from "./atomic_write.js";
import { safeRmSync } from "./fs_retry.js";
import { clearEntitlementsCache } from "../licensing/tier.js";
import { persistCustomProvider, persistProviderChoice } from "../llm/providers.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "purix-atomic-"));
}
const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.endsWith(".tmp"));

describe("writeFileAtomic", () => {
  it("writes content, creates the directory, leaves no temp file", () => {
    const d = tmp();
    try {
      const p = join(d, "a", "b", "x.json");
      writeFileAtomic(p, "hello");
      assert.equal(readFileSync(p, "utf-8"), "hello");
      assert.deepEqual(leftovers(join(d, "a", "b")), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("mkdir:false never recreates a missing directory (a removed lock must stay removed)", () => {
    const d = tmp();
    try {
      const lockDir = join(d, "config.lock");
      assert.throws(() => writeFileAtomic(join(lockDir, "holder.json"), "{}", { mkdir: false }), /ENOENT/);
      assert.equal(existsSync(lockDir), false);
      // Default behaviour is unchanged: the directory is created.
      writeFileAtomic(join(lockDir, "holder.json"), "{}");
      assert.equal(existsSync(join(lockDir, "holder.json")), true);
      // With the directory present, mkdir:false writes normally.
      writeFileAtomic(join(lockDir, "holder.json"), '{"pid":1}', { mkdir: false });
      assert.equal(readFileSync(join(lockDir, "holder.json"), "utf-8"), '{"pid":1}');
      assert.deepEqual(leftovers(lockDir), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("a failed rename leaves the OLD content intact and cleans the temp file", () => {
    const d = tmp();
    try {
      const p = join(d, "x.json");
      writeFileSync(p, "old");
      const boom = Object.assign(new Error("disk"), { code: "EIO" });
      assert.throws(() => writeFileAtomic(p, "new", { rename: () => { throw boom; } }), /disk/);
      assert.equal(readFileSync(p, "utf-8"), "old");
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("retries transient EPERM with backoff, then succeeds", () => {
    const d = tmp();
    try {
      const p = join(d, "x.json");
      let calls = 0;
      const waits: number[] = [];
      writeFileAtomic(p, "v", {
        sleep: (ms) => waits.push(ms),
        rename: (from, to) => {
          calls++;
          if (calls < 3) throw Object.assign(new Error("locked"), { code: "EPERM" });
          writeFileSync(to, readFileSync(from));
        },
      });
      assert.equal(calls, 3);
      assert.deepEqual(waits, [20, 40]);
      assert.equal(readFileSync(p, "utf-8"), "v");
    } finally {
      safeRmSync(d);
    }
  });

  it("gives up after the retry budget and rethrows", () => {
    const d = tmp();
    try {
      const p = join(d, "x.json");
      let calls = 0;
      assert.throws(
        () =>
          writeFileAtomic(p, "v", {
            retries: 2,
            sleep: () => {},
            rename: () => {
              calls++;
              throw Object.assign(new Error("locked"), { code: "EBUSY" });
            },
          }),
        /locked/
      );
      assert.equal(calls, 3);
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("does not retry a non-transient error", () => {
    const d = tmp();
    try {
      let calls = 0;
      assert.throws(() =>
        writeFileAtomic(join(d, "x"), "v", { sleep: () => {}, rename: () => { calls++; throw Object.assign(new Error("nope"), { code: "ENOSPC" }); } })
      );
      assert.equal(calls, 1);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("readJsonFile / quarantineCorruptFile", () => {
  it("reports missing, empty, corrupt and ok distinctly", () => {
    const d = tmp();
    try {
      const p = join(d, "s.json");
      assert.equal(readJsonFile(p).kind, "missing");
      writeFileSync(p, "  \n");
      assert.deepEqual(readJsonFile(p), { kind: "corrupt", error: "file is empty" });
      writeFileSync(p, "{not json");
      assert.equal(readJsonFile(p).kind, "corrupt");
      writeJsonAtomic(p, { a: 1 });
      assert.deepEqual(readJsonFile(p), { kind: "ok", value: { a: 1 } });
    } finally {
      safeRmSync(d);
    }
  });

  it("quarantine keeps a copy and never throws for a missing file", () => {
    const d = tmp();
    try {
      const p = join(d, "s.json");
      writeFileSync(p, "{bad");
      assert.equal(quarantineCorruptFile(p), `${p}.corrupt`);
      assert.equal(readFileSync(`${p}.corrupt`, "utf-8"), "{bad");
      assert.equal(quarantineCorruptFile(join(d, "absent.json")), null);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("migrated state writers", () => {
  it("provider choice is written under the given baseDir (not the cwd) and atomically", () => {
    const d = tmp();
    try {
      persistProviderChoice("custom", d);
      const p = join(d, ".purix", "provider-config.json");
      assert.equal(JSON.parse(readFileSync(p, "utf-8")).provider, "custom");
      assert.deepEqual(leftovers(join(d, ".purix")), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("a corrupt provider-config is quarantined before it is replaced", () => {
    const d = tmp();
    try {
      writeFileAtomic(join(d, ".purix", "provider-config.json"), "{broken");
      persistCustomProvider({ baseUrl: "https://x.example/v1", keyEnvVar: "K", modelLow: "a", modelHigh: "b" }, d);
      assert.equal(readFileSync(join(d, ".purix", "provider-config.json.corrupt"), "utf-8"), "{broken");
      assert.equal(JSON.parse(readFileSync(join(d, ".purix", "provider-config.json"), "utf-8")).provider, "custom");
    } finally {
      safeRmSync(d);
    }
  });

  it("tier cache write leaves no temp file", () => {
    const d = tmp();
    try {
      clearEntitlementsCache(d);
      assert.ok(existsSync(join(d, ".purix", "tier-config.json")));
      assert.deepEqual(leftovers(join(d, ".purix")), []);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("writeFileAtomic mode", () => {
  it("creates the file with the requested permissions and leaves no temp file (POSIX)", () => {
    if (process.platform === "win32") return; // permission bits do not apply
    const d = tmp();
    try {
      const p = join(d, "secret.json");
      writeFileAtomic(p, "s", { mode: 0o600 });
      assert.equal(statSync(p).mode & 0o777, 0o600);
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("a rewrite replaces the old file's permissions with the requested ones (POSIX)", () => {
    if (process.platform === "win32") return;
    const d = tmp();
    try {
      const p = join(d, "secret.json");
      writeFileSync(p, "old", { mode: 0o644 });
      writeFileAtomic(p, "new", { mode: 0o600 });
      assert.equal(readFileSync(p, "utf-8"), "new");
      assert.equal(statSync(p).mode & 0o777, 0o600);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("createFileExclusive", () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it("creates a missing file with the content, returns true, leaves no temp file", () => {
    const d = tmp();
    try {
      const p = join(d, "sub", "new.txt"); // parent directory does not exist yet
      assert.equal(createFileExclusive(p, "first"), true);
      assert.equal(readFileSync(p, "utf-8"), "first");
      assert.deepEqual(leftovers(join(d, "sub")), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("returns false and leaves an existing file exactly as it was", () => {
    const d = tmp();
    try {
      const p = join(d, "x.txt");
      writeFileSync(p, "original");
      assert.equal(createFileExclusive(p, "intruder"), false);
      assert.equal(readFileSync(p, "utf-8"), "original");
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("the second of two creates loses, and the first one's content stays", () => {
    const d = tmp();
    try {
      const p = join(d, "x.txt");
      assert.equal(createFileExclusive(p, "A"), true);
      assert.equal(createFileExclusive(p, "B"), false);
      assert.equal(readFileSync(p, "utf-8"), "A");
    } finally {
      safeRmSync(d);
    }
  });

  it("applies the requested permissions (POSIX)", () => {
    if (process.platform === "win32") return;
    const d = tmp();
    try {
      const p = join(d, "k");
      createFileExclusive(p, "s", { mode: 0o600 });
      assert.equal(statSync(p).mode & 0o777, 0o600);
    } finally {
      safeRmSync(d);
    }
  });

  // EISDIR: what Windows reports for a hard link on exFAT/FAT32 (nodejs/node#65817).
  for (const code of ["EPERM", "ENOSYS", "ENOTSUP", "EOPNOTSUPP", "EISDIR", "EXDEV"]) {
    it(`falls back to an exclusive open when hard links are unsupported (${code})`, () => {
      const d = tmp();
      try {
        const p = join(d, "x.txt");
        const link = (): void => {
          throw errno(code);
        };
        assert.equal(createFileExclusive(p, "via-fallback", { link }), true);
        assert.equal(readFileSync(p, "utf-8"), "via-fallback");
        assert.equal(createFileExclusive(p, "second", { link }), false); // fallback is still exclusive
        assert.equal(readFileSync(p, "utf-8"), "via-fallback");
        assert.deepEqual(leftovers(d), []);
      } finally {
        safeRmSync(d);
      }
    });
  }

  it("EISDIR from the link step does not hide a target that really is there", () => {
    const d = tmp();
    try {
      const p = join(d, "occupied");
      mkdirSync(p); // the target exists, as a directory
      const link = (): void => {
        throw errno("EISDIR");
      };
      assert.equal(createFileExclusive(p, "x", { link }), false);
      assert.equal(statSync(p).isDirectory(), true);
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });

  it("an unexpected link error is thrown, not swallowed, and the temp file is removed", () => {
    const d = tmp();
    try {
      const p = join(d, "x.txt");
      const link = (): void => {
        throw errno("EACCES");
      };
      assert.throws(() => createFileExclusive(p, "c", { link }), /EACCES/);
      assert.equal(existsSync(p), false);
      assert.deepEqual(leftovers(d), []);
    } finally {
      safeRmSync(d);
    }
  });
});

describe("moveFileAside", () => {
  const errno = (code: string): NodeJS.ErrnoException => Object.assign(new Error(code), { code });

  it("moves the file and only one of two movers wins", () => {
    const d = tmp();
    try {
      const p = join(d, "a.lock");
      writeFileSync(p, "x");
      moveFileAside(p, join(d, "a.lock.1"));
      assert.equal(existsSync(p), false);
      assert.equal(readFileSync(join(d, "a.lock.1"), "utf-8"), "x");
      // The slower mover finds nothing to move: ENOENT is thrown for the caller to judge, not swallowed.
      assert.throws(() => moveFileAside(p, join(d, "a.lock.2")), /ENOENT/);
    } finally {
      safeRmSync(d);
    }
  });

  it("retries transient Windows errors with backoff, then succeeds", () => {
    let calls = 0;
    const waits: number[] = [];
    moveFileAside("a", "b", {
      rename: () => {
        calls++;
        if (calls < 3) throw errno("EPERM");
      },
      sleep: (ms) => waits.push(ms),
    });
    assert.equal(calls, 3);
    assert.deepEqual(waits, [20, 40]);
  });

  it("gives up after the retry limit and rethrows; other errors are not retried", () => {
    let calls = 0;
    assert.throws(
      () => moveFileAside("a", "b", { retries: 2, rename: () => { calls++; throw errno("EBUSY"); }, sleep: () => {} }),
      /EBUSY/
    );
    assert.equal(calls, 3);
    calls = 0;
    assert.throws(() => moveFileAside("a", "b", { rename: () => { calls++; throw errno("ENOSPC"); }, sleep: () => {} }), /ENOSPC/);
    assert.equal(calls, 1);
  });
});
