// The status-line installer must never replace a status line it did not write, never touch other settings, and refuse a file it
// cannot read. Tests use a throwaway folder as both the project and the home directory.
import { describe, it } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { safeRmSync } from "../platform/fs_retry.js";
import { addStatusline, removeStatusline, statuslineState, isOurStatuslineCommand, statuslineCommand, installStatusline, uninstallStatusline, readStatuslineState } from "./statusline_install.js";

describe("pure edits", () => {
  it("adds the setting to an empty or missing file", () => {
    for (const existing of [null, "", "  \n"]) {
      const r = addStatusline(existing);
      expect(r.ok && r.changed).toBe(true);
      expect(JSON.parse(r.ok ? r.text : "")).toEqual({ statusLine: { type: "command", command: "purix statusline" } });
    }
  });

  it("keeps every other setting, and their order", () => {
    const before = JSON.stringify({ $schema: "x", permissions: { allow: ["Bash(ls)"] }, hooks: { Stop: [] }, model: "m" });
    const r = addStatusline(before);
    const after = JSON.parse(r.ok ? r.text : "") as Record<string, unknown>;
    expect(Object.keys(after)).toEqual(["$schema", "permissions", "hooks", "model", "statusLine"]);
    expect(after["permissions"]).toEqual({ allow: ["Bash(ls)"] });
  });

  it("is idempotent: a second install changes nothing", () => {
    const first = addStatusline(null);
    const text = first.ok ? first.text : "";
    const second = addStatusline(text);
    expect(second.ok && second.changed).toBe(false);
    expect(second.ok && second.text).toBe(text);
  });

  it("never replaces a status line that is not ours, and says what is there", () => {
    const own = JSON.stringify({ statusLine: { type: "command", command: "~/.claude/statusline.sh", padding: 2 } });
    const r = addStatusline(own);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain("~/.claude/statusline.sh");
    expect(!r.ok && r.error).toContain("was not written by Purix");
    const weird = addStatusline(JSON.stringify({ statusLine: "just a string" }));
    expect(weird.ok).toBe(false);
    // a script that merely mentions our command is not ours
    expect(isOurStatuslineCommand("~/bin/wrap.sh purix statusline")).toBe(false);
    expect(isOurStatuslineCommand("echo purix statusline")).toBe(false);
  });

  it("recognises its own command with options, updates the range in place and keeps padding", () => {
    expect(isOurStatuslineCommand("purix statusline --range 7d")).toBe(true);
    expect(isOurStatuslineCommand("purix.cmd statusline")).toBe(true);
    const start = JSON.stringify({ statusLine: { type: "command", command: "purix statusline", padding: 1 } });
    const r = addStatusline(start, "7d");
    expect(r.ok && r.changed).toBe(true);
    expect(JSON.parse(r.ok ? r.text : "")).toEqual({ statusLine: { type: "command", command: "purix statusline --range 7d", padding: 1 } });
    expect(statuslineCommand("all")).toBe("purix statusline --range all");
  });

  it("refuses a file that is not valid JSON or not an object, and changes nothing", () => {
    for (const bad of ['{ "a": 1, }', "// comment\n{}", "[]", "42"]) {
      expect(addStatusline(bad).ok).toBe(false);
      expect(removeStatusline(bad).ok).toBe(false);
      expect(statuslineState(bad).state).toBe("unreadable");
    }
  });

  it("removes only its own entry and leaves the rest", () => {
    const added = addStatusline(JSON.stringify({ model: "m" }));
    const removed = removeStatusline(added.ok ? added.text : "");
    expect(removed.ok && removed.changed).toBe(true);
    expect(JSON.parse(removed.ok ? removed.text : "")).toEqual({ model: "m" });
    expect(removeStatusline(JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } })).ok).toBe(false);
    const none = removeStatusline(JSON.stringify({ model: "m" }));
    expect(none.ok && none.changed).toBe(false);
  });

  it("reports the three states", () => {
    expect(statuslineState(null).state).toBe("not-installed");
    expect(statuslineState(JSON.stringify({ statusLine: { type: "command", command: "purix statusline" } })).state).toBe("installed");
    expect(statuslineState(JSON.stringify({ statusLine: { type: "command", command: "mine.sh" } }))).toEqual({ state: "other", command: "mine.sh" });
  });
});

describe("files", () => {
  const scratch = () => { const d = mkdtempSync(join(tmpdir(), "purix-sl-")); return { root: join(d, "proj"), home: join(d, "home"), d }; };

  it("writes the right file for each scope and reads it back", () => {
    const { root, home, d } = scratch();
    try {
      const paths = (["local", "shared", "user"] as const).map((s) => installStatusline(s, root, "today", home));
      expect(paths[0]!.path).toBe(join(root, ".claude", "settings.local.json"));
      expect(paths[1]!.path).toBe(join(root, ".claude", "settings.json"));
      expect(paths[2]!.path).toBe(join(home, ".claude", "settings.json"));
      expect(paths.every((p) => p.created && p.result.ok && p.result.changed)).toBe(true);
      expect(readStatuslineState("local", root, home).state.state).toBe("installed");
      expect(installStatusline("local", root, "today", home).created).toBe(false);
    } finally { safeRmSync(d); }
  });

  it("leaves a foreign status line byte-for-byte untouched, and uninstall does too", () => {
    const { root, home, d } = scratch();
    try {
      const file = join(root, ".claude", "settings.local.json");
      mkdirSync(join(root, ".claude"), { recursive: true });
      const own = JSON.stringify({ statusLine: { type: "command", command: "my.sh" } }, null, 2) + "\n";
      writeFileSync(file, own);
      const r = installStatusline("local", root, "today", home);
      expect(r.result.ok).toBe(false);
      expect(readFileSync(file, "utf-8")).toBe(own);
      expect(uninstallStatusline("local", root, home).result.ok).toBe(false);
      expect(readFileSync(file, "utf-8")).toBe(own);
    } finally { safeRmSync(d); }
  });

  it("uninstall on a missing file creates nothing", () => {
    const { root, home, d } = scratch();
    try {
      const r = uninstallStatusline("user", root, home);
      expect(r.result.ok && r.result.changed).toBe(false);
      expect(existsSync(join(home, ".claude"))).toBe(false);
    } finally { safeRmSync(d); }
  });
});
