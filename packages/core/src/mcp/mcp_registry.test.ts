// src/mcp/mcp_registry.test.ts
//
// Previously zero test coverage on this file. The registry path used to
// be a hardcoded relative string resolved against whatever process.cwd()
// happened to be, which meant this module could never be tested in
// isolation from the real repo's own .purix/ directory (GAPS-REPORT-2
// §7) — these tests are only possible at all because of that fix.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addServer, removeServer, getServer, listServers } from "./mcp_registry";

describe("mcp_registry", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "purix-mcp-registry-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("addServer then getServer round-trips with the given baseDir, without touching any other directory", () => {
    addServer("weather", "https://weather.example.com/mcp", dir);
    const record = getServer("weather", dir);
    expect(record?.name).toBe("weather");
    expect(record?.url).toBe("https://weather.example.com/mcp");
    expect(typeof record?.added_at).toBe("string");
  });

  it("writes to <baseDir>/.purix/mcp_servers.json specifically", () => {
    addServer("weather", "https://weather.example.com/mcp", dir);
    const raw = readFileSync(join(dir, ".purix", "mcp_servers.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.servers).toEqual([expect.objectContaining({ name: "weather" })]);
  });

  it("getServer returns null for a name that was never registered", () => {
    expect(getServer("nonexistent", dir)).toBeNull();
  });

  it("addServer overwrites an existing record with the same name instead of duplicating it", () => {
    addServer("weather", "https://old.example.com", dir);
    addServer("weather", "https://new.example.com", dir);
    expect(listServers(dir)).toEqual([expect.objectContaining({ name: "weather", url: "https://new.example.com" })]);
  });

  it("removeServer removes a registered server and returns true", () => {
    addServer("weather", "https://weather.example.com/mcp", dir);
    expect(removeServer("weather", dir)).toBe(true);
    expect(getServer("weather", dir)).toBeNull();
  });

  it("removeServer returns false for a name that isn't registered", () => {
    expect(removeServer("nonexistent", dir)).toBe(false);
  });

  it("listServers returns every registered server", () => {
    addServer("a", "https://a.example.com", dir);
    addServer("b", "https://b.example.com", dir);
    const names = listServers(dir)
      .map((s) => s.name)
      .sort();
    expect(names).toEqual(["a", "b"]);
  });

  it("two different baseDirs never see each other's servers (regression for the hardcoded-path bug)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "purix-mcp-registry-test-"));
    try {
      addServer("only-in-dir1", "https://one.example.com", dir);
      addServer("only-in-dir2", "https://two.example.com", dir2);
      expect(getServer("only-in-dir1", dir2)).toBeNull();
      expect(getServer("only-in-dir2", dir)).toBeNull();
      expect(getServer("only-in-dir1", dir)?.url).toBe("https://one.example.com");
      expect(getServer("only-in-dir2", dir2)?.url).toBe("https://two.example.com");
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });

  it("a corrupted registry file degrades to an empty list rather than throwing", () => {
    addServer("weather", "https://weather.example.com/mcp", dir);
    const path = join(dir, ".purix", "mcp_servers.json");
    writeFileSync(path, "{ not valid json");
    expect(listServers(dir)).toEqual([]);
  });
});