// packages/mcp-server/src/mcp_approval_and_paths.test.ts
//
// Covers the two MCP safety changes from PURIX-21 section 5: a person can approve gated
// actions through the connected agent (elicitation), and agent-supplied read paths are
// contained to the project.
import { describe, test, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createToolCaller,
  createElicitor,
  resolveContainedReadPath,
  toolSurfaceFingerprint,
  SERVER_INSTRUCTIONS,
  type Elicitor,
} from "./server";
import { closeDb, writeManifest } from "@purix/core/manifest/store";
import { decideApproval } from "@purix/core/approvals/pending";
import { listEvents } from "@purix/core/manifest/events";
import { safeRmSync } from "@purix/core/platform/fs_retry";

function seed(id: string) {
  writeManifest({
    component_id: id,
    component_type: "module",
    current_version: 1,
    schema_version: 5,
    parts: { tools: [], config: {} },
    files: [],
    depends_on: [],
    depended_on_by: [],
    version_history: [],
    verification_status: "pass",
    last_synced_hash: null,
    language: "typescript",
  });
}

describe("MCP human approval over elicitation", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let savedUserDir: string | undefined;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-approval-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-mcp-approval-user-"));
    savedUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = savedUserDir;
    delete process.env.PURIX_MCP_AUTO_APPROVE;
  });

  // purix_index with full:true is the cheapest gated action: it needs approval, and when it runs it
  // returns a JSON report that contains "fileCount".
  const GATED = { full: true };
  const RAN = "fileCount";

  test("a person who accepts the prompt lets the action run, and the audit trail says a person approved", async () => {
    const asked: string[] = [];
    const elicit: Elicitor = (message) => {
      asked.push(message);
      return Promise.resolve("accept");
    };
    const callTool = createToolCaller(elicit);
    const result = await callTool("purix_index", GATED);

    expect(asked.length).toBe(1);
    expect(result.content[0]!.text).toContain(RAN);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_elicitation_accepted");
    expect(ev).toBeDefined();
    expect(ev!.detail.auto_confirmed).toBeUndefined();
  });

  test("a person who declines stops the action and the message says so", async () => {
    const callTool = createToolCaller(() => Promise.resolve("decline"));
    const result = await callTool("purix_index", GATED);

    expect(result.content[0]!.text).toContain("you declined it");
    expect(result.content[0]!.text).not.toContain(RAN);
    expect(listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_elicitation_declined")).toBeDefined();
  });

  test("dismissing the prompt counts as a refusal", async () => {
    const callTool = createToolCaller(() => Promise.resolve("cancel"));
    const result = await callTool("purix_index", GATED);
    expect(result.content[0]!.text).toContain("you declined it");
    expect(result.content[0]!.text).not.toContain(RAN);
  });

  test("a failed prompt refuses the action and does not claim the person said no", async () => {
    const callTool = createToolCaller(() => Promise.resolve("error"));
    const result = await callTool("purix_index", GATED);
    expect(result.content[0]!.text).toContain("did not answer");
    expect(result.content[0]!.text).not.toContain(RAN);
    expect(listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_elicitation_error")).toBeDefined();
  });

  test("auto-approve skips the prompt entirely and is recorded as auto-approved, CI-only", async () => {
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    let asked = 0;
    const callTool = createToolCaller(() => {
      asked++;
      return Promise.resolve("decline");
    });
    const result = await callTool("purix_index", GATED);

    expect(asked).toBe(0);
    expect(result.content[0]!.text).toContain(RAN);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "mcp_auto_approve_session");
    expect(ev!.detail.auto_confirmed).toBe(true);
    expect(ev!.detail.ci_only_escape_hatch).toBe(true);
  });

  test("auto-approve is NOT honoured when strict isolation is on: the prompt still runs and the refusal is recorded", async () => {
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    const savedStrict = process.env.PURIX_STRICT_ISOLATION;
    process.env.PURIX_STRICT_ISOLATION = "1";
    try {
      let asked = 0;
      const callTool = createToolCaller(() => {
        asked++;
        return Promise.resolve("decline");
      });
      const result = await callTool("purix_index", GATED);

      expect(asked).toBe(1);
      expect(result.content[0]!.text).not.toContain(RAN);
      const events = listEvents({ kind: "confirm_response" });
      expect(events.find((e) => e.detail.reason === "mcp_auto_approve_session")).toBeUndefined();
      expect(events.find((e) => e.detail.reason === "mcp_auto_approve_refused_strict_isolation")).toBeDefined();
    } finally {
      if (savedStrict === undefined) delete process.env.PURIX_STRICT_ISOLATION;
      else process.env.PURIX_STRICT_ISOLATION = savedStrict;
    }
  });
});

describe("pending approval for clients without elicitation (C-30)", () => {
  let tmpDir: string;
  let userDir: string;
  let oldCwd: string;
  let savedUserDir: string | undefined;
  const GATED = { full: true };
  const RAN = "fileCount";
  const idOf = (text: string) => /apr-[0-9a-f]{12}/.exec(text)?.[0] ?? "";

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-pending-"));
    userDir = mkdtempSync(join(tmpdir(), "purix-mcp-pending-user-"));
    savedUserDir = process.env.PURIX_USER_DIR;
    process.env.PURIX_USER_DIR = userDir;
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(userDir);
    if (savedUserDir === undefined) delete process.env.PURIX_USER_DIR;
    else process.env.PURIX_USER_DIR = savedUserDir;
  });

  test("the first call returns a request id and does nothing", async () => {
    const callTool = createToolCaller(() => Promise.resolve("unsupported"));
    const result = await callTool("purix_index", GATED);
    const text = result.content[0]!.text;
    expect(text).toContain("needs a person's approval");
    expect(text).toContain(`purix approve ${idOf(text)}`);
    expect(text).not.toContain(RAN);
    expect(idOf(text)).not.toBe("");
  });

  test("the agent can read the status but has no way to approve", async () => {
    const callTool = createToolCaller(() => Promise.resolve("unsupported"));
    const id = idOf((await callTool("purix_index", GATED)).content[0]!.text);
    const status = JSON.parse((await callTool("purix_approval_status", { id })).content[0]!.text);
    expect(status.state).toBe("pending");
    // Extra arguments that look like approvals are ignored.
    const tricky = JSON.parse((await callTool("purix_approval_status", { id, approve: true, status: "approved" })).content[0]!.text);
    expect(tricky.state).toBe("pending");
    expect((await callTool("purix_index", GATED)).content[0]!.text).not.toContain(RAN);
  });

  test("after a person approves, the same call runs once, then asks again", async () => {
    const callTool = createToolCaller(() => Promise.resolve("unsupported"));
    const id = idOf((await callTool("purix_index", GATED)).content[0]!.text);
    expect(decideApproval(tmpDir, id, "approved").ok).toBe(true);

    const ran = await callTool("purix_index", GATED);
    expect(ran.content[0]!.text).toContain(RAN);
    const ev = listEvents({ kind: "confirm_response" }).find((e) => e.detail.reason === "pending_request_consumed");
    expect(ev?.detail.request_id).toBe(id);

    const again = await callTool("purix_index", GATED);
    expect(again.content[0]!.text).toContain("needs a person's approval");
    expect(idOf(again.content[0]!.text)).not.toBe(id);
  });

  test("a denial stops the action and tells the agent not to retry", async () => {
    const callTool = createToolCaller(() => Promise.resolve("unsupported"));
    const id = idOf((await callTool("purix_index", GATED)).content[0]!.text);
    decideApproval(tmpDir, id, "denied");
    const res = await callTool("purix_index", GATED);
    expect(res.content[0]!.text).toContain("denied");
    expect(res.content[0]!.text).toContain("Do not retry");
    expect(res.content[0]!.text).not.toContain(RAN);
  });

  test("an approval for one tool call does not cover a different one", async () => {
    const callTool = createToolCaller(() => Promise.resolve("unsupported"));
    const id = idOf((await callTool("purix_index", GATED)).content[0]!.text);
    decideApproval(tmpDir, id, "approved");
    seed("someone-else");
    const other = await callTool("purix_adopt", { target: "does-not-exist.ts" });
    expect(other.content[0]!.text).not.toContain(RAN);
  });
});

describe("createElicitor", () => {
  const form = {
    action: "accept" as const,
    content: { approve: true },
  };

  test("is unsupported when the client declared no elicitation", async () => {
    const elicit = createElicitor({ getClientCapabilities: () => ({}), elicitInput: () => Promise.reject(new Error("must not be called")) });
    expect(await elicit("ok?")).toBe("unsupported");
  });

  test("is unsupported when the client only declared URL mode", async () => {
    const elicit = createElicitor({
      getClientCapabilities: () => ({ elicitation: { url: {} } }),
      elicitInput: () => Promise.reject(new Error("must not be called")),
    });
    expect(await elicit("ok?")).toBe("unsupported");
  });

  test("an empty elicitation capability means form mode, per the spec's backward-compatibility rule", async () => {
    const elicit = createElicitor({ getClientCapabilities: () => ({ elicitation: {} }), elicitInput: () => Promise.resolve(form) });
    expect(await elicit("ok?")).toBe("accept");
  });

  test("accepting the form without ticking approve is a decline", async () => {
    const elicit = createElicitor({
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: () => Promise.resolve({ action: "accept", content: { approve: false } }),
    });
    expect(await elicit("ok?")).toBe("decline");
  });

  test("a transport failure is an error, never an approval", async () => {
    const elicit = createElicitor({
      getClientCapabilities: () => ({ elicitation: { form: {} } }),
      elicitInput: () => Promise.reject(new Error("closed")),
    });
    expect(await elicit("ok?")).toBe("error");
  });
});

describe("read-path containment", () => {
  let tmpDir: string;
  let outside: string;
  let oldCwd: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "purix-mcp-paths-"));
    outside = mkdtempSync(join(tmpdir(), "purix-mcp-outside-"));
    oldCwd = process.cwd();
    process.chdir(tmpDir);
    process.env.PURIX_MCP_AUTO_APPROVE = "1";
    delete process.env.PURIX_MCP_READ_ALLOW;
    mkdirSync(join(tmpDir, "src"));
    writeFileSync(join(tmpDir, "src", "a.patch"), "x");
    writeFileSync(join(outside, "secret.txt"), "secret");
  });

  afterEach(() => {
    closeDb();
    process.chdir(oldCwd);
    safeRmSync(tmpDir);
    safeRmSync(outside);
    delete process.env.PURIX_MCP_AUTO_APPROVE;
    delete process.env.PURIX_MCP_READ_ALLOW;
  });

  test("accepts a file and the project root itself", async () => {
    expect(await resolveContainedReadPath("src/a.patch", "p", tmpDir)).toContain("a.patch");
    expect(await resolveContainedReadPath(".", "p", tmpDir)).toBeTruthy();
  });

  test("refuses a path that climbs out of the project", async () => {
    await expect(resolveContainedReadPath("../../etc/passwd", "p", tmpDir)).rejects.toThrow(/outside the project/);
  });

  test("a missing path outside the project gets the same answer as an existing one (no probing)", async () => {
    await expect(resolveContainedReadPath(join(outside, "no-such-file.txt"), "p", tmpDir)).rejects.toThrow(/outside the project/);
    await expect(resolveContainedReadPath("../../../../no/such/place", "p", tmpDir)).rejects.toThrow(/outside the project/);
  });

  test("a missing path inside the project still says it does not exist", async () => {
    await expect(resolveContainedReadPath("src/missing.patch", "p", tmpDir)).rejects.toThrow(/does not exist/);
  });

  test("refuses an absolute path outside the project", async () => {
    await expect(resolveContainedReadPath(join(outside, "secret.txt"), "p", tmpDir)).rejects.toThrow(/outside the project/);
  });

  test("refuses a symlink inside the project that points outside it", async () => {
    try {
      symlinkSync(outside, join(tmpDir, "link"));
    } catch {
      return; // symlinks need privileges on some Windows setups; the other cases still cover the rule
    }
    await expect(resolveContainedReadPath("link/secret.txt", "p", tmpDir)).rejects.toThrow(/outside the project/);
  });

  test("an allowlisted folder is readable, and a missing allowlist entry grants nothing", async () => {
    await expect(resolveContainedReadPath(join(outside, "secret.txt"), "p", tmpDir, [outside])).resolves.toBeTruthy();
    await expect(resolveContainedReadPath(join(outside, "secret.txt"), "p", tmpDir, [join(outside, "nope")])).rejects.toThrow(/outside/);
  });

  test("a missing file and a NUL byte are both refused with a plain message", async () => {
    await expect(resolveContainedReadPath("src/missing.patch", "p", tmpDir)).rejects.toThrow(/does not exist/);
    await expect(resolveContainedReadPath("src/a\0.patch", "p", tmpDir)).rejects.toThrow(/non-empty path/);
  });

  test("purix_index refuses a path outside the project instead of indexing it", async () => {
    const callTool = createToolCaller();
    const result = await callTool("purix_index", { path: outside });
    expect(result.content[0]!.text).toMatch(/^Refused: path .* is outside the project directory/);
  });

  test("purix_ingest refuses a diff file outside the project instead of reading it", async () => {
    seed("ingest-target");
    const callTool = createToolCaller();
    const result = await callTool("purix_ingest", { componentId: "ingest-target", diffFilePath: join(outside, "secret.txt") });
    expect(result.content[0]!.text).toMatch(/^Refused: diffFilePath .* is outside the project directory/);
  });
});

describe("tool surface fingerprint and instructions", () => {
  test("the fingerprint is stable for the same surface and changes when a description changes", () => {
    const a = [
      { name: "b", description: "two", annotations: { readOnlyHint: true } },
      { name: "a", description: "one", annotations: { readOnlyHint: true } },
    ];
    const reordered = [a[1]!, a[0]!];
    const edited = [a[0]!, { ...a[1]!, description: "one, plus a hidden instruction" }];
    expect(toolSurfaceFingerprint(a)).toBe(toolSurfaceFingerprint(reordered));
    expect(toolSurfaceFingerprint(a)).not.toBe(toolSurfaceFingerprint(edited));
    expect(toolSurfaceFingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
  });

  test("the instructions state the limit of the guarantee", () => {
    expect(SERVER_INSTRUCTIONS).toContain("does not mean the code is correct or safe");
    expect(SERVER_INSTRUCTIONS).toContain("edits made without calling Purix are not seen");
  });
});
