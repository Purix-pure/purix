// packages/cli/src/cli/commands/lifecycle_harness.test.ts
//
// Helper for lifecycle.test.ts. It holds no tests. It is named *.test.ts only so the package build (which excludes that pattern)
// does not ship it. It runs the REAL `purix` CLI as a child process against a throwaway git project, with a fake
// OpenAI-compatible model on a local port, so a test exercises the same code a person runs, not a copy of it.
//
// What is real: the CLI entry, argument parsing, runModify, the budget guard, the security gate, sandbox verification with a
// real tsc, the TrustGate, the writer and the audit chain. What is fake: the two model replies (intent refinement and change
// classification). Linux only; needs `git` on PATH.
import { createServer, type Server } from "node:http";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const CLI_ENTRY = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.ts");
// Windows rejects a plain absolute path after --import (ERR_UNSUPPORTED_ESM_URL_SCHEME): it must be a file:// URL.
const TSX = pathToFileURL(require.resolve("tsx")).href;

export const ORIGINAL_BODY = 'return "hello " + name;';
export const MD5_BODY = 'return crypto.createHash("md5").update(name).digest("hex");';
export const SAFE_BODY = 'return "hi " + name;';

export interface FakeModel {
  url: string;
  /** "refine" and "classify" in the order the CLI asked. Empty means the model was never called. */
  calls: string[];
  close(): Promise<void>;
}

/** A local model that answers the two calls `purix modify` makes: it rewrites ORIGINAL_BODY into `newBody` in greet.ts. */
/** `oldText` is the text the fake model asks to replace. The default is a whole statement; pass a fragment to make an anchor that starts and ends inside a line. */
/** `confidence` is what the fake classifier reports (0.97 by default; below the TrustGate reject threshold the gate aborts, which needs a related test file, see makeProject). */
export async function startFakeModel(newBody: string = MD5_BODY, oldText: string = ORIGINAL_BODY, confidence: number = 0.97): Promise<FakeModel> {
  const calls: string[] = [];
  const reply = (obj: unknown) => JSON.stringify({ choices: [{ message: { content: JSON.stringify(obj) } }], usage: { prompt_tokens: 10, completion_tokens: 10 } });
  const server: Server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const text = body;
      res.setHeader("content-type", "application/json");
      if (/explicit_instruction/.test(text)) {
        calls.push("refine");
        res.end(reply({ explicit_instruction: "Change what greet returns", assumptions: [] }));
      } else if (/operation/.test(text) && /edits/.test(text)) {
        calls.push("classify");
        res.end(reply({
          operation: "modify_code", contract_changing: false, confidence, reasoning: "one-line body change", suspicious_injected_instruction: false,
          edits: [{ path: "greet.ts", kind: "prompt_text", old_text: oldText, new_text: newBody }],
        }));
      } else {
        calls.push("unexpected");
        res.statusCode = 500;
        res.end(JSON.stringify({ error: "fake model: unexpected call" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}/v1`, calls, close: () => new Promise<void>((r) => server.close(() => r())) };
}

export interface RunResult {
  status: number | null;
  /** stdout and stderr together, in arrival order. */
  out: string;
}

export interface AuditRow {
  gate_name: string;
  reason: string;
  finding: string;
}

export interface Project {
  dir: string;
  run(args: string[], env?: Record<string, string>): Promise<RunResult>;
  greet(): string;
  overrideAudits(): AuditRow[];
  cleanup(): void;
}

/** A fresh git project with one TypeScript file adopted as component "greet", pointed at `model`. */
/** `withTest` adds greet.test.js, a test named for greet: without a related test the TrustGate asks for confirmation before it ever looks at confidence. */
export async function makeProject(model: FakeModel, opts: { withTest?: boolean } = {}): Promise<Project> {
  const root = mkdtempSync(join(tmpdir(), "purix-lifecycle-"));
  const dir = join(root, "proj");
  const userDir = join(root, "user");
  mkdirSync(dir);
  mkdirSync(userDir);
  const baseEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PURIX_USER_DIR: userDir,
    FAKE_KEY: "sk-fake",
    NODE_ENV: "test",
    AUTO_CONFIRM: "1",
    PURIX_LLM_PROVIDER: "custom",
    NO_COLOR: "1",
  };
  delete baseEnv.PURIX_COST_CEILING_USD;

  const run = (args: string[], env: Record<string, string> = {}, cwd = dir): Promise<RunResult> =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["--import", TSX, CLI_ENTRY, ...args], { cwd, env: { ...baseEnv, ...env } });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      const timer = setTimeout(() => child.kill("SIGKILL"), 120_000);
      child.on("close", (status) => {
        clearTimeout(timer);
        resolve({ status, out });
      });
    });

  const git = (args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const c = spawn("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir, stdio: "ignore" });
      c.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`git ${args.join(" ")} failed`))));
    });

  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "proj", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, noEmit: true, skipLibCheck: true, types: [] }, include: ["*.ts"] }));
  writeFileSync(
    join(dir, "greet.ts"),
    `declare const crypto: { createHash(a: string): { update(s: string): { digest(f: string): string } } };\nexport function greet(name: string): string {\n  ${ORIGINAL_BODY}\n}\n`,
  );
  if (opts.withTest) {
    // Plain JavaScript on purpose: a .ts test would need tsx installed in the project, and the run would stop at "test runner not installed".
    writeFileSync(join(dir, "greet.test.js"), `import { test } from "node:test";\ntest("greet is covered", () => {});\n`);
  }
  // The project's own compiler: Purix looks for node_modules/typescript/lib/tsc.js before offering to install one.
  cpSync(realpathSync(dirname(require.resolve("typescript/package.json"))), join(dir, "node_modules", "typescript"), { recursive: true });
  if (opts.withTest) {
    // The project's test runner needs tsx next to the compiler. A link keeps its own dependencies (esbuild and others) resolvable.
    const tsxHome = realpathSync(dirname(require.resolve("tsx/package.json")));
    symlinkSync(tsxHome, join(dir, "node_modules", "tsx"), "dir");
    // Purix looks for the runner at node_modules/.bin/tsx.
    mkdirSync(join(dir, "node_modules", ".bin"), { recursive: true });
    symlinkSync(join(tsxHome, "dist", "cli.mjs"), join(dir, "node_modules", ".bin", "tsx"), "file");
  }
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  await git(["init", "-q", "."]);
  await git(["add", "-A"]);
  await git(["commit", "-qm", "init"]);

  for (const [label, args] of [
    ["provider set", ["provider", "set", "custom", "--base-url", model.url, "--key-env", "FAKE_KEY", "--model-low", "fake-low", "--model-high", "fake-high", "--label", "fake"]],
    ["index", ["index"]],
    ["adopt", ["adopt", "greet.ts"]],
  ] as [string, string[]][]) {
    const r = await run(args);
    if (label === "adopt" && !/Adopted greet\.ts/.test(r.out)) throw new Error(`harness setup: adopt failed:\n${r.out}`);
  }
  model.calls.length = 0;

  return {
    dir,
    run,
    greet: () => readFileSync(join(dir, "greet.ts"), "utf8"),
    overrideAudits: () => {
      // The store lives in the repository's own .git folder (state/git_common_dir.ts).
      const db = new DatabaseSync(join(dir, ".git", "purix-state", "manifest.db"), { readOnly: true });
      try {
        return db.prepare("SELECT gate_name, reason, finding FROM override_audits ORDER BY timestamp ASC").all() as unknown as AuditRow[];
      } catch {
        return []; // the table is created on the first override, so a run with none has no table yet
      } finally {
        db.close();
      }
    },
    cleanup: () => safeRmSync(root),
  };
}
