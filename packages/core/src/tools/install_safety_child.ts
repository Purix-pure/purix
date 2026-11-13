// packages/core/src/tools/install_safety_child.ts — test-only child process for install_safety.test.ts.
// Runs one installTool against a shared project folder with a fake runner and a consent gate that waits, so two
// children are guaranteed to overlap. Writes { ok, reason? } to the file named by its last argument (core code may not print).
import { writeFileAtomic } from "../platform/atomic_write.js";
import { installTool } from "./broker.js";
import { fakeRunner, memoryAudit, npmEntry } from "./test_helpers.js";

const [baseDir, id, waitMs, outFile] = process.argv.slice(2);
const a = npmEntry({ id: "demojs", bin: "demojs" });
const b = npmEntry({ id: "otherjs", bin: "demojs" });
const consent = { confirmInstall: async () => { await new Promise((r) => setTimeout(r, Number(waitMs))); return true; } };
const r = await installTool({ baseDir: baseDir!, catalog: [a, b], platform: "linux", runner: fakeRunner(), audit: memoryAudit(), consent, now: () => new Date("2026-11-01T00:00:00Z") }, id!);
writeFileAtomic(outFile!, JSON.stringify({ ok: r.ok, ...(r.ok ? {} : { reason: r.reason }) }));
