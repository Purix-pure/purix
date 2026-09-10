// src/manifest/schema.ts

export type VerificationStatus = "pass" | "fail" | "pending";

/**
 * v1.0 §4.1 / Priority Matrix Must-Have: "Provenance field on manifest
 * version_history." source_type distinguishes Purix's own Instruction
 * Path from an ingested external diff; source_agent names the upstream
 * tool when known (e.g. "cursor", "claude-code", "devin", "human"), or
 * null when the origin isn't identified. Per Principle 12, no code
 * anywhere is allowed to read this to relax or tighten a gate — it's
 * observability/audit data only, never a trust input.
 */
export interface Provenance {
  source_type: "instruction" | "external_diff";
  source_agent: string | null;
}

export interface VersionHistoryEntry {
  version: number;
  operation: string;
  patch_ref: string;
  contract_changed: boolean;
  timestamp: string;
  provenance: Provenance;
}

/**
 * Decision-rationale ("why") note attached to a single indexed component.
 * Beta scope is deliberately narrow (ADR pending): only "user" and
 * "llm_suggested_confirmed" sources exist. A fully auto-inferred rationale
 * with no human confirmation is explicitly out of scope until component-
 * detection accuracy is proven — a wrong "why" is worse than no "why".
 */
export interface RationaleNote {
  text: string;
  source: "user" | "llm_suggested_confirmed";
  author: string | null;
  created_at: string;
  updated_at: string;
}

export interface ComponentRecord {
  symbol_name: string;
  file_location: string;
  signature: string;
  language: string;
  verification_status: VerificationStatus;
  last_verified_commit_hash: string | null;
  reusable: boolean;
  rationale: RationaleNote | null;
}

export interface ManifestEntry {
  component_id: string;
  component_type: string;
  current_version: number;
  schema_version: number;

  parts: {
    prompt?: string;
    tools: string[];
    config: Record<string, unknown>;
    control_flow?: string;
    memory_scope?: string;
  };

  files: string[];
  depends_on: string[];
  depended_on_by: string[];
  version_history: VersionHistoryEntry[];
  verification_status: VerificationStatus;
  last_synced_hash: string | null;
  language?: string;
  components?: ComponentRecord[];
  dependencies?: Record<string, Record<string, string>>;
}

export interface TopologyPlan {
  component_id: string;
  component_type: string;
  files: {
    path: string;
    purpose: string;
    starter_content: string;
  }[];
  depends_on: string[];
}

/**
 * Schema-only readiness for the (not-yet-built) dependency-aware reversible
 * change feature — code-level revert only, never full production rollback.
 * Sequenced after decision-rationale and dependency-trust ship and stabilize
 * (see feature recommendations doc); this type exists now so the eventual
 * implementation has a stable shape to write against and doesn't invent one
 * ad hoc later. Nothing constructs or persists this yet — no storage table,
 * no CLI command. `cascade_scope` intentionally has three tiers so the
 * free-tier "basic single-component revert" and the team/enterprise
 * "dependency-aware cascade revert with audit trail" can share one record
 * shape instead of diverging into two.
 */
export interface RevertRecord {
  reverted_component_id: string;
  reverted_from_version: number;
  reverted_to_version: number;
  timestamp: string;
  cascade_scope: "single_component" | "dependents_flagged" | "dependents_auto_adjusted";
  affected_dependents: {
    component_id: string;
    version_at_revert: number;
    action: "flagged" | "auto_adjusted";
  }[];
}

// The actual ChangeEdit union (prompt_text / config_value / tool_binding /
// error_handling / control_flow) lives in src/llm/classify.ts as a
// zod-inferred type — it's the classifier's contract. Don't redeclare it
// here; a second, out-of-sync copy is how edits end up type-checking
// against the wrong shape.