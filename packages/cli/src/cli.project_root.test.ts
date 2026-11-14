// N-3 (PURIX-38) at the command line: which folder a command treats as "the project" when it is typed in a subfolder.
// core/src/platform/project_root.test.ts pins the rule itself; this pins that the CLI really applies it (a real process),
// says so on stderr, stays silent for the two commands that speak a protocol on their pipes (mcp-serve, hook),
// and leaves `connect` alone because it writes into the folder the person chose.
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = pathToFileURL(require.resolve("tsx")).href;
const cliEntry = join(import.meta.dirname, "cli.ts");

function run(args: string[], cwd: string, home: string, input?: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local"), NO_COLOR: "1" };
  delete env.CI;
  delete env.PURIX_USER_DIR;
  const r = spawnSync(process.execPath, ["--import", tsxLoader, cliEntry, ...args], { cwd, env, input, encoding: "utf8", timeout: 90_000 });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function fixture(): { base: string; home: string; proj: string; deep: string } {
  // The real path: the command prints the folder the operating system reports (macOS: /private/var/..., not /var/...).
  const base = realpathSync(mkdtempSync(join(tmpdir(), "purix-root-")));
  // home sits beside the project, not inside it: a project above the home folder never counts (rule 4).
  const home = mkdtempSync(join(tmpdir(), "purix-root-home-"));
  const proj = join(base, "proj");
  const deep = join(proj, "src", "deep");
  mkdirSync(join(proj, ".git"), { recursive: true });
  mkdirSync(deep, { recursive: true });
  return { base, home, proj, deep };
}

describe("project root at the command line", () => {
  it("a read-only command typed in a subfolder of a git repo says which root it used and leaves no .purix in the subfolder", () => {
    const f = fixture();
    try {
      const r = run(["status"], f.deep, f.home);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`Using project root ${f.proj}`);
      expect(readdirSync(f.deep)).toEqual([]);
      expect(existsSync(join(f.deep, ".purix"))).toBe(false);
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });

  it("F05-07: purix index typed in a subfolder writes one .purix at the project root and records paths from that root", () => {
    const f = fixture();
    try {
      writeFileSync(join(f.deep, "x.ts"), "export const x = 1;\n");
      const r = run(["index"], f.deep, f.home);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`Using project root ${f.proj}`);
      expect(existsSync(join(f.deep, ".purix"))).toBe(false);
      expect(existsSync(join(f.proj, ".purix"))).toBe(true);
      const recorded = readFileSync(join(f.proj, ".purix", "components.json"), "utf8");
      expect(recorded).toContain("src/deep/x.ts");
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });

  it("an existing .purix above the .git wins over the nearer .git (rule 1 beats rule 2)", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.base, ".purix"));
      mkdirSync(join(f.proj, "nested", ".git"), { recursive: true });
      const start = join(f.proj, "nested");
      const r = run(["status"], start, f.home);
      expect(r.status).toBe(0);
      expect(r.stderr).toContain(`Using project root ${f.base}`);
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });

  it("the hook command stays silent on stderr when typed in a subfolder (an agent reads that stream as the reason for a block)", () => {
    const f = fixture();
    try {
      const payload = JSON.stringify({ tool_name: "Edit", tool_input: { file_path: join(f.deep, "x.ts") }, cwd: f.deep });
      const r = run(["hook", "claude-code", "pre-tool-use"], f.deep, f.home, payload);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Using project root");
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });

  it("index typed in a subfolder records paths from the project root and leaves no .purix in the subfolder (F05-07)", () => {
    const f = fixture();
    try {
      mkdirSync(join(f.proj, "src"), { recursive: true });
      writeFileSync(join(f.proj, "src", "app.ts"), "export function hello() { return 1; }\n");
      const r = run(["index"], f.deep, f.home);
      expect(r.status).toBe(0);
      expect(existsSync(join(f.deep, ".purix"))).toBe(false);
      expect(existsSync(join(f.proj, "src", ".purix"))).toBe(false);
      const recorded = readFileSync(join(f.proj, ".purix", "components.json"), "utf8");
      expect(recorded).toContain("src/app.ts");
      expect(recorded).not.toContain('"app.ts"');
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });

  it("connect is exempt: it writes the agent's file in the folder the person chose, not at the project root", () => {
    const f = fixture();
    try {
      const r = run(["connect", "claude-code", "--no-verify", "--no-hooks", "--no-instructions"], f.deep, f.home);
      expect(r.status).toBe(0);
      expect(r.stderr).not.toContain("Using project root");
      expect(existsSync(join(f.deep, ".mcp.json"))).toBe(true);
      expect(existsSync(join(f.proj, ".mcp.json"))).toBe(false);
    } finally { safeRmSync(f.base); safeRmSync(f.home); }
  });
});
