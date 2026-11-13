#!/usr/bin/env node
// purix-evidence-verify.mjs: an independent verifier for Purix evidence bundles.
//
// It shares no code with Purix and imports only Node built-ins. Read it, copy it, run it without installing Purix.
// It re-implements the one rule for the audit chain:
//     hash = sha256( prev_hash + "|" + timestamp + "|" + payload )
// and checks that every record links to the one before it, from genesis (or from a recorded checkpoint) to the head.
//
// Usage:
//   node purix-evidence-verify.mjs <bundle.json> [--commit <rev>] [--expect-head <hex>] [--json]
//
//   --commit <rev>       read the Purix-Evidence trailer from that commit (needs git) and check the chain contains it
//   --expect-head <hex>  the same check against a hash you hold from somewhere else (a PR comment, a ticket)
//   --require-anchor     exit 1 when neither of the two above is given (use this in CI)
//
// Exit codes: 0 verified (or, without an anchor, consistent but NOT anchored: a warning, not a pass); 1 FAILED; 2 could not run.
//
// Why the anchor matters: a hash chain alone cannot show that its newest records were cut off. Deleting the tail leaves a
// valid chain behind, so a chain with no anchor is reported as "CONSISTENT, NOT ANCHORED", never as "VERIFIED".
//
// What a pass means: the records in the bundle are internally consistent, and (with --commit or --expect-head) the chain
// contains the head that was committed, so nothing before that point was altered or cut out afterwards.
// What it does not mean: that the tests were meaningful or the code is right. The per-component table in the bundle is
// a convenience summary and is NOT covered by the hashes; only the chain is.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const GENESIS = "0".repeat(64);
const HEX64 = /^[0-9a-f]{64}$/;

function fail(msg) {
  return { ok: false, msg };
}

export function verifyChain(rows, checkpoint) {
  if (!Array.isArray(rows)) return fail("bundle has no chain rows");
  let expected = GENESIS;
  if (rows.length > 0 && checkpoint && Number.isInteger(checkpoint.last_pruned_id) && rows[0].id > checkpoint.last_pruned_id) {
    if (typeof checkpoint.checkpoint_hash !== "string" || !HEX64.test(checkpoint.checkpoint_hash)) return fail("checkpoint hash is malformed");
    expected = checkpoint.checkpoint_hash;
  }
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    if (!r || typeof r.payload !== "string" || typeof r.timestamp !== "string" || typeof r.prev_hash !== "string" || typeof r.hash !== "string") {
      return fail(`record ${i} is malformed`);
    }
    // Legacy shape: older Purix versions restarted from genesis after a prune that removed every record.
    const legacyRestart = i === 0 && checkpoint && Number.isInteger(checkpoint.last_pruned_id) && r.id > checkpoint.last_pruned_id && r.prev_hash === GENESIS;
    if (r.prev_hash !== expected && !legacyRestart) {
      return fail(i === 0 ? `the chain does not start at its beginning and no checkpoint explains it (records before id ${r.id} are missing)` : `record id ${r.id} does not link to the record before it`);
    }
    const h = createHash("sha256").update(`${r.prev_hash}|${r.timestamp}|${r.payload}`).digest("hex");
    if (h !== r.hash) return fail(`record id ${r.id} was altered (its hash does not match its content)`);
    expected = r.hash;
  }
  return { ok: true, head: expected, count: rows.length };
}

function trailerFromCommit(rev) {
  const log = spawnSync("git", ["log", "-1", "--format=%B", rev], { encoding: "utf8" });
  if (log.error || log.status !== 0) return { error: `could not read commit "${rev}" with git: ${(log.stderr || log.error?.message || "").trim()}` };
  const parsed = spawnSync("git", ["interpret-trailers", "--parse"], { input: log.stdout, encoding: "utf8" });
  if (parsed.error || parsed.status !== 0) return { error: "git interpret-trailers failed" };
  const lines = parsed.stdout.split(/\r?\n/).filter((l) => l.startsWith("Purix-Evidence:"));
  if (lines.length === 0) return { error: `commit "${rev}" has no Purix-Evidence trailer` };
  if (lines.length > 1) return { error: `commit "${rev}" has ${lines.length} Purix-Evidence trailers; expected one` };
  const m = /^Purix-Evidence:\s*sha256:([0-9a-f]{64})\s*$/.exec(lines[0]);
  if (!m) return { error: "the Purix-Evidence trailer is malformed" };
  return { hash: m[1] };
}

export function verifyBundle(bundle, anchor) {
  const findings = [];
  if (!bundle || bundle.schema !== "purix.evidence/1") return { ok: false, findings: ["not a purix.evidence/1 bundle"] };
  const chain = verifyChain(bundle.chain?.rows, bundle.chain?.checkpoint ?? null);
  if (!chain.ok) return { ok: false, findings: [`chain: ${chain.msg}`] };
  findings.push(`chain intact: ${chain.count} record(s), head ${chain.head}`);
  if (bundle.head && bundle.head.hash !== chain.head) return { ok: false, findings: [...findings, "the bundle's stated head does not match the head computed from its records"] };
  if (anchor) {
    if (anchor === GENESIS && chain.count === 0) {
      findings.push("anchor: committed against an empty chain");
    } else {
      const idx = bundle.chain.rows.findIndex((r) => r.hash === anchor);
      if (idx === -1) return { ok: false, findings: [...findings, `anchor: the committed head ${anchor} is NOT in this chain, so the records were rewritten or cut back after the commit`] };
      findings.push(`anchor: the committed head is record ${idx + 1} of ${chain.count}; ${chain.count - idx - 1} later record(s) were added after the commit`);
    }
  } else {
    findings.push("anchor: none given. The chain is self-consistent, but its newest records could have been cut off, or the whole chain rebuilt; pass --commit or --expect-head to rule that out");
  }
  return { ok: true, findings, anchored: Boolean(anchor) };
}

function main(argv) {
  const args = argv.slice(2);
  const json = args.includes("--json");
  const take = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const file = args.find((a, i) => !a.startsWith("--") && !(i > 0 && ["--commit", "--expect-head"].includes(args[i - 1])));
  const out = (res, code) => {
    if (json) process.stdout.write(JSON.stringify(res, null, 2) + "\n");
    else {
      process.stdout.write((!res.ok ? "FAILED" : res.anchored ? "VERIFIED" : "CONSISTENT, NOT ANCHORED") + "\n");
      for (const f of res.findings) process.stdout.write(`  ${f}\n`);
      if (res.ok) process.stdout.write("  not covered: whether the tests were meaningful; the per-component table (unsigned summary)\n");
    }
    process.exit(code);
  };
  if (!file) return out({ ok: false, findings: ["usage: purix-evidence-verify.mjs <bundle.json> [--commit <rev>] [--expect-head <hex>] [--json]"] }, 2);
  let bundle;
  try {
    bundle = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return out({ ok: false, findings: [`could not read the bundle: ${e.message}`] }, 2);
  }
  let anchor;
  const commit = take("--commit");
  const expect = take("--expect-head");
  if (commit && expect) return out({ ok: false, findings: ["give --commit or --expect-head, not both"] }, 2);
  if (expect) {
    if (!HEX64.test(expect)) return out({ ok: false, findings: ["--expect-head must be 64 lowercase hex characters"] }, 2);
    anchor = expect;
  } else if (commit) {
    const t = trailerFromCommit(commit);
    if (t.error) return out({ ok: false, findings: [t.error] }, 2);
    anchor = t.hash;
  }
  const res = verifyBundle(bundle, anchor);
  if (res.ok && !res.anchored && args.includes("--require-anchor")) {
    return out({ ok: false, findings: [...res.findings, "--require-anchor was given and no anchor was supplied"] }, 1);
  }
  return out(res, res.ok ? 0 : 1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv);
