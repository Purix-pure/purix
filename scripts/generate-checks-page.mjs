#!/usr/bin/env node
// scripts/generate-checks-page.mjs: plan 0.5. Writes docs/WHAT_PURIX_CHECKS.md, the one honest page that says what Purix checks
// and what it does not, from the claims register (docs/claims.json) and the real-agent run log (docs/client-runs.json).
//
//   node scripts/generate-checks-page.mjs           write the page
//   node scripts/generate-checks-page.mjs --check   exit 1 when the committed page differs from what the register says now
//
// The page holds no hand-written fact. The headline limits are quoted from named register rows (HEADLINE below), so a limit cannot
// be reworded on the page without changing the register, and a row that is removed makes this script fail instead of dropping the
// limit silently. Output is deterministic: no clock, no machine facts. The only date is the newest "checked" date in the register.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PAGE_PATH = "docs/WHAT_PURIX_CHECKS.md";

/** The limits a reader must see before anything else. Each is a register row id; the label is the only text written here. */
export const HEADLINE = [
  { label: "Languages", ids: ["COMPL-009", "BETA-SCOPE-UNSUPPORTED-LANG"] },
  { label: "Hooks", ids: ["README-017", "README-034"] },
  { label: "Isolation", ids: ["README-026", "README-027"] },
  { label: "Confidence cutoff", ids: ["README-028"] },
  { label: "Secrets", ids: ["README-032"] },
  { label: "Dependency scan", ids: ["COMPL-004", "README-033"] },
  { label: "Tests", ids: ["README-025"] },
];

const STATUS_MEANING = {
  tested: "A test or gate in this repository asserts the sentence. It does not mean a second person has re-run it.",
  simulated: "Checked only against simulated agents or payloads, or by the author of the change in one run.",
  "stated-limit": "The sentence is itself a limit Purix states about its own behaviour.",
  unverified: "A research finding. Nobody except its author has re-run it, so read it as reported.",
};
const STATUS_ORDER = ["tested", "simulated", "stated-limit", "unverified"];

const flat = (t) => String(t ?? "").replace(/\s+/g, " ").trim();
/** The page never contains an em dash, whatever the register holds. */
const plain = (t) => flat(t).replace(/\s*—\s*/g, ", ");
const cell = (t) => plain(t).replace(/\|/g, "\\|");
const quote = (t) => {
  const s = plain(t);
  // Many register rows quote a fragment of a longer sentence; show that honestly instead of dressing it up.
  return `“${/^[a-z]/.test(s) ? "…" : ""}${s}”`;
};
const cap = (t, n) => (t.length > n ? `${t.slice(0, n - 3).trimEnd()}...` : t);
const evidenceLine = (row) =>
  (row.evidence ?? [])
    .map((e) => (e.file ? `\`${e.file}\`` : e.gate ? `gate \`${e.gate}\`` : ""))
    .filter(Boolean)
    .filter((v, i, a) => a.indexOf(v) === i)
    .join(", ");

function newestChecked(rows) {
  return rows.map((r) => r.checked).filter(Boolean).sort().at(-1) ?? "not recorded";
}

function runsSection(runs) {
  if (runs.length === 0) {
    return [
      "No run of a real coding agent is on file. Every agent is listed as not verified with the real client in `docs/CLIENT_SUPPORT.md`.",
    ];
  }
  const out = [
    `${runs.length === 1 ? "One run" : `${runs.length} runs`} of a real coding agent with Purix connected ${runs.length === 1 ? "is" : "are"} on file in \`docs/client-runs.json\`. Agents and systems not listed here have not been run for real.`,
    "",
    "| Agent | Version | System | Date | Result | Hook calls |",
    "| --- | --- | --- | --- | --- | --- |",
  ];
  for (const r of runs) {
    const version = !r.version || /^</.test(r.version) ? "not recorded" : r.version;
    out.push(`| ${cell(r.client)} | ${cell(version)} | ${cell(r.os)} | ${cell(r.date)} | ${r.pass ? "pass" : "fail"} | ${r.hookCalls ?? "n/a"} |`);
  }
  return out;
}

function bulletsFor(rows, { withNote = false } = {}) {
  const out = [];
  for (const r of rows) {
    const ev = evidenceLine(r);
    let line = `- ${quote(r.text)} (${r.id}; ${r.source.replace(/^docs\/research\//, "research: ").replace(/\.md$/, "")})`;
    if (ev) line += `. Evidence: ${ev}.`;
    out.push(line);
    if (withNote && r.note) out.push(`  - Note: ${plain(r.note)}`);
    if (r.addressed) out.push(`  - Since then: ${plain(r.addressed)}`);
  }
  return out;
}

/** Pure: ledger and runs in, page text out. */
export function render(ledger, clientRuns) {
  const rows = ledger.claims;
  const byId = new Map(rows.map((r) => [r.id, r]));
  const runs = clientRuns?.runs ?? [];
  const count = (s) => rows.filter((r) => r.status === s).length;

  const missing = HEADLINE.flatMap((h) => h.ids).filter((id) => !byId.has(id));
  if (missing.length > 0) {
    throw new Error(`generate-checks-page: headline row(s) missing from docs/claims.json: ${missing.join(", ")}. Restore the row or change HEADLINE in this script.`);
  }
  const unknownStatus = rows.filter((r) => !STATUS_ORDER.includes(r.status));
  if (unknownStatus.length > 0) {
    throw new Error(`generate-checks-page: unknown status on ${unknownStatus.map((r) => r.id).join(", ")}`);
  }

  const out = [];
  const p = (...l) => out.push(...l);

  p(
    "# What Purix checks and what it does not",
    "",
    "<!-- Generated by scripts/generate-checks-page.mjs from docs/claims.json and docs/client-runs.json. Do not edit by hand: change the register and run the script. -->",
    "",
    `Generated from the claims register, whose newest entry is dated ${newestChecked(rows)}. This page describes Release 1: a command-line tool and an MCP server on your own machine. Scope and language details are in [BETA_SCOPE.md](../BETA_SCOPE.md).`,
    "",
    "## The limits first",
    "",
    "Read these before relying on a result. Each sentence is quoted from the register row named after it.",
    ""
  );
  for (const h of HEADLINE) {
    p(`- **${h.label}.** ${h.ids.map((id) => `${quote(byId.get(id).text)} (${id})`).join(" ")}`);
  }
  p(
    "",
    "Windows, macOS and Cursor are experimental. Results are reported, not settled: the register has no status that means a second person has re-run a result, so none of it is called settled.",
    "",
    "## Real agents that have been run",
    "",
    ...runsSection(runs),
    "",
    "## How much evidence stands behind each sentence",
    "",
    `The register holds ${rows.length} rows.`,
    "",
    "| Status | Rows | What it means |",
    "| --- | --- | --- |",
    ...STATUS_ORDER.map((s) => `| ${s} | ${count(s)} | ${STATUS_MEANING[s]} |`),
    ""
  );

  const section = (title, intro, status, opts) => {
    const list = rows.filter((r) => r.status === status);
    p(`## ${title}`, "", intro, "");
    if (list.length === 0) p("None.");
    else p(...opts(list));
    p("");
  };

  section(
    "What Purix checks",
    "Each sentence below has a named test or gate that asserts it.",
    "tested",
    (list) => bulletsFor(list, { withNote: true })
  );
  section(
    "Checked only in simulation",
    "These have been exercised with simulated agents or payloads, or in one run by the person who made the change. They are the first candidates for a re-run by someone else.",
    "simulated",
    (list) => bulletsFor(list, { withNote: true })
  );
  section(
    "Limits Purix states about itself",
    "Each of these is something Purix does not do, or does only in part.",
    "stated-limit",
    (list) => bulletsFor(list, { withNote: true })
  );

  const STATE = { fixed: "fixed in the tree", still_holds: "still open", partly_fixed: "partly fixed", cannot_tell: "could not be decided" };
  const IR_STATE = { confirms: "confirmed", confirms_with_gaps: "confirmed with gaps", disagrees: "disagrees with the fix" };
  const fixCell = (r) => {
    if (r.recheck) {
      const ir = r.fix?.independent_read;
      const readLine = ir
        ? ` Fix landed ${r.fix.date}; read again ${ir.date} by a session that did not write it, ${IR_STATE[ir.current] ?? ir.current}: ${cap(plain(ir.note), 150)}`
        : ` Fix landed ${r.fix?.date}, read by no one but its author: ${cap(plain(r.fix?.note ?? ""), 150)}`;
      const later = r.fix ? readLine : "";
      return cell(`Re-checked ${r.recheck.date}: ${STATE[r.recheck.current] ?? r.recheck.current}. ${cap(plain(r.recheck.note ?? ""), 170)}${later}`);
    }
    return r.addressed ? cell(cap(plain(r.addressed), 200)) : "no fix recorded";
  };
  const unverified = rows.filter((r) => r.status === "unverified");
  p(
    "## Research findings: what is still open",
    "",
    "These came from the research documents in `docs/research/`. Each says how the fact was obtained (read the code, ran it, or both) and by whom. Where a fix has landed, the last column says what changed. Rows that say Re-checked were read again against the current code by sessions that did not write the finding, and the named tests were run on Linux with a stubbed model; that is not a real-agent, Windows or macOS run, so no row is called settled.",
    ""
  );
  if (unverified.length === 0) p("None.");
  else {
    const groups = new Map();
    for (const r of unverified) groups.set(r.source, [...(groups.get(r.source) ?? []), r]);
    for (const [source, list] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      p(`### ${source.replace(/^docs\/research\/PURIX-RESEARCH-/, "Research ").replace(/\.md$/, "").replace(/-/g, " ").toLowerCase().replace(/^research/, "Research")}`, "");
      p("| ID | Finding | Obtained | Fix status |", "| --- | --- | --- | --- |");
      for (const r of list) {
        p(`| ${r.id} | ${cell(cap(plain(r.text), 200))} | ${cell(r.obtained ?? "n/a")} | ${fixCell(r)} |`);
      }
      p("");
    }
  }

  p(
    "## What this page does not cover",
    "",
    "Purix is not certified against ISO/IEC 42001 or the EU AI Act, and nothing here claims it is. The compliance documents in `docs/compliance/` describe what the code does today and list known gaps. A test that passes shows what Purix's checks reported on one machine and nothing more.",
    ""
  );

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";
}

function main() {
  const ledger = JSON.parse(readFileSync(join(root, "docs", "claims.json"), "utf-8"));
  const runsPath = join(root, "docs", "client-runs.json");
  const runs = existsSync(runsPath) ? JSON.parse(readFileSync(runsPath, "utf-8")) : { runs: [] };
  const text = render(ledger, runs);
  const target = join(root, PAGE_PATH);
  if (process.argv.includes("--check")) {
    const current = existsSync(target) ? readFileSync(target, "utf-8") : null;
    if (current === text) {
      console.log(`generate-checks-page: ${PAGE_PATH} is up to date`);
      return;
    }
    console.error(`generate-checks-page: ${PAGE_PATH} is ${current === null ? "missing" : "out of date"}. Run: node scripts/generate-checks-page.mjs`);
    process.exit(1);
  }
  writeFileSync(target, text);
  console.log(`generate-checks-page: wrote ${PAGE_PATH} (${text.split("\n").length} lines)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
