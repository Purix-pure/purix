// P4 and P9 against a REAL model. Not a unit test: it makes up to about 30 paid model calls, so it is a script you run on purpose.
//
//   node --import tsx scripts/live-p4-p9.mts            (from the repo root, with the provider key already set up for Purix)
//
// What it does, in a throwaway project folder (your real project is never touched):
//   1. Seeds 6 components with the ids below.
//   2. Sends 10 fixed create requests to the planner twice:
//        BEFORE  = the planner as it was: classifyGreenfield(name, intent) with no conventions and no list of existing ids.
//        AFTER   = planNewComponent(name, intent): sees the existing ids, may retry once, drops ids that are still invented.
//   3. Counts valid depends_on (every id exists), invented ids, retries, and seconds per call.
// The 10 requests were written by hand by the code's author: 8 should depend on something that exists, 2 are controls that should
// depend on nothing. It is a small fixed set, so read the numbers as a before/after on THIS set, not a rate for real projects.
//
// P9 scope: the seconds below are the model planning step only (what planNewComponent waits on). A full purix_create also scaffolds,
// verifies and gates, so compare the real MCP request time in your editor against its own timeout as well.
// The key is never printed: only the provider id, the variable name and where it was found (stored or environment).
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProviderId, providerKeyStatus } from "../packages/core/src/llm/providers.ts";
import { classifyGreenfield } from "../packages/core/src/llm/classify.ts";
import { planNewComponent } from "../packages/core/src/entrypoints/create_plan.ts";
import { closeDb, writeManifest } from "../packages/core/src/manifest/store.ts";
import type { ManifestEntry } from "../packages/core/src/manifest/schema.ts";

const outDir = process.cwd();
let provider: string;
try {
  provider = activeProviderId(); // read here, in the folder you ran it from: the choice is saved per project, and the temp project below has none
} catch (err) {
  console.error(`${err instanceof Error ? err.message : String(err)}\nNo model call was made. Run the script from a folder where Purix already has a provider, or set PURIX_LLM_PROVIDER.`);
  process.exit(2);
}
if (provider === "custom") {
  console.error('The "custom" provider keeps its endpoint in the project config, which the temp project does not have. Use a built-in provider id for this run (set PURIX_LLM_PROVIDER); no model call was made.');
  process.exit(2);
}
process.env.PURIX_LLM_PROVIDER = provider; // carry the choice into the temp project
const key = providerKeyStatus(provider);
console.log(`provider: ${provider}; key variable: ${key?.envVar ?? "(none)"}; key source: ${key?.source ?? "(provider not configured)"}`);
if (!key || key.source === "missing") {
  console.error("No key found for this provider, so no model call was made. Set it up the way you normally do for Purix and run again.");
  process.exit(2);
}

const comp = (id: string, file: string): ManifestEntry => ({
  component_id: id, component_type: "module", current_version: 1, schema_version: 4, parts: { tools: [], config: {} },
  files: [file], depends_on: [], depended_on_by: [], version_history: [], verification_status: "pass", last_synced_hash: null,
});
const SEED = [
  comp("auth-session", "src/auth/session_store.ts"),
  comp("payment-gateway", "src/billing/stripe_adapter.ts"),
  comp("email-notifier", "src/notify/mailer.ts"),
  comp("rate-limiter", "src/middleware/throttle.ts"),
  comp("search-index", "src/search/tokenizer.ts"),
  comp("api-client", "src/net/http_client.ts"),
];
const KNOWN = new Set(SEED.map((s) => s.component_id));

// [name, intent, shouldDependOnSomething]
const REQUESTS: [string, string, boolean][] = [
  ["refund-service", "Refund payments through the existing payment gateway and notify the customer by email.", true],
  ["login-throttle", "Limit failed login attempts per user using the rate limiter and the auth session.", true],
  ["invoice-mailer", "Send an invoice email when a payment succeeds.", true],
  ["task-search-api", "An HTTP endpoint that queries the search index for tasks.", true],
  ["webhook-retry", "Retry failed outgoing webhooks using the api client, with backoff.", true],
  ["session-audit-log", "Record every session start and end from the auth session component.", true],
  ["usage-report", "A daily report of API calls per user, using the rate limiter's counters.", true],
  ["password-reset-flow", "Password reset: check the session, then email a reset link.", true],
  ["hex-to-hsl", "A pure function that converts hex colours to HSL.", false],
  ["slugify", "A pure function that converts titles to URL slugs.", false],
];

interface Row { name: string; should: boolean; beforeDeps: string[]; beforeInvalid: string[]; beforeSec: number; afterDeps: string[]; afterDropped: string[]; afterRetried: boolean; afterSec: number; error?: string }
const rows: Row[] = [];

const dir = mkdtempSync(join(tmpdir(), "purix-live-p4-"));
const oldCwd = process.cwd();
process.chdir(dir);
try {
  for (const s of SEED) writeManifest(s);
  for (const [name, intent, should] of REQUESTS) {
    const row: Row = { name, should, beforeDeps: [], beforeInvalid: [], beforeSec: 0, afterDeps: [], afterDropped: [], afterRetried: false, afterSec: 0 };
    try {
      let t = performance.now();
      const before = await classifyGreenfield(name, intent, {});
      row.beforeSec = (performance.now() - t) / 1000;
      row.beforeDeps = before.depends_on.filter((d) => KNOWN.has(d));
      row.beforeInvalid = before.depends_on.filter((d) => !KNOWN.has(d) && d !== before.component_id);
      t = performance.now();
      const after = await planNewComponent(name, intent);
      row.afterSec = (performance.now() - t) / 1000;
      row.afterDeps = after.plan.depends_on;
      row.afterDropped = after.droppedDependsOn;
      row.afterRetried = after.retried;
    } catch (err) {
      row.error = err instanceof Error ? err.message : String(err);
    }
    rows.push(row);
    console.log(`${name}: ${row.error ? "ERROR " + row.error : `before ${row.beforeDeps.length} valid/${row.beforeInvalid.length} invented (${row.beforeSec.toFixed(1)}s); after ${row.afterDeps.length} valid/${row.afterDropped.length} dropped, retried=${row.afterRetried} (${row.afterSec.toFixed(1)}s)`}`);
  }
} finally {
  process.chdir(oldCwd);
  closeDb();
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp folder */ }
}

const ok = rows.filter((r) => !r.error);
const dependers = ok.filter((r) => r.should);
const controls = ok.filter((r) => !r.should);
const secs = ok.map((r) => r.afterSec).sort((a, b) => a - b);
const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${n}/${d}`);
const summary = {
  provider, requestsRun: rows.length, requestsWithError: rows.length - ok.length,
  shouldDepend_nonEmptyValid_before: pct(dependers.filter((r) => r.beforeDeps.length > 0).length, dependers.length),
  shouldDepend_nonEmptyValid_after: pct(dependers.filter((r) => r.afterDeps.length > 0).length, dependers.length),
  requestsWithInventedIds_before: pct(ok.filter((r) => r.beforeInvalid.length > 0).length, ok.length),
  requestsWithInventedIds_afterFirstTry_retried: pct(ok.filter((r) => r.afterRetried).length, ok.length),
  requestsStillInvented_afterRetry_dropped: pct(ok.filter((r) => r.afterDropped.length > 0).length, ok.length),
  controls_wronglyNonEmpty_before: pct(controls.filter((r) => r.beforeDeps.length > 0).length, controls.length),
  controls_wronglyNonEmpty_after: pct(controls.filter((r) => r.afterDeps.length > 0).length, controls.length),
  planningSeconds_after: secs.length ? { min: +secs[0]!.toFixed(1), median: +secs[Math.floor(secs.length / 2)]!.toFixed(1), max: +secs[secs.length - 1]!.toFixed(1) } : null,
};
console.log("\n" + JSON.stringify(summary, null, 2));
const file = join(outDir, "live-p4-p9-results.json");
writeFileSync(file, JSON.stringify({ when: new Date().toISOString(), summary, rows }, null, 2));
console.log(`\nWrote ${file}. Send me that file.`);
