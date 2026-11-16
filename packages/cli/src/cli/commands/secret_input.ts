// packages/cli/src/cli/commands/secret_input.ts
//
// Reads a credential value without it ever appearing on the command line.
//
// Why: a value given as a command-line argument is written to shell history
// and is visible to other local users in `ps`. clig.dev: "Do not read secrets
// directly from flags ... Consider accepting sensitive data only via files ...
// or via stdin." So `purix secret set NAME` with no value reads it here:
//   - on a terminal: a prompt with no echo;
//   - otherwise (a pipe or a file redirect): everything on stdin.

export interface SecretInputStream {
  isTTY?: boolean;
  setRawMode?: (mode: boolean) => unknown;
  setEncoding?: (enc: BufferEncoding) => unknown;
  resume?: () => unknown;
  pause?: () => unknown;
  on(event: "data", cb: (chunk: string | Buffer) => void): unknown;
  on(event: "end" | "close", cb: () => void): unknown;
  on(event: "error", cb: (err: Error) => void): unknown;
  removeListener(event: string, cb: (...args: never[]) => void): unknown;
}

export interface SecretInputIO {
  stdin: SecretInputStream;
  /** Prompts go to stderr so a piped stdout stays clean. */
  stderr: { write(s: string): unknown };
}

/** Thrown when the person cancels (Ctrl-C) at the prompt. */
export class SecretInputCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "SecretInputCancelled";
  }
}

/** Remove one trailing line ending, nothing else: a key's own spaces are not ours to trim. */
export function stripTrailingNewline(s: string): string {
  return s.replace(/\r?\n$/, "").replace(/\r$/, "");
}

function readAllPiped(stdin: SecretInputStream): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const onData = (chunk: string | Buffer) => { buf += chunk.toString(); };
    const done = () => { cleanup(); resolve(buf); };
    const fail = (e: Error) => { cleanup(); reject(e); };
    const cleanup = () => {
      stdin.removeListener("data", onData as never);
      stdin.removeListener("end", done as never);
      stdin.removeListener("close", done as never);
      stdin.removeListener("error", fail as never);
    };
    stdin.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.on("end", done);
    stdin.on("close", done);
    stdin.on("error", fail);
    stdin.resume?.();
  });
}

function readHiddenFromTerminal(stdin: SecretInputStream, stderr: SecretInputIO["stderr"], prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = "";
    const finish = (err?: Error) => {
      stdin.removeListener("data", onData as never);
      stdin.setRawMode?.(false);
      stdin.pause?.();
      stderr.write("\n");
      if (err) reject(err); else resolve(buf);
    };
    const onData = (chunk: string | Buffer) => {
      for (const ch of chunk.toString()) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") return finish();   // Enter, or Ctrl-D
        if (ch === "\u0003") return finish(new SecretInputCancelled());       // Ctrl-C (raw mode swallows the signal)
        if (ch === "\u007f" || ch === "\b") { buf = buf.slice(0, -1); continue; }
        if (ch >= " ") buf += ch;                                             // ignore other control characters
      }
    };
    stderr.write(prompt);
    stdin.setRawMode?.(true);
    stdin.setEncoding?.("utf8");
    stdin.on("data", onData);
    stdin.resume?.();
  });
}

/**
 * Get a credential value from the person, not from argv. Rejects with an
 * Error on an empty value so an accidental Enter never stores a blank key.
 */
export async function readSecretValue(name: string, io: SecretInputIO): Promise<string> {
  const { stdin, stderr } = io;
  const raw = stdin.isTTY
    ? await readHiddenFromTerminal(stdin, stderr, `Value for ${name} (input is hidden): `)
    : stripTrailingNewline(await readAllPiped(stdin));
  if (raw.length === 0) {
    throw new Error(
      stdin.isTTY
        ? "No value entered; nothing was stored."
        : `No value on stdin. Pipe it in, e.g.: printf %s "$KEY" | purix secret set ${name}`,
    );
  }
  return raw;
}
