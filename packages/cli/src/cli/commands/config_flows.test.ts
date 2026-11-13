// packages/cli/src/cli/commands/config_flows.test.ts
import { describe, test } from "node:test";
import { expect } from "expect";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describeOptionalFlows, formatFlows, type FlowInputs } from "./config_flows";

const base: FlowInputs = {
  telemetry: { stored: false, state: "unset", crashDiagnostics: false, effective: { sharing: false, reason: "not_enabled" } },
  login: null,
  savingsSyncFileTime: null,
  apiUrl: "https://api.purix.dev",
  provider: { id: null, keySource: null },
  webhookUrlSet: false,
};
const byId = (i: FlowInputs) => Object.fromEntries(describeOptionalFlows(i).map((f) => [f.id, f]));

describe("describeOptionalFlows", () => {
  test("a fresh install lists all five flows, none of them on", () => {
    const flows = describeOptionalFlows(base);
    expect(flows.map((f) => f.id)).toEqual(["telemetry", "crash-diagnostics", "savings-sync", "llm-provider", "webhook"]);
    expect(flows.every((f) => f.state !== "on")).toBe(true);
  });

  test("telemetry on is reported on but still says nothing is uploaded", () => {
    const f = byId({ ...base, telemetry: { stored: true, state: "on", crashDiagnostics: false, effective: { sharing: true, reason: "enabled" } } })["telemetry"]!;
    expect(f.state).toBe("on");
    expect(f.sends).toContain("nothing");
    expect(f.lastSent).toContain("never");
  });

  test("consent on but DO_NOT_TRACK set says why sharing is off", () => {
    const f = byId({ ...base, telemetry: { stored: true, state: "on", crashDiagnostics: false, effective: { sharing: false, reason: "do_not_track" } } })["telemetry"]!;
    expect(f.detail).toContain("DO_NOT_TRACK");
  });

  test("savings sync shows account, host and last upload time; never the full url path", () => {
    const f = byId({ ...base, login: { email: "a@b.co" }, savingsSyncFileTime: "2026-10-12T01:02:03.000Z" })["savings-sync"]!;
    expect(f.state).toBe("on");
    expect(f.detail).toContain("a@b.co");
    expect(f.to).toBe("api.purix.dev");
    expect(f.lastSent).toContain("2026-10-12T01:02:03.000Z");
  });

  test("not signed in means savings sync is off and never uploaded, even if an old sync file exists", () => {
    const f = byId({ ...base, savingsSyncFileTime: "2026-01-01T00:00:00.000Z" })["savings-sync"]!;
    expect(f.state).toBe("off");
    expect(f.lastSent).toContain("never");
  });

  test("webhook url is never printed", () => {
    const out = formatFlows(describeOptionalFlows({ ...base, webhookUrlSet: true }));
    expect(out).toContain("Notification webhook: ON");
    expect(out).not.toMatch(/https?:\/\/hooks/);
  });

  test("a missing provider key is called out", () => {
    const f = byId({ ...base, provider: { id: "openai", keySource: "missing" } })["llm-provider"]!;
    expect(f.detail).toContain("key missing");
  });
});

const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "cli.ts");

describe("purix config (real CLI)", () => {
  function run(args: string[]) {
    const home = mkdtempSync(join(tmpdir(), "purix-cfgflows-home-"));
    const cwd = mkdtempSync(join(tmpdir(), "purix-cfgflows-cwd-"));
    const r = spawnSync(process.execPath, ["--import", import.meta.resolve("tsx"), cli, ...args], {
      cwd, encoding: "utf8",
      env: { ...process.env, HOME: home, PURIX_USER_DIR: join(home, ".purix"), USERPROFILE: home },
    });
    return { r, home, cwd };
  }

  for (const args of [["config"], ["config", "list"]]) {
    test(`\`purix ${args.join(" ")}\` lists the flows, exits 0 and writes nothing into the project folder`, () => {
      const { r, home, cwd } = run(args);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain("Anonymous usage data: OFF");
      expect(r.stdout).toContain("Savings sync to your Purix account: OFF");
      expect(readdirSync(cwd)).toEqual([]);
      // C-22: setup and read-only commands leave HOME alone. The usage recorder skips `config`, so no
      // ~/.purix/usage-ledger.jsonl appears. Pinned so a new HOME write is noticed.
      expect(existsSync(join(home, ".purix", "usage-ledger.jsonl"))).toBe(false);
    });
  }

  test("`config get` and `config set` still work next to the new default action", () => {
    const { r } = run(["config", "get", "nothing-here"]);
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe("(not set)");
  });
});
