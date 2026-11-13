// src/tools/broker.test.ts
import { describe, it } from "node:test";
import { expect } from "expect";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getToolBinary, installTool, listCatalog, planForLanguages, removeTool, requestInstall, approveRequest, toolStatus, type BrokerDeps } from "./broker.js";
import { listPending } from "./consent.js";
import { lockPath, readLock, toolDir, toolsDir } from "./state.js";
import { fakeRunner, fixedGate, memoryAudit, npmEntry, pipEntry, tempProject } from "./test_helpers.js";

const NOW = () => new Date("2026-10-03T00:00:00Z");
function deps(dir: string, over: Partial<BrokerDeps> = {}): BrokerDeps {
  return { baseDir: dir, catalog: [pipEntry(), npmEntry()], platform: "linux", now: NOW, runner: fakeRunner(), audit: memoryAudit(), ...over };
}

describe("read-only commands create nothing", () => {
  it("list, plan and status leave an empty folder empty", () => {
    const p = tempProject();
    try {
      listCatalog(deps(p.dir));
      planForLanguages(deps(p.dir), ["python", "typescript"]);
      toolStatus(deps(p.dir));
      getToolBinary(deps(p.dir), "demo");
      expect(existsSync(join(p.dir, ".purix"))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("plan against the shipped catalog finishes and says what is missing", () => {
    const p = tempProject();
    try {
      const plan = planForLanguages({ baseDir: p.dir }, ["python"]);
      expect(plan.needs.map((n) => `${n.need.capability}:${n.chosen?.entry.id}:${n.state}`)).toEqual([
        "type-check:pyright:missing", "run-tests:pytest:missing", "lint:ruff:missing", "dep-audit:pip-audit:missing",
      ]);
      expect(existsSync(join(p.dir, ".purix"))).toBe(false);
    } finally { p.cleanup(); }
  });
});

describe("installTool", () => {
  it("never installs without a consent gate", async () => {
    const p = tempProject();
    try {
      const runner = fakeRunner();
      const r = await installTool(deps(p.dir, { runner }), "demo");
      expect(!r.ok && r.reason).toBe("no-consent-gate");
      expect(runner.calls).toEqual([]);
      expect(existsSync(toolsDir(p.dir))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("a declined prompt installs nothing and is audited as a refusal", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit(); const runner = fakeRunner();
      const r = await installTool(deps(p.dir, { audit, runner, consent: fixedGate(false) }), "demo");
      expect(!r.ok && r.reason).toBe("consent-declined");
      expect(runner.calls).toEqual([]);
      expect(audit.events.map((e) => `${e.action}:${e.reason}`)).toEqual(["refused:consent-declined"]);
    } finally { p.cleanup(); }
  });
  it("the human sees exactly what will run before anything runs", async () => {
    const p = tempProject();
    try {
      const gate = fixedGate(false);
      await installTool(deps(p.dir, { consent: gate }), "demo");
      expect(gate.summaries[0]!.willRun.join(" ")).toMatch(/--require-hashes/);
      expect(gate.summaries[0]!.installDir).toBe(toolDir(p.dir, "demo")); // T1: in the user's tools state, not in the project
    } finally { p.cleanup(); }
  });
  it("fails closed when the audit chain is down: nothing is installed", async () => {
    const p = tempProject();
    try {
      const runner = fakeRunner();
      const r = await installTool(deps(p.dir, { audit: memoryAudit({ failOn: "approval" }), runner, consent: fixedGate(true) }), "demo");
      expect(!r.ok && r.reason).toBe("audit-unavailable");
      expect(runner.calls).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("happy path: installs, writes the lock record, audits approval then install, status ok, binary resolves", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit();
      const r = await installTool(deps(p.dir, { audit, consent: fixedGate(true) }), "demo");
      expect(r.ok && r.alreadyInstalled).toBe(false);
      expect(audit.events.map((e) => e.action)).toEqual(["approval", "install"]);
      const recorded = readLock(p.dir);
      expect(recorded.kind === "ok" && recorded.lock.records.map((x) => x.id)).toEqual(["demo"]);
      expect(toolStatus(deps(p.dir)).installed[0]!.state).toBe("ok");
      expect(getToolBinary(deps(p.dir), "demo")).toBe(join(toolDir(p.dir, "demo"), "venv", "bin", "demo"));
    } finally { p.cleanup(); }
  });
  it("a second install of an intact tool does nothing and does not prompt", async () => {
    const p = tempProject();
    try {
      await installTool(deps(p.dir, { consent: fixedGate(true) }), "demo");
      const gate = fixedGate(true); const runner = fakeRunner();
      const r = await installTool(deps(p.dir, { consent: gate, runner }), "demo");
      expect(r.ok && r.alreadyInstalled).toBe(true);
      expect(gate.summaries).toEqual([]);
      expect(runner.calls).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("a too-new release is refused before any prompt, and audited", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit(); const gate = fixedGate(true);
      const r = await installTool(deps(p.dir, { audit, consent: gate, catalog: [pipEntry({ releasedAt: "2026-10-02T00:00:00.000Z" })] }), "demo");
      expect(!r.ok && r.reason).toBe("too-new");
      expect(gate.summaries).toEqual([]);
      expect(audit.events[0]).toMatchObject({ action: "refused", reason: "too-new" });
    } finally { p.cleanup(); }
  });
  it("a failed install is audited and leaves no lock record", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit();
      const r = await installTool(deps(p.dir, { audit, runner: fakeRunner({ failOn: "--require-hashes" }), consent: fixedGate(true) }), "demo");
      expect(!r.ok && r.reason).toBe("command-failed");
      expect(audit.events.map((e) => e.action)).toEqual(["approval", "install_failed"]);
      expect(existsSync(lockPath(p.dir))).toBe(false);
    } finally { p.cleanup(); }
  });
  it("an unreadable lock is reported, not overwritten", async () => {
    const p = tempProject();
    try {
      await installTool(deps(p.dir, { consent: fixedGate(true) }), "demo");
      writeFileSync(lockPath(p.dir), "{corrupt");
      const r = await installTool(deps(p.dir, { consent: fixedGate(true) }), "demojs");
      expect(!r.ok && r.reason).toBe("state-corrupt");
      expect(readFileSync(lockPath(p.dir), "utf-8")).toBe("{corrupt");
    } finally { p.cleanup(); }
  });
  it("unknown tool names are refused", async () => {
    const p = tempProject();
    try {
      const r = await installTool(deps(p.dir, { consent: fixedGate(true) }), "left-pad");
      expect(!r.ok && r.reason).toBe("unknown-tool");
    } finally { p.cleanup(); }
  });
});

describe("status drift", () => {
  it("detects a deleted binary and an edited lock file", async () => {
    const p = tempProject();
    try {
      await installTool(deps(p.dir, { consent: fixedGate(true) }), "demo");
      writeFileSync(join(toolDir(p.dir, "demo"), "requirements.txt"), "evil==9\n");
      expect(toolStatus(deps(p.dir)).installed[0]!.state).toBe("lock-file-modified");
      rmSync(join(toolDir(p.dir, "demo"), "venv"), { recursive: true });
      expect(toolStatus(deps(p.dir)).installed[0]!.state).toBe("missing-binary");
      expect(getToolBinary(deps(p.dir), "demo")).toBeNull();
    } finally { p.cleanup(); }
  });
  it("reports catalog-changed when the release ships a different lock", async () => {
    const p = tempProject();
    try {
      await installTool(deps(p.dir, { consent: fixedGate(true) }), "demo");
      const changed = pipEntry({ version: "1.2.4", files: { "requirements.txt": pipEntry().files["requirements.txt"]! }, lockSha256: "f".repeat(64) });
      expect(toolStatus(deps(p.dir, { catalog: [changed] })).installed[0]!.state).toBe("catalog-changed");
    } finally { p.cleanup(); }
  });
});

describe("agent path: ask, never install", () => {
  it("requestInstall writes one pending file and one audit entry, and installs nothing", async () => {
    const p = tempProject();
    try {
      const audit = memoryAudit(); const runner = fakeRunner();
      const r = requestInstall(deps(p.dir, { audit, runner }), "demo", "I need a linter\u0000 now");
      expect(r.ok).toBe(true);
      expect(runner.calls).toEqual([]);
      expect(existsSync(join(toolsDir(p.dir), "demo"))).toBe(false);
      expect(listPending(p.dir).length).toBe(1);
      expect(audit.events.map((e) => e.action)).toEqual(["request"]);
      expect(listPending(p.dir)[0]!.reason).toBe("I need a linter now");
    } finally { p.cleanup(); }
  });
  it("is withdrawn if the audit chain is down", () => {
    const p = tempProject();
    try {
      const r = requestInstall(deps(p.dir, { audit: memoryAudit({ failOn: "request" }) }), "demo");
      expect(!r.ok && r.reason).toBe("audit-unavailable");
      expect(listPending(p.dir)).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("unknown tools and too-new releases cannot even be requested", () => {
    const p = tempProject();
    try {
      expect(!requestInstall(deps(p.dir), "nope").ok).toBe(true);
      const r = requestInstall(deps(p.dir, { catalog: [pipEntry({ releasedAt: "2026-10-02T00:00:00.000Z" })] }), "demo");
      expect(!r.ok && r.reason).toBe("too-new");
    } finally { p.cleanup(); }
  });
  it("approveRequest goes through the human gate; declining closes the request", async () => {
    const p = tempProject();
    try {
      const made = requestInstall(deps(p.dir), "demo", "lint");
      if (!made.ok) throw new Error("setup");
      const declined = await approveRequest(deps(p.dir, { consent: fixedGate(false) }), made.request.id);
      expect(!declined.ok && declined.reason).toBe("consent-declined");
      expect(listPending(p.dir)).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("approveRequest with a yes installs and the summary names the agent and its untrusted reason", async () => {
    const p = tempProject();
    try {
      const made = requestInstall(deps(p.dir), "demo", "please lint");
      if (!made.ok) throw new Error("setup");
      const gate = fixedGate(true);
      const r = await approveRequest(deps(p.dir, { consent: gate }), made.request.id);
      expect(r.ok).toBe(true);
      expect(gate.summaries[0]).toMatchObject({ origin: "agent", requestReason: "please lint" });
      expect(listPending(p.dir)).toEqual([]);
    } finally { p.cleanup(); }
  });
  it("a made-up request id is refused", async () => {
    const p = tempProject();
    try {
      const r = await approveRequest(deps(p.dir, { consent: fixedGate(true) }), "req-000000000000");
      expect(!r.ok && r.reason).toBe("unknown-request");
    } finally { p.cleanup(); }
  });
});

describe("removeTool", () => {
  it("removes the folder and the record, audited; removing nothing is a no-op", async () => {
    const p = tempProject();
    try {
      await installTool(deps(p.dir, { consent: fixedGate(true) }), "demo");
      const audit = memoryAudit();
      const r = removeTool(deps(p.dir, { audit }), "demo");
      expect(r).toEqual({ ok: true, removed: true });
      expect(existsSync(join(toolsDir(p.dir), "demo"))).toBe(false);
      expect(toolStatus(deps(p.dir)).installed).toEqual([]);
      expect(audit.events.map((e) => e.action)).toEqual(["remove"]);
      expect(removeTool(deps(p.dir, { audit }), "demo")).toEqual({ ok: true, removed: false });
    } finally { p.cleanup(); }
  });
});
