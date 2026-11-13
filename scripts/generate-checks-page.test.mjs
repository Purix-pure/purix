// Tests for scripts/generate-checks-page.mjs. Run: node --test scripts/generate-checks-page.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HEADLINE, PAGE_PATH, render } from "./generate-checks-page.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ledger = JSON.parse(readFileSync(join(root, "docs", "claims.json"), "utf-8"));
const runs = JSON.parse(readFileSync(join(root, "docs", "client-runs.json"), "utf-8"));
const row = (id, status, extra = {}) => ({ id, source: "README.md", text: `text of ${id}`, status, ...extra });
const tiny = (extra = []) => ({
  claims: [...new Set(HEADLINE.flatMap((h) => h.ids))].map((id) => row(id, "stated-limit")).concat(extra),
});

test("the committed page is what the register says now", () => {
  assert.equal(readFileSync(join(root, PAGE_PATH), "utf-8"), render(ledger, runs));
});

test("every register row appears on the page exactly once", () => {
  const page = render(ledger, runs);
  const headlineIds = new Set(HEADLINE.flatMap((h) => h.ids));
  for (const r of ledger.claims) {
    // A row is referenced as "(ID)" or "(ID;" or a table cell "| ID |". A headline row shows twice on purpose: in the limits block and in its status section.
    const hits = (page.match(new RegExp(`(\\(${r.id}[;)])|(\\| ${r.id} \\|)`, "g")) ?? []).length;
    assert.equal(hits, headlineIds.has(r.id) ? 2 : 1, r.id);
  }
});

test("a headline row that was removed fails loudly", () => {
  const l = tiny();
  l.claims = l.claims.filter((r) => r.id !== "README-034");
  assert.throws(() => render(l, { runs: [] }), /README-034/);
});

test("an unknown status fails loudly", () => {
  assert.throws(() => render(tiny([row("X-1", "settled")]), { runs: [] }), /X-1/);
});

test("em dashes in the register never reach the page", () => {
  const page = render(tiny([row("X-2", "tested", { text: "one — two", note: "a — b" })]), { runs: [] });
  assert.ok(!page.includes("—"));
  assert.ok(page.includes("one, two"));
});

test("a changed register changes the page (stale detection)", () => {
  assert.notEqual(render(tiny(), { runs: [] }), render(tiny([row("X-3", "tested")]), { runs: [] }));
});

test("no run on file says so, and a placeholder version is not shown as a version", () => {
  assert.match(render(tiny(), { runs: [] }), /No run of a real coding agent is on file/);
  const page = render(tiny(), { runs: [{ client: "a", version: "<the version text>", os: "linux-x64", date: "d", pass: true }] });
  assert.match(page, /\| a \| not recorded \| linux-x64/);
});

test("a table cell with a pipe does not break the table", () => {
  const page = render(tiny([row("X-4", "unverified", { text: "a | b", obtained: "read" })]), { runs: [] });
  assert.match(page, /a \\\| b/);
});

test("a fragment that starts in lower case is marked as a fragment", () => {
  assert.match(render(tiny([row("X-5", "tested", { text: "applies that limit" })]), { runs: [] }), /“…applies that limit”/);
});

// Independent read (2026-11-10): a fix that a second session has read must not still be described as "read by no one but its author".
const fixedRow = (id, extra = {}) =>
  row(id, "unverified", {
    kind: "finding",
    recheck: { date: "2026-11-07", by: "reader", current: "still_holds", note: "open" },
    fix: { date: "2026-11-08", by: "author", note: "the fix", not_covered: "x" },
    ...extra,
  });

test("a fix nobody else has read says so", () => {
  const page = render(tiny([fixedRow("ZZ-01")]), runs);
  assert.match(page, /read by no one but its author/);
});

test("a fix that an independent session has read says who read it and what they found", () => {
  const page = render(
    tiny([fixedRow("ZZ-02", { fix: { date: "2026-11-08", by: "author", note: "the fix", not_covered: "x", independent_read: { date: "2026-11-10", by: "a session that did not write it", current: "confirms_with_gaps", note: "one test was missing and has been added" } } })]),
    runs
  );
  assert.doesNotMatch(page.split("ZZ-02")[1] ?? "", /read by no one but its author/);
  assert.match(page, /read again 2026-11-10/);
  assert.match(page, /confirmed with gaps/);
  assert.match(page, /one test was missing/);
});
