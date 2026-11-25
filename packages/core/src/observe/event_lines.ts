// packages/core/src/observe/event_lines.ts
//
// One plain-words line per event, for `purix watch`. Pure: an event in, a string (or null) out, so the wording is tested without a
// database. Events that are bookkeeping, not something a person watching would act on, give null.
//
// Wording rule: say what happened and, where the event carries it, why. Never "safe", "correct" or "fixed".
import type { LedgerEvent } from "./ledger_reader.js";
import { STOP_KINDS } from "./ledger_reader.js";

function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "--:--:--";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function seconds(ms: unknown): string | null {
  return typeof ms === "number" && Number.isFinite(ms) ? `${(ms / 1000).toFixed(1)}s` : null;
}

function counts(v: unknown): string | null {
  if (!v || typeof v !== "object") return null;
  const c = v as Record<string, unknown>;
  if (typeof c["passed"] !== "number") return null;
  const skipped = typeof c["skipped"] === "number" && (c["skipped"] as number) > 0 ? `, ${c["skipped"]} skipped` : "";
  const failed = typeof c["failed"] === "number" && (c["failed"] as number) > 0 ? `, ${c["failed"]} failed` : "";
  return `${c["passed"]} tests passed${failed}${skipped}`;
}

/** The line for one event, or null when it is not worth a person's attention while watching. */
export function eventLine(e: LedgerEvent): string | null {
  const who = e.componentId ?? "";
  const tag = typeof e.detail["change_id"] === "string" ? `  [${e.detail["change_id"]}]` : "";
  const head = `${clock(e.timestamp)}  `;
  const pad = (label: string) => label.padEnd(10);
  const subject = who ? `${who}  ` : "";
  switch (e.kind) {
    case "request":
      return `${head}${pad("started")}${subject}${e.operation ?? ""}${tag}`.trimEnd();
    case "verification_pass": {
      const bits = [counts(e.detail["test_counts"]), seconds(e.detail["verify_ms"]), e.detail["isolation"] === "none" ? "no isolation" : null].filter(Boolean);
      return `${head}${pad("checks ok")}${subject}${bits.join(" · ") || "checks passed"}${tag}`;
    }
    case "verification_failure":
      return `${head}${pad("check failed")}${subject}${typeof e.detail["reason"] === "string" ? firstLine(e.detail["reason"] as string) : "a check failed"}${tag}`;
    case "policy_block":
    case "precheck_block":
    case "test_integrity_flag":
    case "coverage_gate_flag":
    case "injection_flag":
    case "hook_denied":
      return `${head}${pad("STOPPED")}${subject}${STOP_KINDS[e.kind]}${tag}`;
    case "unadopted_write":
      return `${head}${pad("outside")}an agent wrote a file Purix does not govern${tag}`;
    case "escalation_start":
      return `${head}${pad("repairing")}${subject}escalated to a stronger repair${tag}`;
    case "confirm_response": {
      const wait = seconds(e.detail["wait_ms"]);
      return `${head}${pad(e.detail["approved"] === true ? "approved" : "declined")}${subject}${typeof e.detail["checkpoint_kind"] === "string" ? e.detail["checkpoint_kind"] : "checkpoint"}${wait ? ` · waited ${wait}` : ""}${tag}`;
    }
    case "approval_decided": {
      const wait = seconds(e.detail["wait_ms"]);
      return `${head}${pad("answered")}${subject}${e.operation ?? "request"}${wait ? ` · waited ${wait}` : ""}${tag}`;
    }
    case "change_landed":
      return `${head}${pad("landed")}${subject}${typeof e.detail["kind"] === "string" ? e.detail["kind"] : "change"}${typeof e.detail["version"] === "number" ? ` v${e.detail["version"]}` : ""}${tag}`;
    case "secrets_scrubbed": {
      const n = typeof e.detail["count"] === "number" ? e.detail["count"] : 0;
      return `${head}${pad("redacted")}${n} secret(s) removed from ${e.detail["direction"] === "inbound" ? "a model reply" : "a model prompt"}${tag}`;
    }
    case "apply_rolled_back":
      return `${head}${pad("undone")}${subject}Purix undid a change that did not land (${typeof e.detail["reason"] === "string" ? String(e.detail["reason"]).replace(/_/g, " ") : "write failed"})${e.detail["rollback_failed"] === true ? ", and the undo itself failed: run purix reconcile" : ""}${tag}`;
    case "dependency_lookup": {
      const reg = (e.detail["registry"] ?? {}) as Record<string, unknown>;
      const missing = typeof reg["missing"] === "number" ? reg["missing"] : 0;
      return `${head}${pad("deps")}${subject}looked up ${typeof e.detail["names"] === "number" ? e.detail["names"] : 0} package name(s), ${missing} not found${tag}`;
    }
    case "audit_run":
      return `${head}${pad("audit")}purix audit ran${tag}`;
    case "change_feedback":
      return `${head}${pad("feedback")}${e.detail["helped"] === true ? "marked helpful" : "marked not helpful"}${tag}`;
    default:
      return null;
  }
}

function firstLine(text: string): string {
  const line = text.split(/\r?\n/).find((l) => l.trim().length > 0) ?? text;
  return line.length > 120 ? `${line.slice(0, 117)}...` : line;
}

/** The line for an approval that is waiting for a person. The answer is given with `purix approve`, never here. */
export function waitingLine(id: string, tool: string, componentId: string | null, at: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(at.getHours())}:${p(at.getMinutes())}:${p(at.getSeconds())}  WAITING   ${tool}${componentId ? ` on ${componentId}` : ""}: run  purix approve ${id}`;
}
