#!/usr/bin/env node
// scripts/check-claims.mjs: C-58 (PURIX-36). The claim ledger gate.
//
// docs/claims.json maps public sentences to the stored test, gate or log that backs them. This script fails when:
//   1. a ledger claim's text is no longer in the file it points at (the sentence was edited: re-map it, or drop it);
//   2. a ledger row's evidence file is missing, or the named test/assertion/gate text is no longer in it;
//   3. a row is marked "tested" or "simulated" but lists no evidence (only "stated-limit" and "unverified" may have none);
//   4. a banned phrase (the claims PURIX-21 removed) appears anywhere in public copy;
//   5. README.md has MORE unmapped claim-shaped sentences than docs/claims-baseline.json allows (a ratchet: the number may only fall;
//      run with --update after mapping sentences to lower it);
//   6. a relative link in public markdown points at a file that does not exist (WARN locally, FAIL when CI is set or --strict-links);
//   7. a compliance file kept in two places (docs/compliance/X.md and docs/compliance/<folder>/X.md) has drifted apart. The two copies
//      must be byte-identical; before this check the data-and-dependency copy at the top level was missing months of changes.
//
// What this gate does NOT do: it does not judge whether the evidence really proves the sentence. It makes sure the evidence still exists
// and that nobody can add a claim-shaped sentence without either mapping it or being counted. A person reads the ledger for the rest.
// Evidence kinds: { file, contains } the file must exist and contain that exact text (a test name or an assertion);
//                 { gate, file } a script or workflow that must exist (the gate is run elsewhere).
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const update = args.includes("--update");
const strictLinks = args.includes("--strict-links") || Boolean(process.env.CI);
const ledgerPath = join(root, "docs", "claims.json");
const baselinePath = join(root, "docs", "claims-baseline.json");
if (!existsSync(ledgerPath)) { console.error(`check-claims: ${ledgerPath} not found`); process.exit(2); }
const ledger = JSON.parse(readFileSync(ledgerPath, "utf-8"));
const problems = [];
const warnings = [];
const norm = (t) => t.replace(/\s+/g, " ").trim();
const read = (p) => readFileSync(join(root, p), "utf-8");

// ---- 1-3: the ledger rows ----
const ids = new Set();
for (const c of ledger.claims) {
  if (ids.has(c.id)) problems.push(`${c.id}: duplicate id`);
  ids.add(c.id);
  if (!existsSync(join(root, c.source))) { problems.push(`${c.id}: source file ${c.source} does not exist`); continue; }
  if (!norm(read(c.source)).includes(norm(c.text))) problems.push(`${c.id}: the sentence is no longer in ${c.source}: "${c.text.slice(0, 80)}..." (re-map it or remove the row)`);
  if (!["tested", "simulated", "stated-limit", "unverified"].includes(c.status)) problems.push(`${c.id}: unknown status "${c.status}"`);
  if ((c.status === "tested" || c.status === "simulated") && (!c.evidence || c.evidence.length === 0)) problems.push(`${c.id}: status ${c.status} but no evidence listed`);
  // A1: the two-field evidence convention. A "finding" row says HOW the fact was obtained and BY WHOM, so a reader can tell a
  // number someone ran from one someone only read, and an author's own result from a re-check by a different session.
  if (c.kind === "finding") {
    if (!["read", "run", "read+run"].includes(c.obtained)) problems.push(`${c.id}: finding rows need obtained = read | run | read+run (got "${c.obtained}")`);
    if (typeof c.by !== "string" || c.by.trim() === "") problems.push(`${c.id}: finding rows need a "by" field saying who obtained it`);
  }
  // Nov 7: a "recheck" block records a later re-read of a finding against the current code. It never changes the row's status
  // (the sentence still describes what the research author found), but its quotes must still be in the files it names.
  if (c.recheck) {
    if (!["fixed", "still_holds", "partly_fixed", "cannot_tell"].includes(c.recheck.current)) problems.push(`${c.id}: recheck.current "${c.recheck.current}" is not fixed | still_holds | partly_fixed | cannot_tell`);
    if (!c.recheck.date || !c.recheck.by || !c.recheck.note) problems.push(`${c.id}: recheck needs date, by and note`);
    for (const e of c.recheck.evidence ?? []) {
      if (!existsSync(join(root, e.file))) problems.push(`${c.id}: recheck evidence file ${e.file} does not exist`);
      else if (e.contains !== undefined && !read(e.file).includes(e.contains)) problems.push(`${c.id}: recheck evidence ${e.file} no longer contains "${e.contains.slice(0, 70)}"`);
    }
  }
  // A "fix" block records a fix landed AFTER the re-check, by the session that wrote it. It never replaces the re-check's verdict and is
  // never "settled": it needs a date, who wrote it, and what was and was not covered, and its quotes must still be in the files.
  if (c.fix) {
    if (!c.fix.date || !c.fix.by || !c.fix.note || !c.fix.not_covered) problems.push(`${c.id}: fix needs date, by, note and not_covered`);
    for (const e of c.fix.evidence ?? []) {
      if (!existsSync(join(root, e.file))) problems.push(`${c.id}: fix evidence file ${e.file} does not exist`);
      else if (e.contains !== undefined && !read(e.file).includes(e.contains)) problems.push(`${c.id}: fix evidence ${e.file} no longer contains "${e.contains.slice(0, 70)}"`);
    }
    // 2026-11-10: an independent read of a fix, by a session that did not write it. It is a second reader, not a person, so it never
    // moves a row to settled; it must say who, when and what it found, and may not be signed by the fix's own author.
    const ir = c.fix.independent_read;
    if (ir) {
      if (!ir.date || !ir.by || !ir.note) problems.push(`${c.id}: fix.independent_read needs date, by and note`);
      if (!["confirms", "confirms_with_gaps", "disagrees"].includes(ir.current)) problems.push(`${c.id}: fix.independent_read.current "${ir.current}" is not confirms | confirms_with_gaps | disagrees`);
      if (ir.by && c.fix.by && ir.by.trim() === c.fix.by.trim()) problems.push(`${c.id}: fix.independent_read.by is the fix's own author`);
      for (const e of ir.evidence ?? []) {
        if (!existsSync(join(root, e.file))) problems.push(`${c.id}: independent_read evidence file ${e.file} does not exist`);
        else if (e.contains !== undefined && !read(e.file).includes(e.contains)) problems.push(`${c.id}: independent_read evidence ${e.file} no longer contains "${e.contains.slice(0, 70)}"`);
      }
    }
  }
  for (const e of c.evidence ?? []) {
    if (!existsSync(join(root, e.file))) { problems.push(`${c.id}: evidence file ${e.file} does not exist`); continue; }
    if (e.contains !== undefined && !read(e.file).includes(e.contains)) problems.push(`${c.id}: ${e.file} no longer contains "${e.contains.slice(0, 70)}"`);
  }
}

// ---- 4: banned phrases in public copy ----
function walk(dir, out = []) {
  for (const f of readdirSync(dir)) {
    if (["node_modules", ".git", ".test-logs", ".release-check", ".purix", ".purix-tmp", "dist", ".turbo", "coverage"].includes(f)) continue;
    const p = join(dir, f);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}
const publicMd = walk(root).filter((p) => /\.(md|mdx)$/i.test(p)).map((p) => relative(root, p).split("\\").join("/"));
const publicCopy = [...publicMd, ...walk(join(root, "packages")).filter((p) => /\.(html|astro|tsx|json)$/.test(p) && /web|site|landing/i.test(p)).map((p) => relative(root, p).split("\\").join("/"))];
for (const f of new Set(publicCopy)) {
  const text = read(f).toLowerCase();
  for (const b of ledger.banned ?? []) if (text.includes(b.toLowerCase())) problems.push(`banned phrase "${b}" in ${f}`);
}

// ---- 5: unmapped claim-shaped sentences in README.md (ratchet) ----
function sentences(md) {
  const out = [];
  let inCode = false;
  let para = [];
  const flush = () => { if (para.length) out.push(...norm(para.join(" ")).split(/(?<=[.!?])\s+(?=[A-Z`*])/)); para = []; };
  for (const line of md.split(/\r?\n/)) {
    if (/^```/.test(line)) { flush(); inCode = !inCode; continue; }
    if (inCode || /^\s*\|/.test(line) || /^#{1,6}\s/.test(line) || line.trim() === "") { flush(); continue; }
    para.push(line.replace(/^\s*[-*]\s+/, ""));
  }
  flush();
  return out.map(norm).filter((s) => s.length > 25);
}
const TRIGGER = /\b(never|always|only|every|blocks?|refuses?|cannot|guarantee[sd]?|verified|proof|safe|secure|exactly|once|expires?|isolated|sandbox|signed|audit trail|no network|makes no|without a)\b/i;
const mapped = ledger.claims.filter((c) => c.source === "README.md").map((c) => norm(c.text));
const unmapped = sentences(read("README.md")).filter((s) => TRIGGER.test(s) && !mapped.some((m) => s.includes(m) || m.includes(s)));
if (args.includes("--list-unmapped")) for (const u of unmapped) console.log("UNMAPPED " + u.slice(0, 200));
const baseline = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf-8")) : { readmeUnmapped: Infinity };
if (update) {
  if (unmapped.length > baseline.readmeUnmapped) { console.error(`--update refuses to raise the baseline (${baseline.readmeUnmapped} -> ${unmapped.length})`); process.exit(1); }
  writeFileSync(baselinePath, JSON.stringify({ note: "README.md sentences that look like claims and are not in docs/claims.json. May only fall. See scripts/check-claims.mjs.", readmeUnmapped: unmapped.length }, null, 2) + "\n");
  console.log(`baseline set to ${unmapped.length}`);
} else if (unmapped.length > baseline.readmeUnmapped) {
  problems.push(`README.md has ${unmapped.length} unmapped claim-shaped sentences, baseline allows ${baseline.readmeUnmapped}. Map the new ones in docs/claims.json:\n` + unmapped.map((s) => `       - ${s.slice(0, 140)}`).join("\n"));
}

// ---- 6: relative links ----
for (const f of publicMd.filter((p) => !p.startsWith("docs/compliance/") || true)) {
  const base = dirname(f);
  for (const m of read(f).matchAll(/\]\(((?:\.\/|\.\.\/)?[^)\s#:]+)(?:#[^)]*)?\)/g)) {
    const target = m[1];
    if (/^(https?|mailto):/.test(target)) continue;
    if (!existsSync(join(root, base, target)) && !existsSync(join(root, target))) (strictLinks ? problems : warnings).push(`broken link in ${f}: ${target}`);
  }
}

// 7. Duplicated compliance files. Only the pairs below are copies; SECURITY.md and CONTRIBUTING.md differ on purpose (relative links).
for (const [a, b] of [
  ["docs/compliance/ai-management-system-scope.md", "docs/compliance/iso-42001/ai-management-system-scope.md"],
  ["docs/compliance/ai-system-lifecycle-controls.md", "docs/compliance/iso-42001/ai-system-lifecycle-controls.md"],
  ["docs/compliance/data-and-dependency-governance.md", "docs/compliance/iso-42001/data-and-dependency-governance.md"],
  ["docs/compliance/technical-documentation.md", "docs/compliance/eu-ai-act/technical-documentation.md"],
  ["docs/compliance/post-market-monitoring.md", "docs/compliance/eu-ai-act/post-market-monitoring.md"],
]) {
  if (!existsSync(join(root, a)) || !existsSync(join(root, b))) { problems.push(`compliance copy missing: ${!existsSync(join(root, a)) ? a : b}`); continue; }
  if (read(a) !== read(b)) problems.push(`${a} and ${b} have drifted apart: edit one and copy it over the other`);
}

const statusCount = ledger.claims.reduce((a, c) => ((a[c.status] = (a[c.status] ?? 0) + 1), a), {});
console.log(`claims: ${ledger.claims.length} rows (${Object.entries(statusCount).map(([k, v]) => `${k} ${v}`).join(", ")}); README unmapped claim-shaped sentences: ${unmapped.length} (baseline ${baseline.readmeUnmapped})`);
for (const w of warnings) console.log(`WARN ${w}`);
if (problems.length) {
  for (const p of problems) console.error(`FAIL ${p}`);
  console.error(`\ncheck-claims: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log("check-claims: ok");
