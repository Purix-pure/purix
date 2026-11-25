// `purix statusline --install|--uninstall|--status`: the command layer over the installer (core observe/statusline_install.ts).
// A throwaway folder is both the project and the home folder; nothing outside it is touched.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "@purix/core/platform/fs_retry";
import { runStatuslineSetup } from "./observe.js";

const run = async (opts: Parameters<typeof runStatuslineSetup>[0], root: string, home: string) => {
  const lines: string[] = [];
  const code = await runStatuslineSetup(opts, root, (l) => lines.push(l), home);
  return { code, text: lines.join("\n") };
};

describe("purix statusline --install", () => {
  it("writes the personal project file by default, says where, and warns about the trust prompt", async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-slc-"));
    try {
      const r = await run({ range: "today", install: true }, d, join(d, "home"));
      expect(r.code).toBe(0);
      const file = join(d, ".claude", "settings.local.json");
      expect(JSON.parse(readFileSync(file, "utf-8"))).toEqual({ statusLine: { type: "command", command: "purix statusline" } });
      expect(r.text).toContain(file);
      expect(r.text).toContain("trust");
      expect(r.text).toContain(".gitignore");
      // no project record is created as a side effect
      expect(existsSync(join(d, ".purix"))).toBe(false);
    } finally { safeRmSync(d); }
  });

  it("--user writes the home file; --range is carried into the command", async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-slc-"));
    try {
      const home = join(d, "home");
      const r = await run({ range: "7d", install: true, user: true }, d, home);
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf-8")).statusLine.command).toBe("purix statusline --range 7d");
      expect(r.text).toContain("every project");
    } finally { safeRmSync(d); }
  });

  it("exits 1 and leaves a person's own status line untouched", async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-slc-"));
    try {
      mkdirSync(join(d, ".claude"), { recursive: true });
      const file = join(d, ".claude", "settings.local.json");
      const own = JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } });
      writeFileSync(file, own);
      const r = await run({ range: "today", install: true }, d, join(d, "home"));
      expect(r.code).toBe(1);
      expect(r.text).toContain("mine.sh");
      expect(readFileSync(file, "utf-8")).toBe(own);
    } finally { safeRmSync(d); }
  });

  it("--status lists all three places and does not call an install 'showing'", async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-slc-"));
    try {
      const home = join(d, "home");
      await run({ range: "today", install: true, shared: true }, d, home);
      const r = await run({ range: "today", status: true }, d, home);
      expect(r.code).toBe(0);
      expect(r.text).toMatch(/shared .*settings\.json: ✅ installed/);
      expect(r.text).toMatch(/local .*settings\.local\.json: ➖ not installed/);
      expect(r.text).toContain('"Installed" is not "showing"');
    } finally { safeRmSync(d); }
  });

  it("--uninstall removes only Purix's entry", async () => {
    const d = mkdtempSync(join(tmpdir(), "purix-slc-"));
    try {
      const home = join(d, "home");
      await run({ range: "today", install: true }, d, home);
      const r = await run({ range: "today", uninstall: true }, d, home);
      expect(r.code).toBe(0);
      expect(JSON.parse(readFileSync(join(d, ".claude", "settings.local.json"), "utf-8"))).toEqual({});
    } finally { safeRmSync(d); }
  });
});
