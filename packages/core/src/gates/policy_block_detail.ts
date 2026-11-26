// src/gates/policy_block_detail.ts
//
// What a `policy_block` event records when the secret scan or the security gate stops a change. Names and counts only: the
// pattern or category that fired, how many findings, and which files. Never a matched value and never a gate message, because
// a message can quote the code that held the secret. Pure, so the shape is tested without a store.
import type { SecretFinding } from "../security/secrets.js";
import type { SecurityFindingItem } from "./security_gate.js";

export interface PolicyBlockDetail {
  source: "secret_scan" | "security_gate";
  findings: number;
  /** Pattern name (secret scan) or rule category (security gate) to how many findings it had. */
  categories: Record<string, number>;
  /** At most 10 file paths, in the order they were found. */
  files: string[];
}

const MAX_FILES = 10;

function tally(names: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of names) out[n] = (out[n] ?? 0) + 1;
  return out;
}

function firstFiles(paths: string[]): string[] {
  return [...new Set(paths)].slice(0, MAX_FILES);
}

export function secretBlockDetail(findings: SecretFinding[]): PolicyBlockDetail {
  return { source: "secret_scan", findings: findings.length, categories: tally(findings.map((f) => f.reason)), files: firstFiles(findings.map((f) => f.path)) };
}

/** Only Critical and High findings block, so only those are counted. */
export function securityGateBlockDetail(findings: SecurityFindingItem[]): PolicyBlockDetail {
  const blocking = findings.filter((f) => f.severity === "Critical" || f.severity === "High");
  return { source: "security_gate", findings: blocking.length, categories: tally(blocking.map((f) => f.category)), files: firstFiles(blocking.map((f) => f.path)) };
}
