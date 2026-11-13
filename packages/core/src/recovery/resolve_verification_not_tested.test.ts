// A pass that exercised nothing carries its not-tested files through resolveVerification, into the
// verification_pass event (which `purix status` reads), and a later fully-tested pass clears it.
import { describe, it, beforeEach, afterEach } from "node:test";
import { expect } from "expect";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveVerification } from "./resolve_verification.js";
import { closeDb } from "../manifest/store.js";
import { listEvents } from "../manifest/events.js";
import { latestNotTestedByComponent } from "../manifest/not_tested.js";
import { typescriptProvider } from "../language/providers/typescript.js";
import { safeRmSync } from "../platform/fs_retry.js";

let cwd: string, dir: string, logs: string[], realLog: typeof console.log;
beforeEach(() => { cwd = process.cwd(); dir = mkdtempSync(join(tmpdir(), "purix-resolve-nt-")); process.chdir(dir); logs = []; realLog = console.log; console.log = (...a: unknown[]) => { logs.push(a.join(" ")); }; });
afterEach(() => { console.log = realLog; closeDb(); process.chdir(cwd); safeRmSync(dir); });

let covered = false;
// With no language marker in the project, resolveLanguage() settles on typescript. Swap that provider's
// three checks for stubs (restored after each test) so no compiler or test runner is needed here.
// The three methods are only stored here and called back through typescriptProvider.
// eslint-disable-next-line @typescript-eslint/unbound-method
const real = { verify: typescriptProvider.verify, runTests: typescriptProvider.runTests, checkIdiom: typescriptProvider.checkIdiom };
beforeEach(() => {
  typescriptProvider.verify = () => ({ status: "pass", isolation: "none" });
  typescriptProvider.runTests = () => covered
    ? { status: "pass", quarantinedFailures: [], discovery: { tests: ["a.test.ts"], uncovered: [], truncated: false } }
    : { status: "no_tests", reason: "none", quarantinedFailures: [], discovery: { tests: [], uncovered: ["src/a.ts"], truncated: false } };
  typescriptProvider.checkIdiom = () => ({ ran: true, findings: [] });
});
afterEach(() => { Object.assign(typescriptProvider, real); });

const run = (component: string) =>
  resolveVerification(component, "update_prompt_text", [{ path: "src/a.ts", content: "a" }], [{ path: "src/a.ts", new_content: "b" }], "direct_patch", "x", dir);

describe("resolveVerification and not-tested", () => {
  it("returns notTested on the verification and records it in the verification_pass event", async () => {
    covered = false;
    const r = await run("comp-a");
    expect("finalFiles" in r && r.verification.status === "pass" && r.verification.notTested).toEqual(["src/a.ts"]);
    const ev = listEvents({ kind: "verification_pass", componentId: "comp-a" });
    expect(ev).toHaveLength(1);
    expect(ev[0]!.detail.not_tested).toEqual(["src/a.ts"]);
    expect(latestNotTestedByComponent().get("comp-a")).toEqual(["src/a.ts"]);
  });

  it("a later fully-tested pass clears the not-tested note; a component with no gap is absent", async () => {
    covered = false;
    await run("comp-b");
    expect(latestNotTestedByComponent().has("comp-b")).toBe(true);
    covered = true;
    await run("comp-b");
    const ev = listEvents({ kind: "verification_pass", componentId: "comp-b" }).at(-1)!;
    expect(ev.detail.not_tested).toBeUndefined();
    expect(latestNotTestedByComponent().has("comp-b")).toBe(false);
  });
});
