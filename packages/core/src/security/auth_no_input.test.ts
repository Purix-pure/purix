// "Bootstrap declined" used to be printed when nobody could answer the question (an agent's shell, a pipe, CI), as if a person had
// said no. This runs the real function in a child process whose stdin is closed, the way an agent's tool call runs it.
import { describe, test } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// A file:// URL, not a plain path: on Windows a plain `E:\...` path in an import is refused by Node ("absolute paths must be valid file:// URLs").
const authModule = new URL("./auth.ts", import.meta.url).href;
// The child runs in a temp folder, where a bare `--import tsx` cannot be found; give it the absolute location.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

function run(stdin: "ignore" | "pipe", input?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "purix-auth-noinput-"));
  const home = mkdtempSync(join(tmpdir(), "purix-auth-home-"));
  try {
    const code = `import { assertAuthorizedToApprove } from ${JSON.stringify(authModule)};
      try { await assertAuthorizedToApprove(); console.log("RESULT:registered"); } catch (e) { console.log("RESULT:" + e.message); }`;
    const r = spawnSync(process.execPath, ["--import", tsxLoader, "--input-type=module", "-e", code], {
      cwd,
      encoding: "utf-8",
      stdio: [stdin, "pipe", "pipe"],
      input,
      env: { ...process.env, HOME: home, USERPROFILE: home, PURIX_USER_DIR: join(home, ".purix"), PURIX_AUTO_CONFIRM: "", CI: "" },
      timeout: 60_000,
    });
    return `${r.stdout}\n${r.stderr}`;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(home, { recursive: true, force: true });
  }
}

describe("assertAuthorizedToApprove when nobody can answer", () => {
  test("closed stdin: says it could not ask, that nothing was registered, and what the person must run", () => {
    const out = run("ignore");
    expect(out).toContain("cannot ask the question");
    expect(out).toContain("Nothing was registered");
    expect(out).toContain("purix approve --register");
    expect(out).not.toContain("Bootstrap declined");
  });

  test("a person typing n is a decision: the message says declined and how to register later", () => {
    const out = run("pipe", "n\n");
    expect(out).toContain("Bootstrap declined");
    expect(out).toContain("purix approve --register");
    expect(out).not.toContain("cannot ask the question");
  });
});
