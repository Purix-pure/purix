import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { addPanelEntry, removePanelEntry, installPanel, uninstallPanel, readPanelState, panelFilePath, panelConfigPath, isOurPanelEntry, samePath } from "./opencode_panel.js";
import { PANEL_SOURCE } from "./opencode_panel_source.js";
import { safeRmSync } from "../platform/fs_retry.js";

let root: string; let home: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "purix-panel-r-")); home = mkdtempSync(join(tmpdir(), "purix-panel-h-")); });
afterEach(() => { safeRmSync(root); safeRmSync(home); });

describe("tui.json edits", () => {
  it("adds our entry after others and keeps every other setting", () => {
    const r = addPanelEntry(JSON.stringify({ theme: "x", plugin: ["other"] }), "file:///a/purix-panel.tsx");
    expect(r.ok && JSON.parse(r.text)).toEqual({ theme: "x", plugin: ["other", "file:///a/purix-panel.tsx"] });
  });
  it("is a no-op when already present, and moves a stale entry of ours", () => {
    const e = "file:///a/purix-panel.tsx";
    const same = addPanelEntry(JSON.stringify({ plugin: [e] }), e);
    expect(same.ok && same.changed).toBe(false);
    const moved = addPanelEntry(JSON.stringify({ plugin: ["file:///old/purix-panel.tsx"] }), e);
    expect(moved.ok && JSON.parse(moved.text).plugin).toEqual([e]);
  });
  it("refuses comments, non-objects and a non-list plugin, changing nothing", () => {
    expect(addPanelEntry("{ // c\n}", "x").ok).toBe(false);
    expect(addPanelEntry("[]", "x").ok).toBe(false);
    expect(addPanelEntry('{"plugin":"a"}', "x").ok).toBe(false);
  });
  it("removes only our entry, and drops an empty list", () => {
    const r = removePanelEntry(JSON.stringify({ a: 1, plugin: ["o", "file:///a/purix-panel.tsx"] }));
    expect(r.ok && JSON.parse(r.text)).toEqual({ a: 1, plugin: ["o"] });
    const e = removePanelEntry(JSON.stringify({ a: 1, plugin: ["file:///a/purix-panel.tsx"] }));
    expect(e.ok && JSON.parse(e.text)).toEqual({ a: 1 });
  });
  it("recognises a [spec, options] pair", () => { expect(isOurPanelEntry(["file:///a/purix-panel.tsx", {}])).toBe(true); expect(isOurPanelEntry("other")).toBe(false); });
});

describe("install / uninstall / status", () => {
  it("installs, is idempotent, reports state, and uninstalls leaving other entries", () => {
    const cfg = panelConfigPath("project", root, home);
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ plugin: ["keep"] }));
    const r = installPanel("project", root, home);
    expect(r.ok).toBe(true);
    expect(readFileSync(panelFilePath("project", root, home), "utf-8")).toBe(PANEL_SOURCE);
    expect(JSON.parse(readFileSync(cfg, "utf-8")).plugin).toHaveLength(2);
    const again = installPanel("project", root, home);
    expect(again.ok && !again.fileChanged && !again.configChanged).toBe(true);
    expect(readPanelState("project", root, home).state.state).toBe("installed");
    const u = uninstallPanel("project", root, home);
    expect(u.ok && u.fileRemoved && u.configChanged).toBe(true);
    expect(JSON.parse(readFileSync(cfg, "utf-8")).plugin).toEqual(["keep"]);
    expect(existsSync(panelFilePath("project", root, home))).toBe(false);
    expect(readPanelState("project", root, home).state.state).toBe("not-installed");
  });
  it("leaves a purix-panel.tsx that is not ours alone, and writes nothing", () => {
    const f = panelFilePath("user", root, home);
    mkdirSync(join(home, ".config", "opencode"), { recursive: true });
    writeFileSync(f, "mine");
    const r = installPanel("user", root, home);
    expect(r.ok).toBe(false);
    expect(existsSync(panelConfigPath("user", root, home))).toBe(false);
    uninstallPanel("user", root, home);
    expect(readFileSync(f, "utf-8")).toBe("mine");
    expect(readPanelState("user", root, home).state.state).toBe("other-file");
  });
  it("a broken tui.json is refused before the plugin file is written", () => {
    mkdirSync(join(root, ".opencode"), { recursive: true });
    writeFileSync(panelConfigPath("project", root, home), "{ // x\n}");
    expect(installPanel("project", root, home).ok).toBe(false);
    expect(existsSync(panelFilePath("project", root, home))).toBe(false);
  });
  it("reports a half install", () => {
    installPanel("project", root, home);
    safeRmSync(panelFilePath("project", root, home));
    expect(readPanelState("project", root, home).state.state).toBe("partial");
  });
});

describe("samePath", () => {
  it("ignores case only on Windows", () => {
    expect(samePath("C:\\a\\x.tsx", "c:\\a\\X.tsx", true)).toBe(true);
    expect(samePath("/a/x.tsx", "/a/X.tsx", false)).toBe(false);
    expect(samePath("/a/x.tsx", "/a/x.tsx", false)).toBe(true);
  });
});
