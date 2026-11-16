// packages/cli/src/cli/commands/secret_input.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { PassThrough } from "node:stream";
import { readSecretValue, stripTrailingNewline, SecretInputCancelled, type SecretInputIO } from "./secret_input";

function fakeIO(isTTY: boolean) {
  const stdin = new PassThrough() as PassThrough & { isTTY?: boolean; setRawMode?: (m: boolean) => void; rawLog: boolean[] };
  stdin.isTTY = isTTY;
  stdin.rawLog = [];
  if (isTTY) stdin.setRawMode = (m: boolean) => { stdin.rawLog.push(m); };
  let err = "";
  const io: SecretInputIO = { stdin: stdin as unknown as SecretInputIO["stdin"], stderr: { write: (s: string) => { err += s; } } };
  return { stdin, io, err: () => err };
}

describe("stripTrailingNewline", () => {
  it("removes exactly one trailing line ending and keeps inner and edge spaces", () => {
    expect(stripTrailingNewline("abc\n")).toBe("abc");
    expect(stripTrailingNewline("abc\r\n")).toBe("abc");
    expect(stripTrailingNewline("abc\n\n")).toBe("abc\n");
    expect(stripTrailingNewline(" a b ")).toBe(" a b ");
  });
});

describe("readSecretValue, piped stdin", () => {
  it("reads the value and drops the trailing newline", async () => {
    const { stdin, io } = fakeIO(false);
    const p = readSecretValue("K", io);
    stdin.end("s3cret-value\n");
    expect(await p).toBe("s3cret-value");
  });

  it("works when the value arrives in several chunks", async () => {
    const { stdin, io } = fakeIO(false);
    const p = readSecretValue("K", io);
    stdin.write("abc");
    stdin.write("def\r\n");
    stdin.end();
    expect(await p).toBe("abcdef");
  });

  it("rejects an empty stdin with a message that shows how to pipe a value", async () => {
    const { stdin, io } = fakeIO(false);
    const p = readSecretValue("MY_KEY", io);
    stdin.end("");
    await expect(p).rejects.toThrow(/No value on stdin.*purix secret set MY_KEY/s);
  });

  it("does not echo or prompt when piped", async () => {
    const { stdin, io, err } = fakeIO(false);
    const p = readSecretValue("K", io);
    stdin.end("x\n");
    await p;
    expect(err()).toBe("");
  });
});

describe("readSecretValue, terminal", () => {
  it("prompts on stderr, never echoes the typed value, and restores the terminal", async () => {
    const { stdin, io, err } = fakeIO(true);
    const p = readSecretValue("GEMINI_API_KEY", io);
    stdin.write("hunter2\r");
    expect(await p).toBe("hunter2");
    expect(err()).toContain("GEMINI_API_KEY");
    expect(err()).not.toContain("hunter2");
    expect(stdin.rawLog).toEqual([true, false]);
  });

  it("honours backspace", async () => {
    const { stdin, io } = fakeIO(true);
    const p = readSecretValue("K", io);
    stdin.write("abcx\u007f\u007fd\n");
    expect(await p).toBe("abd");
  });

  it("Ctrl-C cancels and still restores the terminal", async () => {
    const { stdin, io } = fakeIO(true);
    const p = readSecretValue("K", io);
    stdin.write("ab\u0003");
    await expect(p).rejects.toBeInstanceOf(SecretInputCancelled);
    expect(stdin.rawLog).toEqual([true, false]);
  });

  it("an immediate Enter stores nothing", async () => {
    const { stdin, io } = fakeIO(true);
    const p = readSecretValue("K", io);
    stdin.write("\r");
    await expect(p).rejects.toThrow(/nothing was stored/);
  });
});
