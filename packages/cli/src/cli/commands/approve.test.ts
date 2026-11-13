import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requestOrConsume, approvalStatus } from "@purix/core/approvals/pending";
import { isolateCwdForFile } from "@purix/core/test-support/isolated_cwd";
import { runDecision, runList, runShow } from "./approve.js";

// Answering a request records an audit event in the project store, which lives under the current directory.
isolateCwdForFile();

let base: string;
let userDir: string;
let saved: string | undefined;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "purix-approve-proj-"));
  userDir = mkdtempSync(join(tmpdir(), "purix-approve-user-"));
  saved = process.env.PURIX_USER_DIR;
  process.env.PURIX_USER_DIR = userDir;
});
afterEach(() => {
  if (saved === undefined) delete process.env.PURIX_USER_DIR;
  else process.env.PURIX_USER_DIR = saved;
  rmSync(base, { recursive: true, force: true });
  rmSync(userDir, { recursive: true, force: true });
});

const make = () =>
  requestOrConsume(base, {
    tool: "purix_index",
    checkpointKind: "mcp_index_full",
    componentId: null,
    args: { full: true },
    summary: "Full indexing: re-index",
    message: "MCP Agent requests full codebase re-index. Approve?",
    client: "agent-x",
  }).record;

function deps(over: Partial<Parameters<typeof runDecision>[2]> = {}) {
  const lines: string[] = [];
  return {
    lines,
    deps: { baseDir: base, interactive: true, ask: () => Promise.resolve(true), print: (l: string) => lines.push(l), ...over },
  };
}

describe("purix approve / deny", () => {
  test("without a terminal it refuses and changes nothing, even if the answer would be yes", async () => {
    const rec = make();
    const { deps: d, lines } = deps({ interactive: false, ask: () => Promise.reject(new Error("must not ask")) });
    const res = await runDecision(rec.id, "approved", d);
    expect(res).toEqual({ code: 1, outcome: "refused" });
    expect(lines.join("\n")).toContain("needs a person at a terminal");
    expect(approvalStatus(base, rec.id)?.state).toBe("pending");
  });

  test("at a terminal, showing the request and answering yes approves it", async () => {
    const rec = make();
    const { deps: d, lines } = deps();
    const res = await runDecision(rec.id, "approved", d);
    expect(res.outcome).toBe("approved");
    expect(lines.join("\n")).toContain("full codebase re-index");
    expect(lines.join("\n")).toContain("agent-x");
    expect(approvalStatus(base, rec.id)?.state).toBe("approved");
  });

  test("answering no leaves the request waiting", async () => {
    const rec = make();
    const { deps: d } = deps({ ask: () => Promise.resolve(false) });
    expect((await runDecision(rec.id, "approved", d)).outcome).toBe("cancelled");
    expect(approvalStatus(base, rec.id)?.state).toBe("pending");
  });

  test("deny records a denial", async () => {
    const rec = make();
    const { deps: d } = deps();
    expect((await runDecision(rec.id, "denied", d)).outcome).toBe("denied");
    expect(approvalStatus(base, rec.id)?.state).toBe("denied");
  });

  test("an unknown id is an error and nothing is created", async () => {
    const { deps: d, lines } = deps();
    const res = await runDecision("apr-000000000000", "approved", d);
    expect(res.code).toBe(1);
    expect(lines.join("\n")).toContain("No request");
  });

  test("--list shows waiting requests and hides finished ones unless asked", async () => {
    const rec = make();
    const out: string[] = [];
    await runList(base, (l) => out.push(l), false);
    expect(out.join("\n")).toContain(rec.id);
    await runDecision(rec.id, "denied", deps().deps);
    const after: string[] = [];
    await runList(base, (l) => after.push(l), false);
    expect(after.join("\n")).toContain("No requests are waiting");
    const all: string[] = [];
    await runList(base, (l) => all.push(l), true);
    expect(all.join("\n")).toContain("denied");
  });
});

describe("purix approve --show (AI-09)", () => {
  const withDiff = (diff: string, hash: string) =>
    requestOrConsume(base, {
      tool: "purix_modify",
      checkpointKind: "mcp_modify",
      componentId: "billing",
      args: { componentId: "billing", instruction: "x" },
      summary: "Modification: x",
      message: "short message",
      payload: { diff, diffHash: hash },
      client: "agent-x",
    }).record;

  test("prints the complete stored diff without a terminal and without changing the request", async () => {
    const { createHash } = await import("node:crypto");
    const diff = Array.from({ length: 300 }, (_, i) => `+ line ${i}`).join("\n");
    const rec = withDiff(diff, createHash("sha256").update(diff).digest("hex"));
    const lines: string[] = [];
    const res = await runShow(rec.id, { baseDir: base, print: (l) => lines.push(l) });
    expect(res.code).toBe(0);
    expect(lines.join("\n")).toContain("+ line 299");
    expect(lines.join("\n")).toContain("billing");
    expect(approvalStatus(base, rec.id)?.state).toBe("pending");
  });

  test("a stored diff that does not match its hash is flagged and exits non-zero", async () => {
    const rec = withDiff("+ tampered", "0".repeat(64));
    const lines: string[] = [];
    const res = await runShow(rec.id, { baseDir: base, print: (l) => lines.push(l) });
    expect(res.code).toBe(1);
    expect(lines.join("\n")).toContain("MISMATCH");
  });

  test("a request with no stored diff shows its message; an unknown id says so", async () => {
    const rec = make();
    const lines: string[] = [];
    expect((await runShow(rec.id, { baseDir: base, print: (l) => lines.push(l) })).code).toBe(0);
    expect(lines.join("\n")).toContain("carries no stored diff");
    expect(lines.join("\n")).toContain("full codebase re-index");
    const none: string[] = [];
    expect((await runShow("apr-000000000000", { baseDir: base, print: (l) => none.push(l) })).code).toBe(1);
    expect(none.join("\n")).toContain("No request");
  });
});
