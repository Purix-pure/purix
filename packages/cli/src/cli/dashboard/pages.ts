// src/cli/dashboard/pages.ts
//
// The dashboard's pages as pure functions of data: a source of projects and records in, HTML out. Nothing here opens a socket or
// writes anything, so every page is tested without a server.
//
// Honesty rules the code keeps (plan, "What makes it believable"): every number carries its type; a count shows its denominator; Purix's
// own misses (failed checks, repairs, runs where nothing was tested) are shown; what was not checked is always present; no score out of
// 100; no dollars for bugs prevented; the Purix version and the data's date range are on every view.
import type { ChangeRecord, Ledger, ProjectSummary, WeekBucket } from "@purix/core/observe/ledger_reader";
import { SECURITY_CHECK_GROUPS } from "@purix/core/gates/security_gate";
import { reworkOfChange, type ChangeRework } from "@purix/core/state/rework";
import { cardCheckWords, type CardCheckState } from "./check_state.js";
import { esc, int, ms, page, pill, usd, when, ago, type MetricType } from "./html.js";

export interface ProjectRef { id: string; name: string; path: string; stateDir: string; firstSeen: string; lastSeen: string; agents: string[] }

export interface DashboardSource {
  now(): Date;
  version: string;
  projects(): ProjectRef[];
  openLedger(p: ProjectRef): Ledger | null;
  pending(p: ProjectRef): { id: string; tool: string }[];
  /** Reverts found in the project's git history, or "not_checked" with a reason. Optional: a source without git reads as not checked. */
  reverts?(p: ProjectRef, sinceIso: string | undefined): { state: "ok"; count: number; commitsRead: number } | { state: "not_checked"; reason: string };
  verifyChain(rows: ReturnType<Ledger["auditChainRows"]>): { valid: boolean; recordCount?: number; reason?: string };
  /** The `purix check` state of a project, from a background run (see check_state.ts). Optional: a source without it shows no check state. */
  checkState?(p: ProjectRef): CardCheckState;
  /** What `purix telemetry show` would send, and whether anything may be sent now. Optional: a source without it shows nothing on the page. */
  telemetry?(): { state: string; sharingNow: string; payload: unknown };
}

export type RangeKey = "7d" | "30d" | "all";
export interface View { range: RangeKey; agent: string | null; redact: boolean; tab: string; live: boolean }

export const TABS = ["timeline", "catches", "components", "spend", "evidence", "limits"] as const;
const TAB_LABEL: Record<string, string> = { timeline: "Timeline", catches: "Catches", components: "Components", spend: "Spend", evidence: "Evidence", limits: "Limits" };

export function parseView(params: URLSearchParams): View {
  const r = params.get("range");
  const t = params.get("tab") ?? "timeline";
  return {
    range: r === "7d" || r === "30d" || r === "all" ? r : "30d",
    agent: params.get("agent") && params.get("agent")!.length <= 64 ? params.get("agent") : null,
    redact: params.get("redact") === "1",
    tab: (TABS as readonly string[]).includes(t) ? t : "timeline",
    live: params.get("live") === "1",
  };
}

function qs(view: View, extra: Record<string, string | null> = {}): string {
  const p = new URLSearchParams();
  const merged: Record<string, string | null> = { range: view.range === "30d" ? null : view.range, agent: view.agent, redact: view.redact ? "1" : null, live: view.live ? "1" : null, ...extra };
  for (const [k, v] of Object.entries(merged)) if (v) p.set(k, v);
  const s = p.toString();
  return s ? `?${s}` : "";
}

export function sinceOf(range: RangeKey, now: Date): string | undefined {
  if (range === "all") return undefined;
  return new Date(now.getTime() - (range === "7d" ? 7 : 30) * 86_400_000).toISOString();
}

/** Stable aliases for names and paths when "redact" is on, so a screenshot shows no client or employer detail. */
export class Redactor {
  private map = new Map<string, string>();
  constructor(private on: boolean) {}
  alias(kind: string, value: string | null | undefined): string {
    if (value === null || value === undefined) return "";
    if (!this.on) return value;
    const key = `${kind}:${value}`;
    let a = this.map.get(key);
    if (!a) { a = `${kind}-${[...this.map.keys()].filter((k) => k.startsWith(kind + ":")).length + 1}`; this.map.set(key, a); }
    return a;
  }
}

function header(src: DashboardSource, title: string, view: View, range: { from: string | null; to: string | null }, crumbs = ""): string {
  const from = range.from ? when(range.from) : "the start";
  return `<header class="top"><div><h1>${crumbs}${esc(title)}</h1></div><div class="small mute">Purix ${esc(src.version)} · data from ${esc(from)} to ${esc(when(src.now().toISOString()))}${view.redact ? " · names hidden" : ""}</div></header>`;
}

function filters(view: View, base: string, agents: string[]): string {
  const link = (label: string, extra: Record<string, string | null>, current: boolean) => `<a href="${base}${qs(view, extra)}"${current ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  const ranges = (["7d", "30d", "all"] as RangeKey[]).map((r) => link(r === "all" ? "All time" : `Last ${r.replace("d", " days")}`, { range: r === "30d" ? null : r }, view.range === r)).join("");
  const ag = agents.length > 0 ? link("Any agent", { agent: null }, view.agent === null) + agents.map((a) => link(a, { agent: a }, view.agent === a)).join("") : "";
  const red = link(view.redact ? "Show names" : "Hide names", { redact: view.redact ? null : "1" }, false);
  return `<div class="filters" role="group" aria-label="filters">${ranges}${ag ? `<span class="mute small">·</span>${ag}` : ""}<span class="mute small">·</span>${red}</div>`;
}

// ------------------------------------------------------------------------------------------------------- home

export function renderHome(src: DashboardSource, view: View): string {
  const red = new Redactor(view.redact);
  const since = sinceOf(view.range, src.now());
  const week = new Date(src.now().getTime() - 7 * 86_400_000).toISOString();
  const projects = src.projects();
  const allAgents = [...new Set(projects.flatMap((p) => p.agents))].sort();
  const shown = view.agent ? projects.filter((p) => p.agents.includes(view.agent!)) : projects;

  interface Row { p: ProjectRef; all: ProjectSummary | null; wk: ProjectSummary | null; pending: number; check: CardCheckState | null }
  const rows: Row[] = shown.map((p) => {
    const l = src.openLedger(p);
    try { return { p, all: l ? l.summary() : null, wk: l ? l.summary({ since: week }) : null, pending: src.pending(p).length, check: src.checkState ? src.checkState(p) : null }; } finally { l?.close(); }
  });

  const sum = (f: (s: ProjectSummary) => number) => rows.reduce((n, r) => n + (r.all ? f(r.all) : 0), 0);
  const withSpend = rows.filter((r) => r.all?.spend);
  const started = rows.map((r) => r.p.firstSeen).sort()[0];
  const testsPassed = sum((s) => s.tests.totals.passed);
  const verifs = sum((s) => s.tests.verificationsWithCounts);
  const verifsNo = sum((s) => s.tests.verificationsWithoutCounts);
  const tile = (n: string, label: string, type: MetricType, anchor: string) => `<div class="tile"><div class="n">${esc(n)}</div><div class="l">${esc(label)}${pill(type, anchor)}</div></div>`;
  const strip = `<div class="strip">
    ${tile(int(rows.length), "projects governed", "measured", "projects")}
    ${tile(int(sum((s) => s.components ?? 0)), "components", "measured", "components")}
    ${tile(int(sum((s) => s.changesLanded)), "changes landed", "measured", "landed")}
    ${tile(int(sum((s) => s.stopped.total)), "stopped before landing", "measured", "stopped")}
    ${tile(int(testsPassed), `tests passed (${int(verifs)} runs counted, ${int(verifsNo)} not)`, "measured", "tests")}
    ${tile(usd(withSpend.reduce((n, r) => n + (r.all?.spend?.spentUsd ?? 0), 0)), "spent on model calls", "estimated", "spend")}
    ${tile(started ? when(started).slice(0, 10) : "not yet", "Purix first ran here", "measured", "projects")}
  </div>`;

  const cards = rows.map(({ p, wk, all, pending, check }) => {
    const name = esc(red.alias("project", p.name));
    const sp = all?.spend;
    const pct = sp && sp.ceilingUsd > 0 ? Math.min(100, Math.round((sp.spentUsd / sp.ceilingUsd) * 100)) : 0;
    return `<article class="card"><h3><a href="/p/${esc(p.id)}${qs(view)}">${name}</a></h3>
      <div class="small mute">${esc(p.agents.map((a) => red.alias("agent", a)).join(", ") || "no agent recorded")} · last activity ${esc(ago(p.lastSeen, src.now()))}</div>
      <dl class="kv"><dt>This week</dt><dd>${wk ? `${int(wk.changesLandedInRange)} landed, ${int(wk.stopped.total)} stopped of ${int(wk.changesWithId)} changes` : "no record yet"}</dd>
      ${check ? checkRow(check) : ""}
      <dt>Components</dt><dd>${all?.components === null || all?.components === undefined ? "not recorded" : int(all.components)}</dd>
      <dt>Spend</dt><dd>${sp ? `${usd(sp.spentUsd)} of ${usd(sp.ceilingUsd)}, ${usd(sp.leftUsd)} left` : "not recorded"}</dd></dl>
      ${sp ? `<div class="bar" role="img" aria-label="${pct}% of the ceiling spent"><i style="width:${pct}%"></i></div>` : ""}
      ${pending > 0 ? `<div class="attn">${pending} waiting for your approval. Answer it in a terminal: <code>purix approve --list</code></div>` : ""}
    </article>`;
  }).join("");

  const tierSaving = rows.reduce((n, r) => n + (r.all?.spend?.modelTierSavingUsd ?? 0), 0);
  const savings = `<h2>Savings <span class="mute small">(estimated, with the method beside it)</span></h2><div class="panels">
    <div class="panel"><h3>Model-tier saving ${pill("estimated", "tier-saving")}</h3><div class="n" style="font-size:20px">${usd(tierSaving)}</div><div class="small mute">What the cheaper model cost against what the higher tier would have cost for the same tokens. It says nothing about tokens saved against a plain agent.</div></div>
    <div class="panel"><h3>Bad changes stopped ${pill("measured", "stopped")}</h3><div class="n" style="font-size:20px">${int(sum((s) => s.stopped.total))}</div><div class="small mute">Counted with reasons. Not converted to dollars: nobody can know what a stopped bug would have cost.</div></div>
    <div class="panel"><h3>Saving against a plain agent ${pill("not measured", "baseline")}</h3><div class="n" style="font-size:20px">not measured</div><div class="small mute">Shown only after a side-by-side run on the same task. Until then there is no figure.</div></div></div>`;

  const body = `${header(src, "Purix", view, { from: since ?? null, to: null })}
    <p class="mute small" style="margin-top:-8px">Everything Purix did, on this machine. Read-only: approvals are answered with <code>purix approve</code> in a terminal, never here.</p>
    ${strip}${filters(view, "/", allAgents)}
    <h2>Projects</h2>
    ${rows.length === 0 ? `<div class="panel">No project has a Purix record on this machine yet. Run a Purix command in a project and reload.</div>` : `<div class="cards">${cards}</div>`}
    ${savings}
    <p class="note">Not visible to Purix, so not on this page: deployments, incidents, and CI results. The five DORA delivery measures need those, so none is shown. <a href="/how">How every number is computed</a>. <a href="/telemetry">What telemetry would send</a>.</p>`;
  const checking = rows.some((r) => r.check?.kind === "checking");
  return page({ title: "Purix dashboard", version: src.version, body, liveSeconds: checking ? 3 : view.live ? 5 : undefined });
}

// ------------------------------------------------------------------------------------------------ project page

function medianOf(values: number[]): number | null {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : Math.round((s[m - 1]! + s[m]!) / 2);
}

function panel(title: string, type: MetricType, anchor: string, head: string, lines: string[]): string {
  return `<div class="panel"><h3>${esc(title)}${pill(type, anchor)}</h3><div style="font-size:18px;font-weight:600">${head}</div>${lines.map((l) => `<div class="small mute">${l}</div>`).join("")}</div>`;
}

function outcomePanels(s: ProjectSummary, changes: ChangeRecord[], reverts: ReturnType<NonNullable<DashboardSource["reverts"]>> | null): string {
  const landed = changes.filter((c) => c.result === "landed");
  const verifyTimes = changes.map((c) => c.verifyMs).filter((n): n is number => n !== null);
  const durations = landed.map((c) => c.durationMs);
  const sp = s.spend;
  const costLanded = landed.reduce((n, c) => n + c.costUsd, 0);
  const results = panel("Results", "measured", "first-attempt",
    s.firstAttemptPass.of > 0 ? `${s.firstAttemptPass.passed} of ${s.firstAttemptPass.of} passed first time` : "no verified change with an id yet",
    [`${int(s.stopped.total)} stopped before landing, among ${int(s.changesWithId)} changes with an id`,
     `${int(s.verificationFailures)} failed verifications recorded (Purix's own misses are shown)`,
     s.rework.considered > 0
       ? `Rework: ${int(s.rework.reworked)} of ${int(s.rework.considered)} landed changes had another change to the same component within ${s.rework.windowDays} days${s.rework.tooRecent > 0 ? ` (${int(s.rework.tooRecent)} too recent to judge, left out)` : ""}. Per component, not per line, and only changes made through Purix. A correlation, not a cause: a planned follow-up counts too.`
       : `Rework within ${s.rework.windowDays} days: nothing old enough to judge yet${s.rework.tooRecent > 0 ? ` (${int(s.rework.tooRecent)} landed changes are still inside the window)` : ""}.`,
     reverts === null ? `Reverts in git: not checked here.`
       : reverts.state === "ok" ? `Reverts in git: ${int(reverts.count)} of ${int(reverts.commitsRead)} commits read. Counted from git history, separate from the ${int(s.rolledBack.total)} change(s) Purix undid itself (those never landed).`
       : `Reverts in git: not checked (${esc(reverts.reason)}). That is not the same as none.`]);
  const security = panel("Security", "measured", "security",
    `${int(s.securityAdvisories)} advisories noted`,
    [`Advisories are the Low and Medium findings of the security gate on passing runs. A Critical or High finding, or a known secret format, blocks the change and is counted under "stopped" in Results.`,
     ...SECURITY_CHECK_GROUPS.map((g) => `Looked for, ${esc(g.group.toLowerCase())} (${esc(g.how)}): ${g.categories.map((c) => esc(c)).join(", ")}.`),
     `The code patterns are matched one line at a time, so a call split across several lines can get past them. Known secret formats are scanned separately.`,
     `Not looked for: anything else. A clean result here is not a clean project.`,
     s.dependencies.runs > 0
       ? `Dependency lookup: ${int(s.dependencies.namesChecked)} package names checked over ${int(s.dependencies.runs)} change(s): ${int(s.dependencies.missing)} not found in the registry, ${int(s.dependencies.withAdvisories)} with a known advisory, ${int(s.dependencies.unanswered)} with no answer (not checked, not clean).`
       : `Package existence and vulnerability lookup runs only when <code>PURIX_DEP_LOOKUP</code> is set, and has not run in this range.`,
     riskyFilesLine(s.riskyFiles),
     `Secrets removed from model prompts and replies: ${int(s.secretsRemoved.outbound)} going out, ${int(s.secretsRemoved.inbound)} coming back${Object.keys(s.secretsRemoved.byFormat).length ? ` (${esc(Object.entries(s.secretsRemoved.byFormat).map(([k, v]) => `${k} ${v}`).join(", "))})` : ""}. Counts and format names only, never a value.`,
     s.lastAudit
       ? `Last <code>purix audit</code> (${esc(when(s.lastAudit.at))}): ${int(s.lastAudit.pinningFindings)} unpinned dependencies; vulnerability scan ${s.lastAudit.vulnFindings === null ? `did not run (${esc(s.lastAudit.vulnReason ?? "")})` : `${int(s.lastAudit.vulnFindings)} findings`}; lint ${s.lastAudit.idiomFindings === null ? `did not run (${esc(s.lastAudit.idiomReason ?? "")})` : `${int(s.lastAudit.idiomFindings)} findings`}. ${int(s.auditRuns)} run(s) in range.`
       : `No <code>purix audit</code> run is recorded in this range.`]);
  const time = panel("Time and flow", "measured", "time",
    durations.length > 0 ? `${ms(medianOf(durations))} median, first event to landed` : "no landed change with an id yet",
    [`Median wait for you: ${s.approvals.waitsRecorded > 0 ? ms(s.approvals.medianWaitMs) : "not recorded yet"} (${s.approvals.waitsRecorded} waits recorded)`,
     `Median verification time: ${verifyTimes.length > 0 ? ms(medianOf(verifyTimes)) : "not recorded yet"}`,
     `${int(s.approvals.asked)} approvals asked, ${int(s.approvals.approved)} approved, ${int(s.approvals.denied)} not approved`]);
  const cost = panel("Cost", "estimated", "spend",
    landed.length > 0 && costLanded > 0 ? `${usd(costLanded / landed.length)} per landed change` : "no spend on a landed change yet",
    [`Spent on work that did not land: ${sp?.costOfUnlandedUsd === null || sp?.costOfUnlandedUsd === undefined ? "not recorded" : usd(sp.costOfUnlandedUsd)}`,
     `Budget left: ${sp ? `${usd(sp.leftUsd)} of ${usd(sp.ceilingUsd)}` : "not recorded"}`,
     `Estimated: the provider's price table times the tokens Purix counted.`]);
  const fb = s.feedback.helped + s.feedback.notHelped;
  const experience = fb > 0
    ? `<div class="panel" style="margin-top:12px"><h3>Experience${pill("measured", "experience")}</h3><div>${s.feedback.helped} of ${fb} answers said the change helped.</div><div class="small mute">Your own one-tap answers (<code>purix feedback</code>), shown beside the measured numbers. People judge AI's effect on their own speed poorly, so read this next to them, not instead of them.</div></div>` : "";
  const byAgent = Object.entries(s.landedByAgent).sort((a, b) => b[1] - a[1]).map(([a, n]) => `${esc(a)} ${int(n)}`).join(", ");
  const cc = s.changedCoverage;
  const outcomes = Object.entries(s.repairs.outcomes).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k.replace(/_/g, " "))} ${int(n)}`).join(", ");
  const kinds = Object.entries(s.approvalsByKind).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${esc(k.replace(/_/g, " "))} ${int(n)}`).join(", ");
  const process = panel("Process", "measured", "process",
    `${int(s.repairs.escalations)} repair escalation(s)`,
    [outcomes ? `Outcomes: ${outcomes}.` : `No escalation outcome recorded in this range.`,
     `${int(s.repairs.compileRetries)} edit retry(ies), ${int(s.repairs.earlyStops)} repair loop(s) stopped early because the same error came back.`,
     `Earlier work reused: ${int(s.reuse.libraryHits)} library hit(s) among ${int(s.reuse.escalations)} escalation(s).`,
     `Changed lines a passing run ran: ${cc.total > 0 ? `${int(cc.covered)} of ${int(cc.total)} across ${int(cc.runs)} run(s)` : "not measured in this range"}${cc.runsWithoutMeasure > 0 ? ` (${int(cc.runsWithoutMeasure)} run(s) without a figure)` : ""}. A finder of gaps, not a target.`,
     `Landed by agent: ${byAgent || "no landed change with an agent recorded"}.`,
     `${int(s.driftAccepted)} drift acceptance(s) of edits made outside Purix, ${int(s.notesKept)} note(s) kept in repository memory.`,
     `Approvals by kind: ${kinds || "none answered in a terminal in this range"}.`]);
  return `<div class="panels">${results}${security}${time}${cost}${process}</div>${experience}`;
}

function trendPanel(weeks: WeekBucket[]): string {
  const max = Math.max(1, ...weeks.map((w) => w.changes));
  const rowsHtml = weeks.map((w, i) => {
    const pct = Math.round((w.changes / max) * 100);
    const first = w.verified > 0 ? `${int(w.passedFirstTime)} of ${int(w.verified)}` : "none verified";
    return `<tr><td>${esc(when(w.from).slice(0, 10))}${i === weeks.length - 1 ? " (latest)" : ""}</td><td class="num">${int(w.changes)}<div class="bar" role="img" aria-label="${pct}% of the busiest week"><i style="width:${pct}%"></i></div></td><td class="num">${int(w.landed)}</td><td class="num">${int(w.stopped)}</td><td class="num">${esc(first)}</td></tr>`;
  }).join("");
  return `<h2>Four weeks ${pill("measured", "trend")}</h2><div class="table-wrap"><table><thead><tr><th>Week from</th><th>Changes with an id</th><th>Landed</th><th>Stopped</th><th>Passed first time</th></tr></thead><tbody>${rowsHtml}</tbody></table></div>
    <p class="note">Counts, not a score. Read the pattern over the weeks, not one number. Speed and quality sit side by side here on purpose. This table ignores the range filter.</p>`;
}

function changeResultWord(c: ChangeRecord): string {
  return ({ landed: "landed", verified: "checks passed, not landed", failed: "checks failed", stopped: "stopped", waiting: "waiting for a person", unfinished: "unfinished" } as const)[c.result];
}

/** One definition-list row for the `purix check` state. The words come from check_state.ts; nothing here says "clean" without a pass. */
function checkRow(c: CardCheckState): string {
  const w = cardCheckWords(c);
  const refreshing = c.kind !== "checking" && c.refreshing ? " (refreshing)" : "";
  return `<dt><code>purix check</code></dt><dd${w.attention ? ' class="attn-text"' : ""}>${esc(w.label)}${refreshing}<div class="small mute">${esc(w.detail)}</div></dd>`;
}

function projectCheckLine(c: CardCheckState): string {
  const w = cardCheckWords(c);
  return `<div class="${w.attention ? "attn" : "panel"}" style="margin:0 0 12px"><code>purix check</code>: ${esc(w.label)}. <span class="small mute">${esc(w.detail)}</span></div>`;
}

/** The same record split by agent, for a developer who works with more than one. Different agents get different work, so this is a view, not a ranking. */
export interface AgentRow { agent: string; changes: number; landed: number; stopped: number; verified: number; passedFirst: number; medianLandedMs: number | null; costLandedUsd: number }
export function agentSplit(changes: ChangeRecord[]): AgentRow[] {
  const by = new Map<string, ChangeRecord[]>();
  for (const c of changes) {
    const k = c.agent ?? "(no agent recorded)";
    const list = by.get(k); if (list) list.push(c); else by.set(k, [c]);
  }
  return [...by.entries()].map(([agent, list]) => {
    const landed = list.filter((c) => c.result === "landed");
    const verified = list.filter((c) => c.failedBeforePass !== null);
    return {
      agent,
      changes: list.length,
      landed: landed.length,
      stopped: list.filter((c) => c.stops.length > 0).length,
      verified: verified.length,
      passedFirst: verified.filter((c) => c.failedBeforePass === 0).length,
      medianLandedMs: medianOf(landed.map((c) => c.durationMs)),
      costLandedUsd: landed.reduce((n, c) => n + c.costUsd, 0),
    };
  }).sort((a, b) => b.changes - a.changes || a.agent.localeCompare(b.agent));
}

function agentSplitPanel(changes: ChangeRecord[], red: Redactor): string {
  const rows = agentSplit(changes);
  if (rows.length < 2) return "";
  const body = rows.map((r) => `<tr><td>${esc(red.alias("agent", r.agent))}</td><td class="num">${int(r.changes)}</td><td class="num">${int(r.landed)}</td><td class="num">${int(r.stopped)}</td><td class="num">${r.verified > 0 ? `${int(r.passedFirst)} of ${int(r.verified)}` : "none verified"}</td><td class="num">${r.medianLandedMs === null ? "no landed change" : ms(r.medianLandedMs)}</td><td class="num">${r.landed > 0 && r.costLandedUsd > 0 ? usd(r.costLandedUsd / r.landed) : "not recorded"}</td></tr>`).join("");
  return `<h2>By agent ${pill("measured", "by-agent")}</h2><div class="table-wrap"><table><thead><tr><th>Agent</th><th>Changes with an id</th><th>Landed</th><th>Stopped</th><th>Passed first time</th><th>Median time to land</th><th>Spend per landed change</th></tr></thead><tbody>${body}</tbody></table></div>
    <p class="note">One record, split by who made the change. Agents are usually given different work, so this is a way to see your own pattern with each one, not a ranking. Counts come from the changes in the chosen range, up to the 300 most recent.</p>`;
}

export function renderProject(src: DashboardSource, p: ProjectRef, view: View): string {
  const red = new Redactor(view.redact);
  const since = sinceOf(view.range, src.now());
  const ledger = src.openLedger(p);
  const name = red.alias("project", p.name);
  const crumbs = `<a href="/${qs(view)}" class="mute">All projects</a> / `;
  if (!ledger) return page({ title: name, version: src.version, body: `${header(src, name, view, { from: since ?? null, to: null }, crumbs)}<div class="panel">This project's record could not be read. It may not exist yet, or another process may be holding it. Reload in a moment.</div>` });
  try {
    const s = ledger.summary({ since });
    const allChanges = ledger.changes({ since, limit: 300 });
    const changes = view.agent ? allChanges.filter((c) => c.agent === view.agent) : allChanges;
    const agents = [...new Set(allChanges.map((c) => c.agent).filter((a): a is string => !!a))].sort();
    const pending = src.pending(p);
    const tabs = `<nav class="tabs" aria-label="sections">${TABS.map((t) => `<a href="/p/${esc(p.id)}${qs(view, { tab: t })}"${view.tab === t ? ' aria-current="page"' : ""}>${TAB_LABEL[t]}</a>`).join("")}</nav>`;
    let tab = "";
    if (view.tab === "timeline") tab = timelineTab(p, changes, view, red, src.now());
    else if (view.tab === "catches") tab = catchesTab(ledger, since, red);
    else if (view.tab === "components") tab = componentsTab(ledger, red);
    else if (view.tab === "spend") tab = spendTab(s, red);
    else if (view.tab === "evidence") tab = evidenceTab(src, ledger, p, view);
    else tab = limitsTab(s, allChanges, red);
    const body = `${header(src, name, view, { from: since ?? null, to: null }, crumbs)}
      ${pending.length > 0 ? `<div class="attn" style="margin:0 0 12px">${pending.length} waiting for your approval. Answer in a terminal: <code>purix approve --list</code></div>` : ""}
      ${src.checkState ? projectCheckLine(src.checkState(p)) : ""}
      ${filters(view, `/p/${esc(p.id)}`, agents)}
      ${outcomePanels(s, allChanges, src.reverts ? src.reverts(p, since) : null)}${agentSplitPanel(allChanges, red)}${trendPanel(ledger.trend(src.now()))}${tabs}${tab}`;
    return page({ title: `${name} · Purix`, version: src.version, body, liveSeconds: src.checkState && src.checkState(p).kind === "checking" ? 3 : view.live ? 5 : undefined });
  } finally {
    ledger.close();
  }
}

function timelineTab(p: ProjectRef, changes: ChangeRecord[], view: View, red: Redactor, now: Date): string {
  if (changes.length === 0) return `<div class="panel">No change with an id in this range. Changes made before change ids existed are counted in the totals but have no row here.</div>`;
  const rowsHtml = changes.map((c) => `<tr><td class="num">${esc(when(c.startedAt))}</td><td>${esc(red.alias("agent", c.agent) || "not recorded")}</td><td>${esc(red.alias("component", c.component) || "none")}</td><td>${esc(changeResultWord(c))}${c.stops.length ? ` · ${c.stops.length} stopped` : ""}</td><td class="num">${esc(usd(c.modelCalls > 0 ? c.costUsd : null).replace("not recorded", "no model call"))}</td><td class="num">${esc(ms(c.durationMs))}</td><td><a href="/p/${esc(p.id)}/c/${esc(c.changeId)}${qs(view)}">receipt</a></td></tr>`).join("");
  return `<div class="table-wrap"><table><thead><tr><th>Started</th><th>Agent</th><th>Component</th><th>Result</th><th>Cost</th><th>Duration</th><th></th></tr></thead><tbody>${rowsHtml}</tbody></table></div><p class="note">Newest first, up to 300. Times are UTC. ${esc(String(now.getUTCFullYear()))}</p>`;
}

function catchesTab(ledger: Ledger, since: string | undefined, red: Redactor): string {
  const stops = ledger.stops({ since, limit: 200 });
  const s = ledger.summary({ since });
  const denom = `${int(s.stopped.total)} stopped among ${int(s.changesWithId)} changes with an id. Test-assertion flags: ${int(s.stopped.byKind["test_integrity_flag"] ?? 0)} of ${int(s.stopped.gateEvaluations)} gate runs.`;
  if (stops.length === 0) return `<div class="panel">Nothing was stopped in this range. ${esc(denom)}</div>`;
  const rowsHtml = stops.map((x) => {
    const files = Array.isArray(x.detail["files"]) ? (x.detail["files"] as unknown[]).filter((f): f is string => typeof f === "string").slice(0, 5).map((f) => red.alias("file", f)).join(", ") : "";
    return `<tr><td class="num">${esc(when(x.at))}</td><td>${esc(x.reason)}</td><td>${esc(red.alias("component", x.component) || "none")}</td><td>${esc(files)}</td></tr>`;
  }).join("");
  return `<div class="table-wrap"><table><thead><tr><th>When</th><th>What was stopped, and why</th><th>Component</th><th>Files</th></tr></thead><tbody>${rowsHtml}</tbody></table></div><p class="note">${esc(denom)}</p>`;
}

function componentsTab(ledger: Ledger, red: Redactor): string {
  const comps = ledger.components();
  if (comps.length === 0) return `<div class="panel">No component is governed in this project yet.</div>`;
  return `<div class="table-wrap"><table><thead><tr><th>Component</th><th>Type</th><th>Version</th><th>Last changed</th></tr></thead><tbody>${comps.map((c) => `<tr><td>${esc(red.alias("component", c.componentId))}</td><td>${esc(c.type)}</td><td class="num">${c.version}</td><td class="num">${esc(when(c.lastChangedAt))}</td></tr>`).join("")}</tbody></table></div><p class="note">Whether each component still matches the disk is what <code>purix check</code> answers; this page does not run it.</p>`;
}

function spendTab(s: ProjectSummary, _red: Redactor): string {
  const sp = s.spend;
  if (!sp) return `<div class="panel">No model call or spend is recorded for this project.</div>`;
  const pct = sp.ceilingUsd > 0 ? Math.min(100, Math.round((sp.spentUsd / sp.ceilingUsd) * 100)) : 0;
  const models = sp.byModel.map((m) => `<tr><td>${esc(m.provider)}</td><td>${esc(m.model)}</td><td class="num">${int(m.calls)}</td><td class="num">${int(m.tokensIn)} in, ${int(m.tokensOut)} out</td><td class="num">${esc(usd(m.costUsd))}</td></tr>`).join("");
  const types = sp.byCallType.map((m) => `<tr><td>${esc(m.callType)}</td><td class="num">${int(m.calls)}</td><td class="num">${esc(usd(m.costUsd))}</td></tr>`).join("");
  return `<div class="panel"><h3>Budget${pill("estimated", "spend")}</h3><div>${esc(usd(sp.spentUsd))} spent of ${esc(usd(sp.ceilingUsd))}; ${esc(usd(sp.leftUsd))} left</div><div class="bar"><i style="width:${pct}%"></i></div>
    <div class="small mute">${int(sp.calls)} model calls (${int(sp.failedCalls)} did not return a usable answer). ${int(sp.tokensIn)} tokens in, ${int(sp.tokensOut)} out, ${int(sp.tokensCached)} of the input served from cache.</div></div>
    <h2>By model</h2><div class="table-wrap"><table><thead><tr><th>Provider</th><th>Model</th><th>Calls</th><th>Tokens</th><th>Cost</th></tr></thead><tbody>${models || '<tr><td colspan="5">none</td></tr>'}</tbody></table></div>
    <h2>By call type</h2><div class="table-wrap"><table><thead><tr><th>Call type</th><th>Calls</th><th>Cost</th></tr></thead><tbody>${types || '<tr><td colspan="3">none</td></tr>'}</tbody></table></div>`;
}

function evidenceTab(src: DashboardSource, ledger: Ledger, p: ProjectRef, view: View): string {
  const chain = src.verifyChain(ledger.auditChainRows());
  return `<div class="panel"><h3>Record intact${pill("measured", "chain")}</h3>
    <div>${chain.valid ? `Chain intact: ${int(chain.recordCount ?? 0)} records checked.` : `<b>Chain NOT intact:</b> ${esc(chain.reason ?? "unknown reason")}`}</div>
    <div class="small mute">This is an internal-consistency check. It cannot see records removed from the end. <code>purix audit-log verify</code> and <code>purix evidence report</code> do more, including a report for a pull request.</div></div>
    <p><a href="/p/${esc(p.id)}/export.json${qs(view)}">Export this project's raw data as JSON</a>. A number that can be recomputed is a number that can be trusted.</p>`;
}

function limitsTab(s: ProjectSummary, changes: ChangeRecord[], red: Redactor): string {
  const iso = Object.entries(s.isolation).map(([k, v]) => `${esc(k)}: ${int(v)}`).join(", ") || "none recorded";
  const nt = [...new Set(changes.flatMap((c) => c.notTested))].slice(0, 30);
  const nc = [...new Set(changes.flatMap((c) => c.notChecked))].slice(0, 30);
  const list = (xs: string[]) => xs.length === 0 ? "none recorded" : xs.map((x) => `<code>${esc(red.alias("file", x))}</code>`).join(", ");
  return `<div class="panel"><h3>What Purix does not cover here</h3>
    <dl class="kv"><dt>Isolation of runs</dt><dd>${iso} (<code>none</code> means tests ran without isolation; Windows has no native backend)</dd>
    <dt>Files no test ran</dt><dd>${int(s.notTestedFiles)} across passing runs. ${list(nt)}</dd>
    <dt>Files not checked</dt><dd>${int(s.notCheckedFiles)} in a language Purix has no checker for. ${list(nc)}</dd>
    <dt>Edits outside Purix</dt><dd>${int(s.unadoptedWrites)} writes to files Purix does not govern; ${int(s.hookDenials)} direct edits blocked</dd>
    <dt>Changes Purix undid</dt><dd>${int(s.rolledBack.total)} applied then undone (a failed write or a manifest conflict); ${int(s.rolledBack.undoFailed)} where the undo itself failed. They never landed.</dd>
    <dt>Verifications without test counts</dt><dd>${int(s.tests.verificationsWithoutCounts)} (runs from before counts were stored, or runners that reported none)</dd></dl></div>
    <p class="note">A passing run is not proof the code is correct, and Purix makes no safety-rate claim. Files skipped by the indexer, by type, are listed by <code>purix index --list-skipped</code>.</p>`;
}

// ------------------------------------------------------------------------------------------------ change receipt

function coverageText(c: ChangeRecord): string {
  const k = c.changedCoverage;
  if (!k) return "not measured (only JavaScript and TypeScript runs with a coverage reporter, and Python runs where pytest-cov is installed, are measured; a missing figure is not a covered one)";
  if (k.total === 0) return `no executable changed line was measured${k.notMeasuredFiles > 0 ? `; ${k.notMeasuredFiles} changed file(s) not measured` : ""}${k.why ? ` (${k.why})` : ""}`;
  const pct = k.ratio === null ? "" : ` (${Math.round(k.ratio * 100)}%)`;
  return `a passing run ran ${k.covered} of ${k.total} changed executable lines${pct}${k.uncoveredLines > 0 ? `; ${k.uncoveredLines} line(s) in ${k.uncoveredFiles} file(s) no test ran` : ""}${k.notMeasuredFiles > 0 ? `; ${k.notMeasuredFiles} file(s) not measured` : ""}. A finder of gaps, not a target`;
}

/** The "Rework risk" value: what Purix saw after this change landed, with the limits of that said every time. */
export function reworkWords(r: ChangeRework | null): string {
  const note = "Only changes made through Purix are seen. A correlation with later changes, not proof this one was wrong.";
  if (r === null) return "not judged: the change did not land, or its record entry was not matched";
  switch (r.state) {
    case "not_judged": return `not judged: ${r.reason}`;
    case "window_open": return `too recent to judge: the ${r.windowDays}-day window closes ${when(r.closesAt)}`;
    case "again": return `another change (${r.kind}) landed on this component ${r.daysLater} day(s) later, inside ${r.windowDays} days. ${note}`;
    case "none_in_window": return `no other change to this component landed within ${r.windowDays} days. ${note}`;
  }
}

/** The "Dependencies added" value: what the lookup recorded for this change, and plainly when it recorded nothing. */
export function dependencyWords(d: ChangeRecord["dependencies"]): string {
  if (d === null) return "not recorded: no dependency lookup ran for this change (it is off unless PURIX_DEP_LOOKUP is set, and records nothing when a change adds no package). This does not mean none were added";
  const parts = [`${d.names} package name(s) added or raised`];
  if (d.mode.registry) {
    const miss = d.registry.missing > 0 ? `${d.registry.missing} not found in the registry${d.missingNames.length ? ` (${d.missingNames.join(", ")})` : ""}` : "none missing from the registry";
    parts.push(`${miss}${d.registry.unanswered > 0 ? `, ${d.registry.unanswered} not checked (no answer)` : ""}`);
  } else parts.push("registry existence not asked");
  if (d.mode.osv) {
    const vul = d.advisories.withAdvisories > 0 ? `${d.advisories.withAdvisories} of ${d.advisories.pairs} exact version(s) with a known advisory${d.vulnerable.length ? ` (${d.vulnerable.map((v) => `${v.name}@${v.version}`).join(", ")})` : ""}` : `no known advisory among ${d.advisories.pairs} exact version(s)`;
    parts.push(`${vul}${d.advisories.unanswered > 0 ? `, ${d.advisories.unanswered} not checked (no answer)` : ""}`);
  } else parts.push("advisories not asked");
  return parts.join("; ");
}

/** The receipt as plain text lines: label, value, and where the value comes from. Used by the page and by tests. */
/** The "risky files by pattern" line for the security panel: kinds of file, never names. Says what it counts and what it cannot see. */
export function riskyFilesLine(r: ProjectSummary["riskyFiles"]): string {
  if (r.stopsWithFiles === 0 && r.stopsWithoutFiles === 0) return `Files the secret scan or security gate stopped a change for: none in this range.`;
  const parts = r.patterns.map((p) => `${esc(p.pattern)} ${int(p.stops)}${Object.keys(p.categories).length ? ` (${esc(Object.entries(p.categories).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${k} ${n}`).join(", "))})` : ""}`);
  return `Files the secret scan or security gate stopped a change for, by kind of file (stops, not files; a pattern is not a verdict on that kind of file): ${parts.join("; ") || "none named"}.${r.stopsWithoutFiles > 0 ? ` ${int(r.stopsWithoutFiles)} stop(s) named no file.` : ""}`;
}

export function receiptLines(c: ChangeRecord, s: ProjectSummary, chain: { valid: boolean; recordCount?: number } | null, entryId: number | null, red: Redactor, rework: ChangeRework | null = null): [string, string][] {
  const tc = c.testCounts;
  const checked = c.failedBeforePass === null ? "no passing verification recorded"
    : tc ? `${tc.passed} tests passed, ${tc.failed} failed, ${tc.skipped} skipped${c.verifyMs !== null ? ` in ${ms(c.verifyMs)}` : ""}` : `checks passed; test counts not recorded${c.verifyMs !== null ? ` (${ms(c.verifyMs)})` : ""}`;
  const stopped = c.stops.length === 0 ? "nothing stopped in this change" : c.stops.map((x) => x.reason).join("; ");
  const notChecked = [...c.notTested.map((f) => `${red.alias("file", f)} (no test ran it)`), ...c.notChecked.map((f) => `${red.alias("file", f)} (no checker for its language)`)];
  return [
    ["Change", `${c.operation ?? "operation not recorded"}`],
    ["Agent", `${red.alias("agent", c.agent) || "not recorded"}     Component  ${red.alias("component", c.component) || "none"}     Result  ${changeResultWord(c)}${c.approvals.asked > 0 ? `, ${c.approvals.approved > 0 ? "approved by you" : "not approved"}` : ""}`],
    ["Checked", checked],
    ["Isolation", c.isolation === null ? "not recorded" : c.isolation === "none" ? "none: tests ran without isolation" : c.isolation],
    ["Repairs", c.failedBeforePass === null ? "not applicable" : c.failedBeforePass === 0 ? "passed the first time" : `${c.failedBeforePass} failed attempt(s) before it passed`],
    ["Stopped", stopped],
    ["Not checked", notChecked.length === 0 ? "nothing recorded as unchecked for this change (this does not mean everything was checked)" : notChecked.join("; ")],
    ["Changed lines", coverageText(c)],
    ["Dependencies added", dependencyWords(c.dependencies)],
    ["Rework risk", reworkWords(rework)],
    ["Cost", c.modelCalls > 0 ? `${usd(c.costUsd)} across ${c.modelCalls} model calls, ${int(c.tokensIn)} tokens in, ${int(c.tokensOut)} out (estimated)` : "no model call recorded for this change"],
    ["Time", `${ms(c.durationMs)} from first to last recorded event`],
    ["Waited for you", c.waitedForPersonMs === null ? "no wait recorded" : ms(c.waitedForPersonMs)],
    ["Budget", s.spend ? `${usd(s.spend.leftUsd)} left of ${usd(s.spend.ceilingUsd)}` : "not recorded"],
    ["Record", c.landedKind ? `hash-chained entry ${entryId ?? "(entry not matched)"}, ${chain ? (chain.valid ? "chain intact" : "CHAIN NOT INTACT") : "chain not checked"}` : "not landed, so no chain entry"],
    ["Helped?", c.helped === null ? "no answer given (purix feedback yes|no)" : c.helped ? "you said yes" : "you said no"],
  ];
}

/** The receipt lines for one change, with the chain entry matched and the chain checked. One function for the page and for `purix receipt`. */
export function receiptFor(ledger: Ledger, c: ChangeRecord, verifyChain: DashboardSource["verifyChain"], red: Redactor): { lines: ReturnType<typeof receiptLines>; s: ProjectSummary; chain: { valid: boolean; recordCount?: number } | null; entryId: number | null } {
  const s = ledger.summary();
  const rows = ledger.auditChainRows();
  const chain = c.landedKind ? verifyChain(rows) : null;
  let entryId: number | null = null;
  let landedAt: string | null = null;
  if (c.landedKind && c.component) {
    for (let i = rows.rows.length - 1; i >= 0; i--) {
      const r = rows.rows[i]!;
      if (r.payload.includes(`"component_id":${JSON.stringify(c.component)}`) && (c.landedVersion === null || r.payload.includes(`"version":${c.landedVersion}`))) { entryId = r.id; landedAt = r.timestamp; break; }
    }
  }
  // Same rule as the project-level Rework number (state/rework.ts), asked about this one change. An entry that cannot be matched reads "not judged", never "none".
  const rework = c.landedKind && c.component && landedAt ? reworkOfChange(rows.rows, c.component, c.landedKind, landedAt, new Date()) : null;
  return { lines: receiptLines(c, s, chain, entryId, red, rework), s, chain, entryId };
}

export function renderReceipt(src: DashboardSource, p: ProjectRef, changeId: string, view: View): string {
  const red = new Redactor(view.redact);
  const ledger = src.openLedger(p);
  const crumbs = `<a href="/${qs(view)}" class="mute">All projects</a> / <a href="/p/${esc(p.id)}${qs(view)}" class="mute">${esc(red.alias("project", p.name))}</a> / `;
  if (!ledger) return page({ title: "Receipt", version: src.version, body: `${header(src, "Change receipt", view, { from: null, to: null }, crumbs)}<div class="panel">The record could not be read.</div>` });
  try {
    const c = ledger.change(changeId);
    if (!c) return page({ title: "Receipt", version: src.version, body: `${header(src, "Change receipt", view, { from: null, to: null }, crumbs)}<div class="panel">No change with that id is in this project's record.</div>` });
    const { lines } = receiptFor(ledger, c, src.verifyChain, red);
    const width = Math.max(...lines.map(([l]) => l.length)) + 2;
    const text = lines.map(([l, v]) => `${l.padEnd(width)}${v}`).join("\n");
    const body = `${header(src, "Change receipt", view, { from: c.startedAt, to: c.endedAt }, crumbs)}
      <pre class="receipt">${esc(text)}</pre>
      <p class="note">Every line comes from a stored record (change id <code>${esc(c.changeId)}</code>). A pass means the checks named above passed; it does not mean the code is correct or safe. Costs are estimates. <a href="/how">How each line is computed</a>.</p>`;
    return page({ title: `Receipt ${c.changeId}`, version: src.version, body });
  } finally {
    ledger.close();
  }
}

// ------------------------------------------------------------------------------------------------------ how

const METRICS: [string, MetricType, string, string, string][] = [
  ["projects", "measured", "Projects governed", "The registry in your user folder (projects.json): folders where Purix ran and holds a record.", "A project run before the registry existed appears after its next Purix command."],
  ["components", "measured", "Components", "The manifest table of each project's record.", "The codebase index row is not counted."],
  ["landed", "measured", "Changes landed", "Records in the hash-chained audit log whose event is a component change.", "Counts every landed change; the per-range figure counts only changes that wrote a closing event."],
  ["stopped", "measured", "Stopped before landing", "Events: secret-scan or security-gate block, parse-check block, weakened assertion, no coverage on a changed file, injection tripwire, blocked direct edit.", "Shown with the count of changes it is among. A stop with no change id is in the total but has no row."],
  ["tests", "measured", "Tests run", "The runners' own pass/fail/skip counts, stored on each passing verification.", "Runs from before counts were stored say 'not counted', never zero."],
  ["spend", "estimated", "Dollars spent", "The provider price table times the tokens counted in the model-call log; the budget ledger holds the running total.", "An estimate, as `purix budget show` says."],
  ["first-attempt", "measured", "First-attempt pass", "Per change with an id: no failed verification before the first pass.", "Only changes with an id are in the denominator."],
  ["security", "measured", "Security findings", "Low and Medium findings the security gate recorded on passing runs, capped at 10 per run.", "Only the categories listed in the panel. A clean result is not a clean project."],
  ["time", "measured", "Time and flow", "First to last recorded event of a change; wait times from approval records; verification time from the run.", "Wall-clock from stored timestamps, not effort."],
  ["tier-saving", "estimated", "Model-tier saving", "Savings ledger: actual cost on the cheaper tier minus what the higher tier would have cost for the same tokens. Only two call types route to the cheaper tier.", "Arithmetic on a hypothetical. Not a saving against a plain agent."],
  ["baseline", "not measured", "Saving against a plain agent", "Needs a measured side-by-side run: tokens, calls, time, and whether the result was correct.", "No figure is shown until that run exists."],
  ["rework", "measured", "Rework", "Audit chain: landed create/modify/ingest changes that had another landed change on the same component within 14 days.", "Per component, not per line; only changes through Purix; changes whose window is still open are left out of both numbers. A correlation, not a cause."],
  ["rework-change", "measured", "Rework risk (receipt line)", "The same audit-chain rule as Rework, asked about one change: did another landed change touch the same component within 14 days of this one landing?", "Says 'too recent to judge' while the window is open, never 'none'. Only changes through Purix are seen. A correlation, not a cause."],
  ["deps-change", "measured", "Dependencies added (receipt line)", "The dependency-lookup event stored for the change: package names added or raised, whether the registry knew them, and known advisories for exact versions.", "Recorded only when PURIX_DEP_LOOKUP is on and the change adds a package. Otherwise the line says not recorded, which is not the same as none added."],
  ["reverts", "measured", "Reverts", "Git history: commits written by `git revert`.", "Purix has no revert command. When git cannot answer it says not checked, never none. Never add Purix's own undo of a failed apply to this: that change never landed."],
  ["changed-coverage", "measured", "Changed lines a test ran", "The runner's own line-coverage report (node:test, Jest, Vitest with a coverage package, Mocha with c8), read for the lines this change touched. Executable lines only.", "A finder of untested code, never a target and never a gate. Python and other languages are not measured; a file the report does not mention is 'not measured', not 'covered'."],
  ["dependencies", "measured", "Dependencies added", "The dependency lookup recorded for the change: package names and exact versions sent to the registry and OSV.", "Off unless PURIX_DEP_LOOKUP is set. When it did not run the line says not checked."],
  ["trend", "measured", "Four-week trend", "The same records as the panels, bucketed by week for the last four weeks whatever range is chosen.", "Counts only, never a score. A quiet week is a quiet week, not a failure."],
  ["process", "measured", "Repairs, reuse, drift and notes", "Events: escalation start and outcome, compile retry, repair early stop, reconciliation, memory notes. Library hits are escalations that reused earlier work.", "Counts of events. A repair is not a failure of the final result; it shows how often the first attempt was not enough."],
  ["chain", "measured", "Record intact", "The audit chain's hashes, re-computed from the stored rows.", "Internal consistency only; it cannot see records removed from the end."],
  ["experience", "measured", "Did this help?", "Your own answers from `purix feedback`, stored locally.", "A perceptual measure, shown beside the measured numbers, not in place of them."],
];

export function renderHow(src: DashboardSource): string {
  const rows = METRICS.map(([a, t, name, from, caveat]) => `<tr id="${esc(a)}"><td>${esc(name)}</td><td>${pill(t)}</td><td>${esc(from)}</td><td>${esc(caveat)}</td></tr>`).join("");
  const body = `${header(src, "How every number is computed", { range: "30d", agent: null, redact: false, tab: "", live: false }, { from: null, to: null }, `<a href="/" class="mute">Dashboard</a> / `)}
    <p>Each number has a type. <b>Measured</b> comes straight from a stored record. <b>Estimated</b> depends on a price table or an assumption. <b>Not measured</b> means no honest figure exists yet, so none is shown.</p>
    <div class="table-wrap"><table><thead><tr><th>Number</th><th>Type</th><th>Where it comes from</th><th>Read it with</th></tr></thead><tbody>${rows}</tbody></table></div>
    <h2>Rules this dashboard keeps</h2><ul>
      <li>Every count shows what it is out of.</li><li>Purix's own misses are shown: failed verifications, repairs, runs where nothing could be tested.</li>
      <li>What was not checked is always shown.</li><li>No single score, no safety rate, no dollars for bugs prevented.</li>
      <li>You are compared only with your own past: no leaderboards, no ranking of people.</li>
      <li>Rework and churn figures, when they exist, are labelled correlation, not cause.</li>
      <li>Every project's raw data can be exported as JSON from its Evidence tab.</li></ul>
    <p class="note">Not on this dashboard because Purix cannot see them: deployments, incidents and CI results. The <code>purix check</code> state on each card is a background run in that project's folder, shown when it finishes ("checking" first, "could not be checked" if it fails or takes over 20 seconds, which is not the same as clean). Not shown here: a saving against a plain agent, until a measured run exists (the protocol is in docs/BENCHMARK_PROTOCOL.md). The rework figures, changed-line coverage, duplication check, weekly digest (<code>purix digest</code>) and the telemetry preview are built. <a href="/telemetry">What telemetry would send</a>.</p>`;
  return page({ title: "How it is computed · Purix", version: src.version, body });
}

export function renderTelemetry(src: DashboardSource): string {
  const t = src.telemetry?.();
  const crumbs = `<a href="/" class="mute">Dashboard</a> / `;
  const view = { range: "30d", agent: null, redact: false, tab: "", live: false } as View;
  const body = !t
    ? `${header(src, "What telemetry would send", view, { from: null, to: null }, crumbs)}<div class="panel">This source has no telemetry information to show.</div>`
    : `${header(src, "What telemetry would send", view, { from: null, to: null }, crumbs)}
      <div class="panel"><h3>Status</h3><div>Telemetry: <b>${esc(t.state)}</b>. Sharing right now: <b>${esc(t.sharingNow)}</b>.</div>
      <div class="small mute">Upload is not available in this version, so nothing is sent either way. This is the exact payload <code>purix telemetry show</code> prints: counts, enums and duration buckets from a closed schema, never a path, a prompt or a name.</div></div>
      <h2>The payload</h2><pre class="receipt">${esc(JSON.stringify(t.payload, null, 2))}</pre>
      <p class="note">The richer per-change record this dashboard reads stays in each project's own folder and is not part of this payload.</p>`;
  return page({ title: "Telemetry preview · Purix", version: src.version, body });
}

export function renderNotFound(src: DashboardSource): string {
  return page({ title: "Not found · Purix", version: src.version, body: `<div class="panel">That page does not exist. <a href="/">Back to all projects</a>.</div>` });
}
