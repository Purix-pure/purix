// A1: atomicWriteFile carries a replaced file's mode over and writes text exactly as given.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, writeFileSync, readFileSync, chmodSync, statSync, readdirSync, symlinkSync, lstatSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic_write.js";

const posix = process.platform !== "win32";
const tmp = () => mkdtempSync(join(tmpdir(), "purix-awf-"));

describe("atomicWriteFile", () => {
  it("keeps an executable file executable", { skip: !posix }, () => {
    const d = tmp(); const f = join(d, "run.sh");
    writeFileSync(f, "a\n"); chmodSync(f, 0o755);
    atomicWriteFile(f, "b\n");
    expect(statSync(f).mode & 0o777).toBe(0o755);
    expect(readFileSync(f, "utf-8")).toBe("b\n");
  });
  it("keeps a mode the umask would trim (0o775)", { skip: !posix }, () => {
    const d = tmp(); const f = join(d, "x");
    writeFileSync(f, "a"); chmodSync(f, 0o775);
    atomicWriteFile(f, "b");
    expect(statSync(f).mode & 0o777).toBe(0o775);
  });
  it("an explicit mode wins over the old file's", { skip: !posix }, () => {
    const d = tmp(); const f = join(d, "x");
    writeFileSync(f, "a"); chmodSync(f, 0o755);
    atomicWriteFile(f, "b", { mode: 0o600 });
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
  it("creates a new file and adds or removes no newline", () => {
    const d = tmp();
    atomicWriteFile(join(d, "n"), "no newline");
    atomicWriteFile(join(d, "c"), "a\r\nb\r\n");
    expect(readFileSync(join(d, "n"), "utf-8")).toBe("no newline");
    expect(readFileSync(join(d, "c"), "utf-8")).toBe("a\r\nb\r\n");
  });
  it("leaves no temp file behind", () => {
    const d = tmp(); const f = join(d, "x");
    atomicWriteFile(f, "1"); atomicWriteFile(f, "2");
    expect(readdirSync(d)).toEqual(["x"]);
  });
  it("a failed rename leaves the original untouched and removes the temp file", () => {
    const d = tmp(); const f = join(d, "x");
    writeFileSync(f, "original");
    expect(() => atomicWriteFile(f, "new", { rename: () => { throw Object.assign(new Error("boom"), { code: "EIO" }); } })).toThrow("boom");
    expect(readFileSync(f, "utf-8")).toBe("original");
    expect(readdirSync(d)).toEqual(["x"]);
  });
  it("does not follow a symlink: the link is replaced, the target is untouched", { skip: !posix }, () => {
    const d = tmp(); const target = join(d, "target"); const link = join(d, "link");
    writeFileSync(target, "T"); symlinkSync(target, link);
    atomicWriteFile(link, "new");
    expect(readFileSync(target, "utf-8")).toBe("T");
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf-8")).toBe("new");
    rmSync(d, { recursive: true, force: true });
  });
});
