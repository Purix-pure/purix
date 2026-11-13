// D1: read-only commands must not create state in a folder that has none, and
// `audit-log verify` must report a damaged store instead of rebuilding it.
import { describe, it } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";

const require = createRequire(import.meta.url);
const tsxLoader = require.resolve("tsx");

function runCli(args: string[], cwd: string): { status: number | null; output: string } {
  const home = join(cwd, "..", `${cwd.split(/[\\/]/).pop()}-home`);
  const result = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(tsxLoader).href, join(import.meta.dirname, "cli.ts"), ...args],
    {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home, APPDATA: join(home, "AppData", "Roaming"), LOCALAPPDATA: join(home, "AppData", "Local") },
      encoding: "utf8",
    },
  );
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

describe("read-only commands in a folder with no Purix state", () => {
  const commands: string[][] = [["status"], ["library"], ["stats"], ["audit-log", "verify"], ["check"]];
  for (const args of commands) {
    it(`"purix ${args.join(" ")}" exits 0, explains, and creates nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), "purix-ro-"));
      try {
        const r = runCli(args, dir);
        expect(r.status).toBe(0);
        expect(r.output).toMatch(/No Purix state here|No components registered|nothing/i);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        safeRmSync(dir);
      }
    });
  }

  it("does not create .git/purix-state inside a git repository", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-ro-git-"));
    try {
      mkdirSync(join(dir, ".git"));
      writeFileSync(join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
      for (const args of commands) runCli(args, dir);
      expect(readdirSync(join(dir, ".git")).sort()).toEqual(["HEAD"]);
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("tools broker: read-only subcommands create nothing, installs without a human create nothing", () => {
  for (const args of [["tools", "list"], ["tools", "plan", "--for", "python"], ["tools", "status"]]) {
    it(`"purix ${args.join(" ")}" exits 0 and leaves an empty folder empty`, () => {
      const dir = mkdtempSync(join(tmpdir(), "purix-ro-tools-"));
      try {
        const r = runCli(args, dir);
        expect(r.status).toBe(0);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        safeRmSync(dir);
      }
    });
  }

  it("\"purix tools install ruff\" with stdin closed exits 1, installs nothing and creates no tool folder", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-ro-tools-install-"));
    try {
      const r = runCli(["tools", "install", "ruff"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toMatch(/did not confirm/);
      expect(existsSync(join(dir, ".purix", "tools"))).toBe(false);
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("audit-log verify on a damaged store", () => {
  it("exits 1, says nothing was rebuilt, and leaves the file untouched", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-ro-bad-"));
    try {
      mkdirSync(join(dir, ".purix"));
      const path = join(dir, ".purix", "manifest.db");
      writeFileSync(path, Buffer.alloc(4096, 9));
      const before = readFileSync(path);
      const r = runCli(["audit-log", "verify"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toMatch(/damaged/i);
      expect(readFileSync(path).equals(before)).toBe(true);
      expect(readdirSync(join(dir, ".purix"))).toEqual(["manifest.db"]);
    } finally {
      safeRmSync(dir);
    }
  });
});

describe("lang subcommands are read-only: they create nothing in an empty folder", () => {
  for (const args of [["lang", "list"], ["lang", "status", "python"]]) {
    it(`"purix ${args.join(" ")}" exits 0 and leaves an empty folder empty`, () => {
      const dir = mkdtempSync(join(tmpdir(), "purix-ro-lang-"));
      try {
        const r = runCli(args, dir);
        expect(r.status).toBe(0);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        safeRmSync(dir);
      }
    });
  }
});

describe("purix tools \"<purpose>\" is the catalog front door (never an npm search)", () => {
  const inFolder = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "purix-purpose-"));
    try { fn(dir); } finally { safeRmSync(dir); }
  };

  it("answers from the catalog, offline, and creates nothing", () => {
    inFolder((dir) => {
      const r = runCli(["tools", "run tests"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/Tools in the Purix catalog for "run tests"/);
      expect(r.output).toMatch(/purix tools install pytest/);
      expect(r.output).toMatch(/purix tools install vitest/);
      expect(r.output).not.toMatch(/Searching npm|UNVERIFIED|npmjs/i);
      expect(readdirSync(dir)).toEqual([]);
    });
  });

  it("unquoted words work the same way", () => {
    inFolder((dir) => {
      const r = runCli(["tools", "lint", "python"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/ruff/);
      expect(r.output).not.toMatch(/eslint/);
    });
  });

  it("says plainly when nothing in the catalog fits, instead of guessing", () => {
    inFolder((dir) => {
      const r = runCli(["tools", "mypy"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/Nothing in the Purix catalog matches "mypy"/);
      expect(r.output).toMatch(/purix tools list/);
    });
  });

  it("puts the tool the project already declares first and says so", () => {
    inFolder((dir) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "p", devDependencies: { vitest: "^2.0.0" } }));
      const r = runCli(["tools", "run tests"], dir);
      expect(r.output.indexOf("vitest")).toBeLessThan(r.output.indexOf("jest"));
      expect(r.output).toMatch(/your project already declares it/);
    });
  });

  it("with no words, shows help; the old `search` subcommand is gone", () => {
    inFolder((dir) => {
      const r = runCli(["tools"], dir);
      expect(r.output).toMatch(/install/);
      expect(r.output).toMatch(/plan/);
      expect(r.output).not.toMatch(/\bsearch\b.*npm|unverified/i);
    });
  });
});

describe("purix lang no longer installs tools: it points to `purix tools`", () => {
  for (const name of ["install", "uninstall"]) {
    it(`"purix lang ${name} python" exits 1 and says where to go, changing nothing`, () => {
      const dir = mkdtempSync(join(tmpdir(), "purix-langmoved-"));
      try {
        const r = runCli(["lang", name, "python"], dir);
        expect(r.status).toBe(1);
        expect(r.output).toMatch(/purix tools/);
        expect(readdirSync(dir)).toEqual([]);
      } finally {
        safeRmSync(dir);
      }
    });
  }

  it("`lang status python` reports the broker's view of the tools", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-langstatus-"));
    try {
      const r = runCli(["lang", "status", "python"], dir);
      expect(r.status).toBe(0);
      expect(r.output).toMatch(/managed by `purix tools`/);
      expect(r.output).toMatch(/run-tests: pytest@8\.3\.4 missing \(purix tools install pytest\)/);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      safeRmSync(dir);
    }
  });
});


describe("purix check: exit codes and output contract", () => {
  it("empty folder: exit 0 with a skipped report, exit 1 under --strict, valid JSON with schema 1, and nothing created", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-check-cli-"));
    try {
      const plain = runCli(["check"], dir);
      expect(plain.status).toBe(0);
      expect(plain.output).toMatch(/Nothing was checked/);
      expect(runCli(["check", "--strict"], dir).status).toBe(1);
      const json = runCli(["check", "--json"], dir);
      const report = JSON.parse(json.output) as { schema: number; outcome: string; exitCode: number; sections: { id: string }[] };
      expect(report.schema).toBe(1);
      expect(report.outcome).toBe("skipped");
      expect(report.exitCode).toBe(0);
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      safeRmSync(dir);
    }
  });

  it("a damaged store exits 1 (never 0), reports damage, and leaves the file byte-identical", () => {
    const dir = mkdtempSync(join(tmpdir(), "purix-check-cli-damaged-"));
    try {
      mkdirSync(join(dir, ".purix"));
      const garbage = Buffer.from("not a sqlite database ".repeat(40));
      writeFileSync(join(dir, ".purix", "manifest.db"), garbage);
      const r = runCli(["check"], dir);
      expect(r.status).toBe(1);
      expect(r.output).toMatch(/damaged/);
      expect(readFileSync(join(dir, ".purix", "manifest.db")).equals(garbage)).toBe(true);
      expect(readdirSync(join(dir, ".purix"))).toEqual(["manifest.db"]);
    } finally {
      safeRmSync(dir);
    }
  });
});
