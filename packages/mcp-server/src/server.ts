// packages/mcp-server/src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  listManifest,
  readManifest,
  writeManifestWithLimitCheck,
  linkComponents,
  deleteManifestEntry,
  removeDependent,
  removeDependencyReference,
  exportManifestData,
} from "@purix/core/manifest/store";
import { recordEvent } from "@purix/core/manifest/events";
import { PURIX_VERSION } from "./version.js";

/**
 * Fix (2026-09-13): confirmGated()/confirm() opens its own readline
 * reader on process.stdin to prompt a human interactively. Over MCP's
 * StdioServerTransport, that stdin is already carrying incoming
 * JSON-RPC frames from the connected agent, not typed keystrokes — so
 * the old code path either hung forever waiting on a stream that will
 * never produce "y\n", or (with AUTO_CONFIRM=1) skipped the prompt
 * entirely and rubber-stamped every gated action with no real
 * human-in-the-loop check.
 *
 * There is no MCP elicitation wiring here yet (the protocol capability
 * built for exactly this: server asks host for a human answer mid-call).
 * Until that exists, this wrapper makes the safe choice explicit instead
 * of implicit: if the operator has deliberately set
 * PURIX_MCP_AUTO_APPROVE=1 when launching `purix mcp-serve`, that's a
 * knowing trust decision and this auto-approves. If it is not set, this
 * never touches confirm.ts/stdin at all — instead it rejects the action
 * immediately with a message telling the agent (and whoever is reading
 * its output) exactly why, and what to do about it. A clear, fast
 * rejection is always safer than a silent hang or a silent rubber-stamp.
 *
 * BUG FIX (GAPS-REPORT-2 §1): this used to reuse the CLI's shared
 * AUTO_CONFIRM=1 flag by delegating to confirmGated()/confirm(). That
 * flag is now restricted, in confirm.ts, to NODE_ENV === "test" —
 * necessarily, because it was reachable from a real interactive `purix`
 * CLI invocation too (a shell profile, a base Docker image, or a CI
 * pipeline's global environment could all plausibly set a variable this
 * common for an unrelated reason, silently rubber-stamping every
 * TrustGate escalation and drift-acceptance checkpoint). Delegating
 * through that restricted check here would silently turn this
 * legitimate, documented, operator-explicit MCP-server-only opt-in into
 * exactly the old hang this comment already describes (confirmGated
 * falling through to confirm()'s readline prompt on a stdin stream that
 * never produces a human keystroke). This now uses its own,
 * specifically-named variable and records the approval directly,
 * keeping its scope — an operator's explicit choice when launching
 * `purix mcp-serve` — entirely separate from the CLI's own bypass.
 */
function mcpConfirmGated(
  message: string,
  checkpointKind: string,
  componentId: string | null
): Promise<boolean> {
  return Promise.resolve((() => {
  if (process.env.PURIX_MCP_AUTO_APPROVE === "1") {
    recordEvent("confirm_response", {
      component_id: componentId,
      detail: { checkpoint_kind: checkpointKind, approved: true, auto_confirmed: true, reason: "mcp_auto_approve_session" },
    });
    return true;
  }
  recordEvent("confirm_response", {
    component_id: componentId,
    detail: { checkpoint_kind: checkpointKind, approved: false, reason: "mcp_no_elicitation_support" },
  });
  return false;
  })());
}

type GatedActionBudget = ReturnType<typeof createGatedActionBudget>;

/**
 * The budget-check-then-confirm preamble every gated MCP tool ran before
 * doing its actual work — same two-step shape and the same "reached its
 * limit" wording, repeated at 7 call sites (purix_create, purix_modify,
 * purix_delete, purix_index --full, purix_accept_drift,
 * purix_migration_activate, purix_migration_rollback — see audit finding
 * 2.5). The confirm-rejection message's verb and CLI-equivalent command
 * differ per tool ("Modification rejected: ... run \"purix modify ...\"" vs
 * "Deletion rejected: ... run \"purix delete ...\"", etc.) — those stay
 * parameters rather than being flattened into one generic string, so this
 * extraction doesn't change what any tool actually says.
 *
 * This doesn't wrap each tool's entire body: what each tool does once
 * approved differs too much per-tool to force through one generic shape
 * without just moving the same-sized closure somewhere else — only the
 * preamble itself is shared here.
 *
 * `extraContext`, when given, is appended to both rejection messages the
 * same way each call site previously did (e.g. purix_create appending its
 * noteLines so an agent hitting the session cap still sees the plan it
 * wasn't able to act on).
 */
async function requireGatedApproval(
  gatedActionBudget: GatedActionBudget,
  checkpointKind: string,
  componentId: string | null,
  confirmMessage: string,
  cliEquivalent: string,
  rejectionVerb: string,
  extraContext?: string
): Promise<{ approved: true } | { approved: false; rejectionMessage: string }> {
  if (!gatedActionBudget.tryConsume(checkpointKind, componentId)) {
    const suffix = extraContext ? `\n\n${extraContext}` : "";
    return {
      approved: false,
      rejectionMessage: `Rejected: this MCP session has reached its limit of ${maxGatedActionsPerSession()} gated-action attempts (PURIX_MCP_MAX_GATED_ACTIONS). Restart the server to continue.${suffix}`,
    };
  }

  const approved = await mcpConfirmGated(confirmMessage, checkpointKind, componentId);
  if (!approved) {
    const suffix = extraContext ? `\n\n${extraContext}` : "";
    return {
      approved: false,
      rejectionMessage: `${rejectionVerb} rejected: this MCP session has no working human-confirmation channel yet (no MCP elicitation support wired in). Run ${cliEquivalent} interactively, or relaunch purix mcp-serve with PURIX_MCP_AUTO_APPROVE=1 if you want gated MCP actions to auto-approve for this session.${suffix}`,
    };
  }

  return { approved: true };
}
import { runIndex } from "@purix/core/manifest/indexer";
import { readComponentFiles } from "@purix/core/entrypoints/modify";
import { ingestDiffFromFile } from "@purix/core/entrypoints/ingest";
import {
  classifyModification,
  classifyGreenfield,
  classifyDiff,
  scanFilesForInjectionAttempts,
  scanDiffForInjectionAttempts,
} from "@purix/core/llm/classify";
import { scanForInjectionAttempts } from "@purix/core/llm/injection";
import { scrubSecrets } from "@purix/core/security/secrets";
import { buildManifestEntry, writeScaffold } from "@purix/core/entrypoints/scaffold";
import { computeSyncHash } from "@purix/core/state/hash";
import { assertAuthorizedToApprove } from "@purix/core/security/auth";
import { checkDrift, acceptDrift } from "@purix/core/state/drift";
import { activateMigration, rollbackMigration, buildMigrationPlan, stageMigration } from "@purix/core/state/migration";
import { compilePatch } from "@purix/core/verify/compile";
import { runEscalation } from "@purix/core/recovery/escalate";
import { resolveVerification } from "@purix/core/recovery/resolve_verification";
import { evaluateTrustGate, hasTestCoverage, checkDeterministicOverrideFloor, loadDofPatterns } from "@purix/core/gates/trustgate";
import { resolveLanguage, getLanguageProvider } from "@purix/core/language/registry";
import { commitVersionedChange, reVerifyCascadeDependents } from "@purix/core/manifest/commit_and_cascade";
import { listMigrations } from "@purix/core/manifest/migrations";
import { listLibrary } from "@purix/core/manifest/library";
import { buildObservabilityReport, formatObservabilityReport } from "@purix/core/manifest/observability";
import { buildAuditTrail, formatAuditTrailJson, formatAuditTrailMarkdown } from "@purix/core/manifest/audit_export";
import { runFullAudit, formatFullAuditLines } from "@purix/core/security/full_audit";
import { verifyAuditChain } from "@purix/core/security/audit_tamper_evidence";
import { recordMemory, readGlobalMemory, formatMemoryLines, GLOBAL_SCOPE } from "@purix/core/manifest/memory";
import { suggestTools, formatSuggestions } from "@purix/core/tools/matchmaker";
import { requireEntitlement } from "@purix/core/licensing/tier";
import { reconcilePendingOperations } from "@purix/core/state/reconcile";
import { existsSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { formatChangeSetDiff } from "@purix/core/cli-io/diff_format";
import { resolveChangeTarget } from "@purix/core/manifest/change_target";
import { resolveTarget, describeMatch } from "@purix/core/manifest/resolver";
import { extractMentions, deriveComponentName } from "@purix/core/manifest/mentions";
import { extractMentionCandidates } from "@purix/core/llm/classify";

// --- Beta-readiness gap-closure (2026-09-03): this file previously had no
// agent identity, no DLP scrub, and no cap on gated-action attempts — see
// AI-HANDOFF notes from the prior architecture review. This server is a
// stdio subprocess (not a networked multi-tenant service), so "identity"
// here means "whoever launched this process told us who they are," not a
// cryptographic guarantee — that's a real but honestly-scoped improvement
// over the previous hardcoded "mcp-agent" literal, not a claim of strong
// auth. Documented here so a future reader doesn't assume more than this
// buys.
//
// --- Coding-agent command-surface expansion (2026-09-08): the server
// originally exposed only purix_status/modify/index/ingest — enough to run
// the Instruction Path, but not enough for an agent to close the loop
// (create a component, retire one, resolve drift, work migrations, see its
// own metrics, leave a note for the next run). This pass adds the rest of
// the *coding-work* surface, mirroring the equivalent CLI command in
// packages/cli/src/cli/commands/ 1:1 — same core functions, same gated
// checkpoints, same event shapes — so nothing here is new policy, only new
// wiring. Every new gated tool uses an "mcp_"-prefixed checkpoint kind
// (mcp_create, mcp_delete, mcp_accept_drift, mcp_migration_activate,
// mcp_migration_rollback), matching the mcp_modify/mcp_index_full
// convention already established below, so the audit trail can always
// tell an MCP-originated gate crossing apart from a CLI-originated one.
//
// Deliberately NOT added here, and not silently — each is either
// account/credential surface, or a separate governance decision that
// belongs to a human, not a "just wire it up" call:
//   - secret set / secret rotate / secret remove / secret status: credential
//     management. An unattended coding agent should never hold the ability
//     to read, rotate, or delete stored secrets.
//   - login / logout: interactive account/session flow, not a
//     stdio tool call.
//   - provider set: changes which LLM provider this whole install bills
//     against — an operator decision, not a per-task one.
//   - backup restore: replaces the ENTIRE manifest across every component
//     in one shot (see backup.ts's own "DESTRUCTIVE" label) — a strictly
//     larger blast radius than purix_delete, which is scoped to one
//     component and already gated. Exporting (purix_backup) is safe and
//     included; restoring is not, pending an explicit decision on it.
//   - lang install / uninstall: installs system-level toolchain binaries.
//   - dev scaffold-language: already commented out in cli.ts as an
//     internal contributor-only tool, never shipped to end users.
//   - mcp-add / mcp-remove / mcp-list / mcp-tools / mcp-call (Purix acting
//     as an MCP *client*): cli.ts leaves registerMcpCommands() unwired on
//     purpose, citing ADR-018 ("MCP Client Commands Governance
//     Deferral") until identity/DLP/budget hardening lands. That hardening
//     is what THIS file now has — but ADR-018 governs a different surface
//     (Purix reaching out to arbitrary other MCP servers) and re-enabling
//     it is its own decision, not a side effect of this pass.
//     (Corrected 2026-09-24: this comment previously cited "ADR-057" —
//     the corpus has no such ADR; cli.ts's own comment at the
//     registerMcpCommands call site cites ADR-018 for this exact
//     deferral, confirmed by direct read.)
//   - diagnostics: reads ~/.purix/logs via getRecentLogs/redactLogContent,
//     which live in packages/cli/src/telemetry/, not packages/core. This
//     package only depends on @purix/core (see package.json) — wiring
//     diagnostics in would mean either adding a new cross-package
//     dependency or duplicating the redaction logic, neither of which is
//     "just expose the existing command."
//
// If any of these should be added, that's a one-line note to Mian, not an
// assumption for a coding agent to make on its own.

/**
 * Whoever launches `purix mcp-serve` (an agent harness, an orchestrator,
 * a human testing locally) sets this to identify itself. No signature,
 * no verification — stdio has no channel to verify it over. Falls back
 * to an explicit "unidentified" label rather than a plausible-looking
 * default, so it's never mistaken for a real identity in the audit trail.
 */
export function getAgentId(): string {
  const raw = process.env.PURIX_MCP_AGENT_ID?.trim();
  return raw && raw.length > 0 ? raw : "unidentified-agent";
}

/** Redacts likely secrets from any text about to leave this process over the MCP transport. */
function scrubResponseText(text: string): string {
  const [scrubbed] = scrubSecrets([{ path: "mcp-response", content: text }]);
  return scrubbed!.content;
}

function textContent(text: string) {
  return { content: [{ type: "text" as const, text: scrubResponseText(text) }] };
}

const DEFAULT_MAX_GATED_ACTIONS = 20;

function maxGatedActionsPerSession(): number {
  const raw = process.env.PURIX_MCP_MAX_GATED_ACTIONS;
  if (!raw) return DEFAULT_MAX_GATED_ACTIONS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_GATED_ACTIONS;
}

/**
 * Session-scoped (one counter per createPurixMcpServer() call, i.e. per
 * process — each `purix mcp-serve` invocation is its own process, same
 * precedent as mcp_gateway.ts's per-call client). This is deliberately
 * NOT the persistent cross-process $-spend ledger llm/budget.ts already
 * maintains — that guards LLM spend over days; this guards a single
 * session against an agent that loops on gated actions faster than a
 * human can sanely keep approving them. Counts attempts, not approvals,
 * so a "no" answer still consumes budget — the risk is prompt-spam, not
 * just successful writes.
 */
/**
 * Tool metadata (MCP 2025-06-18+ tool annotations, per Standard 10 §2).
 * Unset hints fall back to the spec's CONSERVATIVE defaults (destructive,
 * open-world, not read-only), which makes clients prompt for everything —
 * so every tool sets all four hints explicitly, and listing throws if a
 * tool is missing from this table. Hints are advisory to the client; the
 * real safety controls remain the gated-approval checkpoints below.
 *   readOnly    — changes nothing in its environment.
 *   destructive — may overwrite or remove existing state (only meaningful
 *                 when not read-only; false = purely additive).
 *   idempotent  — repeating the same call has no additional effect.
 *   openWorld   — talks to systems outside this project (LLM provider,
 *                 npm registry).
 */
export interface ToolMeta {
  title: string;
  readOnly: boolean;
  destructive: boolean;
  idempotent: boolean;
  openWorld: boolean;
}
export const TOOL_METADATA: Record<string, ToolMeta> = {
  purix_status: { title: "List components", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_find: { title: "Find component from text", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_create: { title: "Create component", readOnly: false, destructive: false, idempotent: false, openWorld: true },
  purix_modify: { title: "Modify component", readOnly: false, destructive: true, idempotent: false, openWorld: true },
  purix_change: { title: "Change component from plain-language intent", readOnly: false, destructive: true, idempotent: false, openWorld: true },
  purix_delete: { title: "Delete component", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  purix_index: { title: "Index codebase", readOnly: false, destructive: false, idempotent: true, openWorld: false },
  purix_ingest: { title: "Ingest external diff", readOnly: false, destructive: true, idempotent: false, openWorld: true },
  purix_accept_drift: { title: "Accept drift", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  purix_migrations_list: { title: "List migrations", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_migration_activate: { title: "Activate migration", readOnly: false, destructive: true, idempotent: false, openWorld: false },
  purix_migration_rollback: { title: "Roll back migration", readOnly: false, destructive: true, idempotent: false, openWorld: false },
  purix_stats: { title: "Show observability stats", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_library: { title: "List reusable library", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_audit: { title: "Run security audit", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_audit_trail: { title: "Export audit trail", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_audit_verify: { title: "Verify audit chain", readOnly: true, destructive: false, idempotent: true, openWorld: false },
  purix_remember: { title: "Record repository memory", readOnly: false, destructive: false, idempotent: false, openWorld: false },
  purix_tools: { title: "Suggest vetted packages", readOnly: true, destructive: false, idempotent: true, openWorld: true },
  purix_backup: { title: "Back up manifest", readOnly: false, destructive: true, idempotent: true, openWorld: false },
  purix_reconcile: { title: "Reconcile interrupted operations", readOnly: false, destructive: true, idempotent: true, openWorld: false },
};

function withToolMetadata<T extends { name: string }>(tools: T[]): (T & { title: string; annotations: Record<string, boolean | string> })[] {
  return tools.map((t) => {
    const m = TOOL_METADATA[t.name];
    if (!m) throw new Error(`Tool "${t.name}" has no entry in TOOL_METADATA — add title and all four annotation hints before shipping it.`);
    return {
      ...t,
      title: m.title,
      annotations: { title: m.title, readOnlyHint: m.readOnly, destructiveHint: m.destructive, idempotentHint: m.idempotent, openWorldHint: m.openWorld },
    };
  });
}

/** Module-private key: carries `change`'s original intent into the create handler without exposing a public parameter. */
const CHANGE_INTENT = Symbol("purix.change.intent");
const MAX_CHANGE_INTENT_LENGTH = 4000;

function createGatedActionBudget() {
  let used = 0;
  const max = maxGatedActionsPerSession();
  return {
    tryConsume(checkpointKind: string, componentId: string | null): boolean {
      if (used >= max) {
        recordEvent("confirm_response", {
          component_id: componentId,
          detail: { checkpoint_kind: checkpointKind, approved: false, reason: "mcp_session_budget_exhausted", agent_id: getAgentId(), max },
        });
        return false;
      }
      used++;
      return true;
    },
  };
}

export function createPurixMcpServer(): Server {
  const gatedActionBudget = createGatedActionBudget();
  const server = new Server(
    {
      name: "purix-mcp-server",
      version: PURIX_VERSION,
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, () => {
    return Promise.resolve({
      tools: withToolMetadata([
        {
          name: "purix_status",
          description: "List all registered manifest components and their verification status.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_find",
          description:
            "Read-only: given plain text (a component name, a file path, a function name, or a sentence containing one), report which tracked component(s) it points to. Uses exact matching against the manifest only — no model call, nothing changes. Use it to check a target before purix_change or purix_modify. Returns outcome single, multiple (with candidates), or none.",
          inputSchema: {
            type: "object",
            properties: { query: { type: "string", description: "Text mentioning a component id, file path, or symbol name" } },
            required: ["query"],
          },
        },
        {
          name: "purix_change",
          description:
            "Describe a change in plain language and let Purix work out which component you mean, then modify it (or, if nothing matches, propose a new component). If more than one component matches, nothing runs: the candidates are returned and you should call again with componentId set. Use this when you do not already know the exact component id; use purix_modify when you do. Applying needs operator approval; set dryRun=true to see the diff first (no approval needed, nothing written).",
          inputSchema: {
            type: "object",
            properties: {
              intent: { type: "string", description: "What should change, in plain language (max 4000 chars)" },
              componentId: { type: "string", description: "Optional exact component id — skips matching" },
              dryRun: { type: "boolean", description: "If true, return the planned diff and gate decision; write nothing" },
            },
            required: ["intent"],
          },
        },
        {
          name: "purix_create",
          description: "Scaffold a brand-new component from a name (Greenfield path; requires gated confirmation checkpoint). Fails if the component already exists — use purix_modify for existing components.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "New component name/id" },
              dryRun: { type: "boolean", description: "If true, return the proposed files without writing or requesting approval" },
            },
            required: ["name"],
          },
        },
        {
          name: "purix_modify",
          description: "Request a component modification instruction (requires gated confirmation checkpoint).",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "Component ID to modify" },
              instruction: { type: "string", description: "Modification instruction" },
              dryRun: { type: "boolean", description: "If true, return the real diff and the TrustGate decision without writing or requesting approval (counts against the session budget)" },
            },
            required: ["componentId", "instruction"],
          },
        },
        {
          name: "purix_delete",
          description: "Permanently remove a component from the manifest (DESTRUCTIVE; requires gated confirmation checkpoint). Refuses if other components still depend on it unless force is set.",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "Component ID to delete" },
              force: { type: "boolean", description: "Delete even if other components still depend on it" },
              deleteFiles: { type: "boolean", description: "Also delete the component's files from disk (default: manifest entry only)" },
            },
            required: ["componentId"],
          },
        },
        {
          name: "purix_index",
          description: "Index codebase components, verify in sandbox, and sync components.json (supports --full with gated confirmation).",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "Path to index" },
              full: { type: "boolean", description: "Full re-index" },
              incremental: { type: "boolean", description: "Incremental indexing" },
              languages: { type: "string", description: "Comma-separated languages" },
            },
          },
        },
        {
          name: "purix_ingest",
          description: "Ingest an external diff patch file against a tracked component, verify in sandbox, and commit for real if it passes.",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "The tracked component this diff applies to (required — ingest commits against this component's manifest entry, the same way \"purix ingest\" does)" },
              diffFilePath: { type: "string", description: "Path to diff/patch file" },
              sourceAgent: { type: "string", description: "Source agent name" },
            },
            required: ["componentId", "diffFilePath"],
          },
        },
        {
          name: "purix_accept_drift",
          description: "Accept the current on-disk state of a component as its new baseline after an out-of-band edit (requires gated confirmation checkpoint; re-verifies in sandbox before accepting).",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "Component ID to accept drift for" },
              agent: { type: "string", description: "The agent believed responsible for the out-of-band edit, if known" },
            },
            required: ["componentId"],
          },
        },
        {
          name: "purix_migrations_list",
          description: "List migration records, optionally filtered to one component.",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "Filter to one component's migrations" },
            },
          },
        },
        {
          name: "purix_migration_activate",
          description: "Activate a staged migration and write it to real files (requires gated confirmation checkpoint).",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Migration id to activate" },
            },
            required: ["id"],
          },
        },
        {
          name: "purix_migration_rollback",
          description: "Roll back an activated migration to its before-snapshot (requires gated confirmation checkpoint).",
          inputSchema: {
            type: "object",
            properties: {
              id: { type: "string", description: "Migration id to roll back" },
            },
            required: ["id"],
          },
        },
        {
          name: "purix_stats",
          description: "Observability metrics: escalation rate, confidence trend, failure clustering, test-integrity/coverage flag rates, approval fatigue, library growth.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_library",
          description: "Show the self-extending local operation library (patterns promoted from escalation).",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_audit",
          description: "Run dependency pinning check + vuln scan + idiom check across manifest-tracked files. Read-only.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_audit_trail",
          description: "Compliance audit-trail export — one row per landed commit, joined with gate evidence. Requires the auditExport entitlement. Returns the report as text (does not write to disk).",
          inputSchema: {
            type: "object",
            properties: {
              componentId: { type: "string", description: "Filter to one component" },
              since: { type: "string", description: "Only include commits at or after this ISO timestamp" },
              format: { type: "string", enum: ["markdown", "json"], description: "Output format (default markdown)" },
            },
          },
        },
        {
          name: "purix_audit_verify",
          description: "Verify local tamper-evident audit chain integrity. Read-only.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_remember",
          description: "Record a convention or decision into Repository Memory, scoped to one component or repo-wide.",
          inputSchema: {
            type: "object",
            properties: {
              note: { type: "string", description: "The convention or decision to record" },
              componentId: { type: "string", description: "Scope this note to one component instead of the whole repo" },
            },
            required: ["note"],
          },
        },
        {
          name: "purix_tools",
          description: "Tool Matchmaker: suggest vetted npm packages for a purpose. Advisory only — never installs anything.",
          inputSchema: {
            type: "object",
            properties: {
              purpose: { type: "string", description: "What you're trying to accomplish, e.g. 'parse CSV files'" },
            },
            required: ["purpose"],
          },
        },
        {
          name: "purix_backup",
          description: "Export the manifest + pending operations to a JSON file. Non-destructive.",
          inputSchema: {
            type: "object",
            properties: {
              outFile: { type: "string", description: "Path to write the backup JSON to" },
            },
            required: ["outFile"],
          },
        },
        {
          name: "purix_reconcile",
          description: "Force a reconciliation pass for crash-interrupted operations. Non-destructive maintenance op.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
      ]),
    });
  });

  server.setRequestHandler(CallToolRequestSchema, (request: any) => handleToolCall(request, gatedActionBudget));

  return server;
}

/**
 * Extracted so tests can invoke a tool call directly against a real
 * budget/agent-id instance, without going through the SDK's stdio
 * transport (there's nothing to connect to in a unit test). Same
 * function the wired-up server actually calls — no test-only duplicate
 * logic to drift from the real path.
 */
export function createToolCaller(): (name: string, args: unknown) => Promise<{ content: { type: "text"; text: string }[] }> {
  const gatedActionBudget = createGatedActionBudget();
  return (name: string, args: unknown) => handleToolCall({ params: { name, arguments: args } }, gatedActionBudget);
}

async function handleToolCall(request: any, gatedActionBudget: ReturnType<typeof createGatedActionBudget>) {
  const origLog = console.log;
  const origWarn = console.warn;
  console.log = (...args: any[]) => console.error(...args);
  console.warn = (...args: any[]) => console.error(...args);

  try {
    const { name, arguments: args } = request.params;

      if (name === "purix_status") {
        const all = listManifest();
        return textContent(JSON.stringify(all, null, 2));
      }

      if (name === "purix_create") {
        const componentName = (args)?.name;
        if (!componentName) {
          throw new Error("name is required");
        }

        if (readManifest(componentName)) {
          return textContent(`Component "${componentName}" already exists in the manifest. Use purix_modify instead.`);
        }

        const dryRun = (args)?.dryRun === true;
        const changeIntent = (args)?.[CHANGE_INTENT] as string | undefined;
        if (dryRun && !gatedActionBudget.tryConsume("mcp_create_dry_run", componentName)) {
          return textContent("Dry-run limit for this session reached — no further previews. Ask the operator to raise it or run the CLI equivalent.");
        }

        const agentId = getAgentId();
        const plan = await classifyGreenfield(componentName, changeIntent);

        // The model chooses plan.component_id, which can differ from the
        // requested name; re-check the id that would actually be written.
        if (plan.component_id !== componentName && readManifest(plan.component_id)) {
          return textContent(`The planned component id "${plan.component_id}" already exists in the manifest — nothing written. Use purix_modify with componentId "${plan.component_id}".`);
        }

        const noteLines: string[] = [];
        noteLines.push(`Proposed component: ${plan.component_id} (${plan.component_type})`);
        for (const f of plan.files) noteLines.push(`  ${f.path} — ${f.purpose}`);
        if (plan.depends_on.length > 0) noteLines.push(`  depends_on: ${plan.depends_on.join(", ")}`);

        // Same repo-wide-conventions check `purix create` runs — a new
        // component has no history of its own yet, so this is the
        // global memory log instead.
        const globalMemory = readGlobalMemory();
        if (globalMemory.length > 0) {
          noteLines.push(`\nRepository Memory — keep these in mind:`);
          for (const line of formatMemoryLines(globalMemory)) noteLines.push(`  ${line}`);
        }

        const matchQuery = `${componentName} ${plan.files.map((f) => f.purpose).join(" ")}`.trim();
        const toolSuggestions = await suggestTools(matchQuery);
        if (toolSuggestions.length > 0) {
          noteLines.push(`\nVetted package suggestion(s) (advisory only, not applied):`);
          noteLines.push(formatSuggestions(toolSuggestions));
        }

        // Show exactly what would be written (no "before" state for a new file).
        noteLines.push(`\nFiles to be written:\n${formatChangeSetDiff(plan.files.map((f) => ({ path: f.path, before: null, after: f.starter_content })))}`);

        if (dryRun) {
          return textContent(`Dry run — nothing written, no approval requested.\n${noteLines.join("\n")}`);
        }

        try {
          await assertAuthorizedToApprove();
        } catch (err) {
          return textContent(`Rejected: ${err instanceof Error ? err.message : String(err)}`);
        }

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_create",
          componentName,
          `MCP Agent "${agentId}" requests creation of "${componentName}":\n${noteLines.join("\n")}\nWrite these files and register the component?`,
          `the equivalent "purix create" command`,
          "Creation",
          noteLines.join("\n")
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        await writeScaffold(plan, process.cwd());
        // Explicit sourceAgent (rather than the CLI's default null) —
        // buildManifestEntry's own doc comment calls this out as the case
        // to pass an id for: something other than a human typing the CLI.
        const entry = buildManifestEntry(plan, agentId);
        entry.last_synced_hash = computeSyncHash(plan.files.map((f) => ({ path: f.path, content: f.starter_content })));
        writeManifestWithLimitCheck(entry);

        const warnings: string[] = [];
        if (plan.depends_on.length > 0) {
          const link = linkComponents(entry.component_id, plan.depends_on);
          if (link.skippedNotFound.length > 0) {
            warnings.push(`depends_on referenced unknown component(s), not linked: ${link.skippedNotFound.join(", ")}`);
          }
        }

        return textContent(
          `"${entry.component_id}" created (v${entry.current_version}).` +
            (warnings.length > 0 ? `\n${warnings.join("\n")}` : "")
        );
      }

      if (name === "purix_modify") {
        const componentId = (args)?.componentId;
        const instruction = (args)?.instruction;
        if (!componentId || !instruction) {
          throw new Error("componentId and instruction are required");
        }

        const entry = readManifest(componentId);
        if (!entry) {
          throw new Error(`Component "${componentId}" not found in manifest.`);
        }

        const dryRun = (args)?.dryRun === true;
        const agentId = getAgentId();

        // Audit-trail parity fix (ADR-028's own caveat): CLI's lifecycle.ts
        // records "request" at the moment a modify invocation reaches the
        // pipeline. The MCP path previously skipped this entirely, meaning
        // an MCP-initiated modification left no trace in the same event
        // stream §10's observability report is built from. Mirror it here.
        recordEvent("request", { component_id: componentId, detail: { instruction, source: "mcp", agent_id: agentId, ...(dryRun ? { dry_run: true } : {}) } });

        if (dryRun) {
          // Dry run writes nothing, so it needs no approval — but each one
          // still spends LLM budget and repo content goes to the provider,
          // so it counts against the same per-session cap (MCP guidance:
          // servers must rate-limit tool invocations).
          if (!gatedActionBudget.tryConsume("mcp_modify_dry_run", componentId)) {
            return textContent("Dry-run limit for this session reached — no further previews. Ask the operator to raise it or run the CLI equivalent.");
          }
        } else {
          const gate = await requireGatedApproval(
            gatedActionBudget,
            "mcp_modify",
            componentId,
            `MCP Agent "${agentId}" requests modification on "${componentId}": "${instruction}". Approve?`,
            `"purix modify ${componentId} <instruction>"`,
            "Modification"
          );
          if (!gate.approved) {
            return textContent(gate.rejectionMessage);
          }
        }

        // REAL FIX (2026-09-19, replaces the no-op write path): everything
        // from here down mirrors lifecycle.ts's real `purix modify` command
        // — same core functions (compilePatch / runEscalation /
        // resolveVerification / evaluateTrustGate / commitVersionedChange),
        // not a reimplementation of them — because the previous version of
        // this handler built candidateFiles straight from the files'
        // UNCHANGED existing content and never called anything that writes
        // to disk, so a "pass" here verified nothing and committed nothing
        // real. See PURIX-CODE-VERIFIED-GAP-REPORT-2026-09-19.md for the
        // three-point trace of why that was true.
        const originalFiles = await readComponentFiles(entry, process.cwd());

        // §9.3 injection scanning, same as lifecycle.ts. The CLI can show a
        // finding and ask a human whether to proceed anyway; this server has
        // no elicitation capability (see mcpConfirmGated's own header
        // comment), so there's no safe way to ask that question here. Fail
        // closed instead of silently proceeding past a real finding.
        const instructionInjectionHits = scanForInjectionAttempts(instruction);
        if (instructionInjectionHits.length > 0) {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "instruction",
            detail: { stage: "mcp_modify", reason: "injection_risk_in_instruction", hits: instructionInjectionHits, source: "mcp", agent_id: agentId },
          });
          return textContent(
            `Refused: instruction-like text found inside the developer instruction itself (§9.3): ${instructionInjectionHits.map((h) => `"${h}"`).join("; ")}. ` +
              `This server has no way to ask a human whether to proceed anyway, so it refuses rather than guess. Run "purix modify ${componentId} <instruction>" directly to review and confirm.`
          );
        }
        const fileInjectionFindings = scanFilesForInjectionAttempts(originalFiles);
        if (fileInjectionFindings.length > 0) {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "instruction",
            detail: { stage: "mcp_modify", reason: "injection_risk_in_files", findings: fileInjectionFindings, source: "mcp", agent_id: agentId },
          });
          return textContent(
            `Refused: instruction-like text found inside "${componentId}"'s existing file content (§9.3). This server has no way to ask a human whether to proceed anyway, so it refuses rather than guess. Run "purix modify ${componentId} <instruction>" directly to review and confirm.`
          );
        }

        const verdict = await classifyModification(componentId, instruction, originalFiles.map((f) => ({ path: f.path, content: f.content })));
        const contractChanged = verdict.contract_changing;

        // Same parity fix: lifecycle.ts records "classification" with the
        // verdict's operation/confidence right after this call. Mirrored
        // here so the confidence-trend and per-operation metrics in
        // observability.ts aren't silently missing every MCP-sourced call.
        recordEvent("classification", {
          component_id: componentId,
          operation: verdict.operation,
          detail: { confidence: verdict.confidence, contract_changing: contractChanged, source: "mcp", agent_id: agentId },
        });

        // Node 4: Patch Compiler — the step the old handler skipped
        // entirely. `compiled.ok` means a deterministic transform exists;
        // otherwise fall through to escalation, exactly like lifecycle.ts.
        const compiled = compilePatch(verdict, originalFiles);
        let finalFiles: { path: string; new_content: string }[];
        let fromEscalation = false;
        let isolationForResponse: string | undefined;

        if (!compiled.ok) {
          const compileReason = (compiled).reason;
          const esc = await runEscalation(componentId, verdict.operation, instruction, originalFiles, compileReason, process.cwd());
          if (!esc.ok) {
            recordEvent("verification_failure", {
              component_id: componentId,
              operation: verdict.operation,
              detail: { stage: "mcp_modify", reason: esc.reason, source: "mcp", agent_id: agentId },
            });
            return textContent(`Escalation failed: ${esc.reason}. No real files were touched.`);
          }
          finalFiles = esc.files!.map((f) => ({ path: f.path, new_content: f.new_content }));
          fromEscalation = true;
        } else {
          const candidateFiles = originalFiles.map((f) => {
            const changed = compiled.files.find((c) => c.path === f.path);
            return { path: f.path, new_content: changed ? changed.new_content : f.content };
          });
          const resolved = await resolveVerification(
            componentId,
            verdict.operation,
            originalFiles,
            candidateFiles,
            "mcp_modify",
            instruction,
            process.cwd()
          );
          if (!("finalFiles" in resolved)) {
            recordEvent("verification_failure", {
              component_id: componentId,
              operation: verdict.operation,
              detail: { stage: "mcp_modify", reason: resolved.reason, source: "mcp", agent_id: agentId },
            });
            return textContent(`Sandbox verification and escalation both failed: ${resolved.reason ?? "unknown reason"}. No real files were touched.`);
          }
          finalFiles = resolved.finalFiles;
          fromEscalation = resolved.fromEscalation;
          if (resolved.verification.status === "pass") {
            isolationForResponse = resolved.verification.isolation;
          }
        }

        // Node 3c: Test-Integrity Check — same gate lifecycle.ts runs before TrustGate.
        const changedFiles = finalFiles.filter((f) => {
          const orig = originalFiles.find((o) => o.path === f.path);
          return orig ? orig.content !== f.new_content : true;
        });
        const lang = resolveLanguage(componentId, process.cwd());
        const provider = getLanguageProvider(lang);
        const testIntegrityChecker = await provider?.getTestIntegrityChecker?.();
        const testFilesBefore = originalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
        const testFilesAfter = finalFiles
          .filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."))
          .map((f) => ({ path: f.path, content: f.new_content }));
        const testIntegrity = testIntegrityChecker
          ? testIntegrityChecker.check(testFilesBefore, testFilesAfter)
          : { flagged: true, findings: [{ path: "unknown", reason: `no test integrity checker registered for language ${lang} — failing closed` }] };
        if (testIntegrity.flagged) {
          recordEvent("test_integrity_flag", { component_id: componentId, operation: verdict.operation, detail: { findings: testIntegrity.findings, source: "mcp", agent_id: agentId } });
        }

        const hasCoverage = hasTestCoverage(changedFiles, process.cwd());
        if (!hasCoverage) {
          recordEvent("coverage_gate_flag", { component_id: componentId, operation: verdict.operation, detail: { changed_files: changedFiles.map((f) => f.path), source: "mcp", agent_id: agentId } });
        }
        recordEvent("gate_evaluation", { component_id: componentId, operation: verdict.operation, detail: { path: "instruction", source: "mcp", agent_id: agentId } });

        // TrustGate (§6.2), same function lifecycle.ts uses, plus the same
        // Deterministic Override Floor check and the same "an
        // escalation-authored fix never auto-commits" rule.
        const dofPatterns = loadDofPatterns(process.cwd());
        const dof = checkDeterministicOverrideFloor(entry.files, dofPatterns);
        let decision = evaluateTrustGate({
          confidence: verdict.confidence,
          contractChanging: verdict.contract_changing,
          injectionSuspected: verdict.suspicious_injected_instruction,
          hasCoverage,
          testIntegrity: { flagged: testIntegrity.flagged, reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined },
        });
        if (fromEscalation && decision.action === "auto_commit") {
          decision = { action: "human_confirm", reason: `escalation-authored fix always requires confirmation, regardless of the original classifier confidence` };
        }
        if (dof.hit && decision.action === "auto_commit") {
          decision = { action: "human_confirm", reason: `touches a Deterministic Override Floor path ("${dof.matchedPath}" matches "${dof.matchedPattern}") — always requires confirmation regardless of confidence (§E-DOF)` };
        }

        if (dryRun) {
          const diff = formatChangeSetDiff(
            finalFiles.map((f) => ({
              path: f.path,
              before: originalFiles.find((o) => o.path === f.path)?.content ?? null,
              after: f.new_content,
            }))
          );
          return textContent(
            `Dry run — nothing written, no approval requested.\nTrustGate: ${decision.action} — ${decision.reason}\n` +
              (decision.action === "abort" ? "A real run would stop here.\n" : `A real run would: ${decision.action}${decision.action === "human_confirm" ? " (operator approval required)" : ""}.\n`) +
              `\nDiff:\n${diff}`
          );
        }

        if (decision.action === "abort") {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: verdict.operation,
            detail: { stage: "mcp_modify", reason: decision.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`TrustGate aborted: ${decision.reason}. No real files were touched. Rephrase the instruction and try again.`);
        }
        // decision.action is "human_confirm" or "auto_commit" here. This
        // server has no interactive elicitation, so a "human_confirm"
        // outcome is treated as satisfied by the gated approval already
        // obtained above (requireGatedApproval, before this handler did any
        // real work) — that approval covers the action a human is being
        // asked to confirm; it doesn't invent a second, silent auto-approve
        // for something nobody agreed to yet.

        const beforeSnapshot = originalFiles.map((f) => ({ path: f.path, content: f.content }));
        const result = await commitVersionedChange({
          componentId,
          entry,
          beforeSnapshot,
          finalFiles,
          operation: verdict.operation,
          patchRef: `v${entry.current_version + 1}-${verdict.operation}`,
          contractChanged,
          provenance: { source_type: "instruction", source_agent: agentId },
          targetDir: process.cwd(),
          reRunCommandHint: `"purix modify ${componentId} <instruction>"`,
        });
        // commitVersionedChange is shared with the CLI and sets
        // process.exitCode on its failure paths, which is meaningless (and
        // actively wrong) in this long-running server process — reset it
        // immediately so a failed commit here can never leak into the exit
        // code of a later, unrelated process shutdown.
        process.exitCode = undefined;
        if (!result.ok) {
          return textContent(`Commit failed for "${componentId}" — no real files were touched, or a conflicting write was rolled back. Re-run "purix modify ${componentId} <instruction>" against current state.`);
        }
        const newVersion = result.newVersion;

        if (contractChanged) {
          const plan = buildMigrationPlan(componentId, verdict.operation, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
          stageMigration(componentId, verdict.operation, newVersion - 1, newVersion, beforeSnapshot, finalFiles.map((f) => ({ path: f.path, content: f.new_content })));
          reVerifyCascadeDependents(entry, process.cwd());
          void plan;
        }

        const isolationNote =
          isolationForResponse === "none" ? " (⚠ isolation: none — this check ran without sandbox containment)" : "";
        return textContent(
          `Modification verified and committed for "${componentId}" (v${newVersion}, contract_changed: ${contractChanged}, files_written: ${finalFiles.length}).${isolationNote}`
        );
      }

      if (name === "purix_find") {
        const query = (args)?.query;
        if (typeof query !== "string" || query.trim() === "") throw new Error("query is required");
        const r = resolveTarget({ mentions: extractMentions(query), manifest: listManifest() });
        const brief = (c: { componentId: string; reason: string; matchedOn: string }) => ({ componentId: c.componentId, reason: c.reason, matchedOn: c.matchedOn });
        return textContent(
          JSON.stringify(
            r.outcome === "single"
              ? { outcome: "single", target: brief(r.target) }
              : r.outcome === "multiple"
              ? { outcome: "multiple", candidates: r.candidates.slice(0, 10).map(brief), next: "Pass one of these ids as componentId to purix_change or purix_modify." }
              : { outcome: "none", next: "No tracked component matches. purix_change would propose a new component." },
            null,
            2
          )
        );
      }

      if (name === "purix_change") {
        const intent = (args)?.intent;
        const componentId = (args)?.componentId;
        const dryRun = (args)?.dryRun === true;
        if (typeof intent !== "string" || intent.trim() === "") throw new Error("intent is required");
        if (intent.length > MAX_CHANGE_INTENT_LENGTH) throw new Error(`intent is too long (max ${MAX_CHANGE_INTENT_LENGTH} characters)`);
        if (componentId !== undefined && typeof componentId !== "string") throw new Error("componentId must be a string");

        const result = await resolveChangeTarget({
          intent,
          manifest: listManifest(),
          componentId,
          // The model-assisted tier runs only when exact matching found
          // nothing; it sends the intent text only, and each use counts
          // against the session budget.
          extractWithLlm: (text) => {
            if (!gatedActionBudget.tryConsume("mcp_change_llm_match", null)) {
              throw new Error("session limit for model-assisted matching reached");
            }
            return extractMentionCandidates(text);
          },
        });

        if (result.outcome === "multiple") {
          return textContent(
            JSON.stringify(
              {
                outcome: "multiple",
                candidates: result.candidates.slice(0, 10).map((c) => ({ componentId: c.componentId, matchedOn: describeMatch(c) })),
                next: "Nothing was changed. Call purix_change again with componentId set to the one you mean.",
              },
              null,
              2
            )
          );
        }

        if (result.outcome === "single") {
          const why = result.source === "override" ? "given componentId" : describeMatch(result.target);
          const inner: any = await handleToolCall(
            { params: { name: "purix_modify", arguments: { componentId: result.target.componentId, instruction: intent, dryRun } } },
            gatedActionBudget
          );
          return textContent(`Target: ${result.target.componentId} (${why})\n${inner.content[0]?.text ?? ""}`);
        }

        const derived = deriveComponentName(intent);
        const inner: any = await handleToolCall(
          { params: { name: "purix_create", arguments: { name: derived, dryRun, [CHANGE_INTENT]: intent } } },
          gatedActionBudget
        );
        return textContent(`No tracked component matches this intent — proposing a new one.\n${inner.content[0]?.text ?? ""}`);
      }

      if (name === "purix_delete") {
        const componentId = (args)?.componentId;
        const force = Boolean((args)?.force);
        const deleteFiles = Boolean((args)?.deleteFiles);
        if (!componentId) {
          throw new Error("componentId is required");
        }

        const entry = readManifest(componentId);
        if (!entry) {
          throw new Error(`No manifest entry for "${componentId}". Call purix_status to see what's tracked.`);
        }

        if (entry.depended_on_by.length > 0 && !force) {
          return textContent(
            `Refused: "${componentId}" still has dependent(s): ${entry.depended_on_by.join(", ")}. ` +
              `Pass force: true to delete anyway (dependents will have this reference removed from their depends_on list), ` +
              `or remove those dependencies first.`
          );
        }

        // TEST-REPORT F1: same guard as the CLI's `delete --files` — the
        // whole-codebase index component tracks every project file, so
        // deleteFiles on it would erase the project. Refuse outright.
        if (deleteFiles && entry.component_type === "codebase_index") {
          return textContent(
            `Refused: "${componentId}" is the whole-codebase index — deleteFiles would delete all ${entry.files.length} tracked file(s) in the project. ` +
              `Delete the manifest entry without deleteFiles, or remove files yourself.`
          );
        }
        const filesOnDiskCount = deleteFiles ? entry.files.filter((relPath) => existsSync(join(process.cwd(), relPath))).length : 0;

        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_delete",
          componentId,
          `MCP Agent "${agentId}" requests permanent deletion of "${componentId}" from the manifest${deleteFiles ? ` and ${filesOnDiskCount} file(s) from disk (${entry.files.slice(0, 5).join(", ")}${entry.files.length > 5 ? ", …" : ""})` : ""}. This cannot be undone. Approve?`,
          `"purix delete ${componentId}"`,
          "Deletion"
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        // Clean up both directions of the dependency graph before the row
        // itself is gone and readManifest(componentId) stops working.
        for (const depId of entry.depends_on) {
          removeDependent(depId, componentId);
        }
        for (const dependentId of entry.depended_on_by) {
          removeDependencyReference(dependentId, componentId);
        }

        const fileWarnings: string[] = [];
        if (deleteFiles) {
          for (const relPath of entry.files) {
            const fullPath = join(process.cwd(), relPath);
            if (existsSync(fullPath)) {
              try {
                rmSync(fullPath);
              } catch (err) {
                fileWarnings.push(`couldn't remove ${relPath}: ${err instanceof Error ? err.message : String(err)}`);
              }
            }
          }
        }

        deleteManifestEntry(componentId);
        recordEvent("component_deleted", {
          component_id: componentId,
          detail: { forced: force, files_removed: deleteFiles, had_dependents: entry.depended_on_by.length > 0, source: "mcp", agent_id: agentId },
        });

        return textContent(
          `Deleted "${componentId}"${deleteFiles ? " (files removed)" : " (manifest entry only — files left on disk)"}.` +
            (fileWarnings.length > 0 ? `\nWarnings: ${fileWarnings.join("; ")}` : "")
        );
      }

      if (name === "purix_index") {
        const full = Boolean((args)?.full);
        const agentId = getAgentId();
        if (full) {
          const gate = await requireGatedApproval(
            gatedActionBudget,
            "mcp_index_full",
            null,
            `MCP Agent "${agentId}" requests full codebase re-index. Approve?`,
            `"purix index --full"`,
            "Full indexing"
          );
          if (!gate.approved) {
            return textContent(gate.rejectionMessage);
          }
        }
        const baseDir = (args)?.path ? resolve(process.cwd(), (args).path) : process.cwd();
        const langs = (args)?.languages ? String((args).languages).split(",") : undefined;
        const result = await runIndex(baseDir, { full, languages: langs });
        return textContent(JSON.stringify(result, null, 2));
      }

      if (name === "purix_ingest") {
        const componentId = (args)?.componentId;
        const diffFilePath = (args)?.diffFilePath;
        const agentId = getAgentId();
        // sourceAgent is caller-supplied app-level provenance about who
        // authored the diff (may be arbitrary/unverified text); agentId
        // above is this MCP session's own identity and is recorded
        // alongside it so the two are never conflated in the audit trail.
        const sourceAgent = (args)?.sourceAgent ?? agentId;
        if (!componentId || !diffFilePath) {
          throw new Error("componentId and diffFilePath are required");
        }

        // REAL FIX (2026-09-19, replaces the no-op write path): the
        // previous version of this handler verified real diff content in
        // the sandbox but never called anything that writes to disk or
        // updates the manifest — a "pass" here committed nothing. This
        // mirrors lifecycle.ts's real `purix ingest` command, which is why
        // componentId is now required (the CLI command ingests against a
        // tracked component's manifest entry; there's no real commit
        // target without one). See
        // PURIX-CODE-VERIFIED-GAP-REPORT-2026-09-19.md for the trace.
        const entry = readManifest(componentId);
        if (!entry) {
          return textContent(`No manifest entry for "${componentId}". Run "purix create" first, or ingest against the right component.`);
        }

        const drift = await checkDrift(entry, process.cwd());
        if (drift.drifted) {
          return textContent(`Refused: "${componentId}" has drifted from its last known state. Run "purix migration accept-drift ${componentId}" first, then retry this ingest.`);
        }
        const originalFiles = drift.liveFiles;

        const ingestRes = await ingestDiffFromFile(diffFilePath, sourceAgent, process.cwd());
        recordEvent("request", { component_id: componentId, detail: { diffFilePath, sourceAgent, source: "mcp", agent_id: agentId } });
        if (!ingestRes.ok) {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: ingestRes.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`Ingest failed: ${ingestRes.reason}`);
        }

        const deletions = ingestRes.files.filter((f) => f.status === "deleted");
        if (deletions.length > 0) {
          return textContent(`Refused: this diff deletes file(s) (${deletions.map((f) => f.path).join(", ")}) — deletion isn't wired into ingest. Handle deletions via purix_delete instead.`);
        }
        const trackedPaths = new Set(entry.files);
        const untrackedModified = ingestRes.files.filter((f) => f.status === "modified" && !trackedPaths.has(f.path));
        if (untrackedModified.length > 0) {
          return textContent(`Refused: this diff modifies file(s) not tracked by "${componentId}": ${untrackedModified.map((f) => f.path).join(", ")}. Link the right component first.`);
        }
        const newFilePaths = ingestRes.files.filter((f) => f.status === "added").map((f) => f.path);

        // §9.3 injection scanning over the diff content — same discipline
        // purix_modify applies above, same fail-closed reasoning (no
        // elicitation capability here to ask a human whether to proceed).
        const injectionFindings = scanDiffForInjectionAttempts(
          ingestRes.files.map((f) => ({ path: f.path, old_content: null, new_content: f.new_content, status: f.status }))
        );
        if (injectionFindings.length > 0) {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: "injection_risk_in_diff", findings: injectionFindings, source: "mcp", agent_id: agentId },
          });
          return textContent(`Refused: instruction-like text found in the ingested diff content (§9.3). This server has no way to ask a human whether to proceed anyway. Run "purix ingest ${componentId} ${diffFilePath}" directly to review and confirm.`);
        }

        const diffVerdict = await classifyDiff(
          componentId,
          sourceAgent,
          ingestRes.files.map((f) => ({
            path: f.path,
            old_content: f.status === "added" ? null : originalFiles.find((o) => o.path === f.path)?.content ?? null,
            new_content: f.new_content,
            status: f.status,
          }))
        );
        recordEvent("classification", {
          component_id: componentId,
          operation: diffVerdict.operation,
          detail: { confidence: diffVerdict.confidence, contract_changing: diffVerdict.contract_changing, path: "diff", source: "mcp", agent_id: agentId },
        });

        const candidateFinalFiles = [
          ...originalFiles.map((f) => {
            const changed = ingestRes.files.find((c) => c.path === f.path);
            return { path: f.path, new_content: changed ? changed.new_content : f.content };
          }),
          ...ingestRes.files.filter((f) => f.status === "added").map((f) => ({ path: f.path, new_content: f.new_content })),
        ];

        const resolved = await resolveVerification(
          componentId,
          "diff_ingest",
          originalFiles,
          candidateFinalFiles,
          "mcp_ingest",
          `apply ingested diff from ${sourceAgent}`,
          process.cwd()
        );
        if (!("finalFiles" in resolved)) {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: resolved.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`Sandbox verification and escalation both failed on ingested diff: ${resolved.reason ?? "unknown reason"}. No real files were touched.`);
        }
        const workingFiles = resolved.finalFiles;
        const fromEscalation = resolved.fromEscalation;
        const isolationForResponse = resolved.verification.status === "pass" ? resolved.verification.isolation : undefined;

        const changedFiles = workingFiles.filter((f) => {
          const orig = originalFiles.find((o) => o.path === f.path);
          return orig ? orig.content !== f.new_content : true;
        });
        const lang = resolveLanguage(componentId, process.cwd());
        const provider = getLanguageProvider(lang);
        const testIntegrityChecker = await provider?.getTestIntegrityChecker?.();
        const testFilesBefore = originalFiles.filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."));
        const testFilesAfter = workingFiles
          .filter((f) => testIntegrityChecker?.isTestFile(f.path) ?? f.path.includes(".test."))
          .map((f) => ({ path: f.path, content: f.new_content }));
        const testIntegrity = testIntegrityChecker
          ? testIntegrityChecker.check(testFilesBefore, testFilesAfter)
          : { flagged: true, findings: [{ path: "unknown", reason: `no test integrity checker registered for language ${lang} — failing closed` }] };
        if (testIntegrity.flagged) {
          recordEvent("test_integrity_flag", { component_id: componentId, operation: "diff_ingest", detail: { findings: testIntegrity.findings, source: "mcp", agent_id: agentId } });
        }
        const hasCoverage = hasTestCoverage(changedFiles, process.cwd());
        if (!hasCoverage) {
          recordEvent("coverage_gate_flag", { component_id: componentId, operation: "diff_ingest", detail: { changed_files: changedFiles.map((f) => f.path), source: "mcp", agent_id: agentId } });
        }
        recordEvent("gate_evaluation", { component_id: componentId, operation: "diff_ingest", detail: { path: "diff", source: "mcp", agent_id: agentId } });

        let decision = evaluateTrustGate({
          confidence: diffVerdict.confidence,
          contractChanging: diffVerdict.contract_changing,
          injectionSuspected: diffVerdict.suspicious_injected_instruction,
          hasCoverage,
          testIntegrity: { flagged: testIntegrity.flagged, reason: testIntegrity.findings.map((f) => `${f.path}: ${f.reason}`).join("; ") || undefined },
        });
        if (fromEscalation && decision.action === "auto_commit") {
          decision = { action: "human_confirm", reason: `escalation-authored fix always requires confirmation, regardless of the original diff-classify confidence` };
        }
        if (decision.action === "abort") {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: decision.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`TrustGate aborted: ${decision.reason}. No real files were touched — the diff was not applied.`);
        }
        // RESTORED 2026-09-25 (regression from the IDEA-078 merge — see the
        // 2026-09-25 session handoff): unlike purix_modify, which calls
        // requireGatedApproval BEFORE any verification work so a later
        // "human_confirm" verdict is already covered by that earlier
        // approval, purix_ingest never calls requireGatedApproval anywhere
        // else in this handler. Without the block below, a "human_confirm"
        // verdict (contract-changing, low-confidence, a DOF hit, or an
        // escalation-authored diff) falls straight through to
        // commitVersionedChange with no human ever asked. The CLI's own
        // `purix ingest` (lifecycle.ts) doesn't have this gap — it renders
        // the diff via formatChangeSetDiff and gates on confirmGated() per
        // IDEA-078 Decision 1. This mirrors that path.
        if (decision.action === "human_confirm") {
          const diffText = formatChangeSetDiff(
            workingFiles.map((f) => ({
              path: f.path,
              before: originalFiles.find((o) => o.path === f.path)?.content ?? null,
              after: f.new_content,
            }))
          );
          const checkpointKind = fromEscalation ? "escalation_fix" : "diff_ingest";
          const gate = await requireGatedApproval(
            gatedActionBudget,
            checkpointKind,
            componentId,
            `MCP Agent "${agentId}" requests committing an ingested diff for "${componentId}" (${decision.reason}).\n\nDiff:\n${diffText}\n\nApply this change to real files now?`,
            `"purix ingest ${componentId} ${diffFilePath}"`,
            "Diff ingest"
          );
          if (!gate.approved) {
            recordEvent("verification_failure", {
              component_id: componentId,
              operation: "diff_ingest",
              detail: { stage: "mcp_ingest", reason: "human_confirm_rejected", source: "mcp", agent_id: agentId },
            });
            return textContent(gate.rejectionMessage);
          }
        }

        recordEvent("verification_pass", {
          component_id: componentId,
          operation: "diff_ingest",
          detail: { stage: "mcp_ingest", file_count: workingFiles.length, source: "mcp", agent_id: agentId, isolation: isolationForResponse },
        });

        const beforeSnapshot = originalFiles.map((f) => ({ path: f.path, content: f.content }));
        const result = await commitVersionedChange({
          componentId,
          entry,
          beforeSnapshot,
          finalFiles: workingFiles,
          operation: "diff_ingest",
          patchRef: `v${entry.current_version + 1}-diff_ingest`,
          contractChanged: diffVerdict.contract_changing,
          provenance: { source_type: "external_diff", source_agent: sourceAgent },
          targetDir: process.cwd(),
          reRunCommandHint: `"purix ingest ${componentId} ${diffFilePath}"`,
          newFilePaths,
        });
        // Same server-safety reset as purix_modify — commitVersionedChange
        // is shared with the CLI and sets process.exitCode on failure,
        // which must never leak into this long-running server's own exit.
        process.exitCode = undefined;
        if (!result.ok) {
          return textContent(`Commit failed for "${componentId}" — no real files were touched, or a conflicting write was rolled back. Re-run against current state.`);
        }
        const newVersion = result.newVersion;

        if (diffVerdict.contract_changing) {
          reVerifyCascadeDependents(entry, process.cwd());
        }

        const isolationNote =
          isolationForResponse === "none" ? " (⚠ isolation: none — this check ran without sandbox containment)" : "";
        return textContent(`Successfully ingested and committed diff for "${componentId}" (v${newVersion}, files_written: ${workingFiles.length}).${isolationNote}`);
      }

      if (name === "purix_accept_drift") {
        const componentId = (args)?.componentId;
        const driftAgent = (args)?.agent ?? null;
        if (!componentId) {
          throw new Error("componentId is required");
        }

        const entry = readManifest(componentId);
        if (!entry) {
          throw new Error(`No manifest entry for "${componentId}".`);
        }

        const drift = await checkDrift(entry, process.cwd());
        if (!drift.drifted) {
          return textContent(`"${componentId}" hasn't drifted — nothing to accept.`);
        }

        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_accept_drift",
          componentId,
          `MCP Agent "${agentId}" requests accepting current on-disk state of "${componentId}" as the new baseline. Approve?`,
          `"purix migration accept-drift ${componentId}"`,
          "Accept-drift"
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        const result = await acceptDrift(entry, drift.liveFiles, drift.liveHash, process.cwd(), driftAgent ?? agentId);
        if (result.ok) {
          recordEvent("reconciliation", { component_id: componentId, detail: { source: "mcp_accept_drift", agent_id: agentId } });
          return textContent(`Baseline accepted for "${componentId}".`);
        }
        return textContent(`Accept-drift failed: ${result.reason}`);
      }

      if (name === "purix_migrations_list") {
        const componentId = (args)?.componentId;
        const records = listMigrations(componentId);
        return textContent(JSON.stringify(records, null, 2));
      }

      if (name === "purix_migration_activate") {
        const id = (args)?.id;
        if (!id) {
          throw new Error("id is required");
        }
        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_migration_activate",
          null,
          `MCP Agent "${agentId}" requests activating migration ${id} and writing it to real files. Approve?`,
          `"purix migration activate"`,
          "Migration activation"
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        const result = await activateMigration(id, process.cwd());
        return textContent(result.ok ? `Migration ${id} activated.` : `Failed to activate migration: ${result.reason}`);
      }

      if (name === "purix_migration_rollback") {
        const id = (args)?.id;
        if (!id) {
          throw new Error("id is required");
        }
        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_migration_rollback",
          null,
          `MCP Agent "${agentId}" requests rolling back migration ${id}. Approve?`,
          `"purix migration rollback"`,
          "Migration rollback"
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        const result = await rollbackMigration(id, process.cwd());
        return textContent(result.ok ? `Migration ${id} rolled back.` : `Failed to rollback migration: ${result.reason}`);
      }

      if (name === "purix_stats") {
        const report = buildObservabilityReport();
        return textContent(formatObservabilityReport(report));
      }

      if (name === "purix_library") {
        const entries = listLibrary();
        return textContent(JSON.stringify(entries, null, 2));
      }

      if (name === "purix_audit") {
        // DUPLICATION FIX (audit finding 2.3, finalized — see
        // full_audit.ts's header comment): this used to duplicate the CLI's
        // `purix audit` command verbatim (version pinning + vuln scan +
        // idiom check, including the exact same messages). Both now call
        // the same runFullAudit(); only the sink differs (joined string
        // here vs console.log per line in observability.ts).
        const result = await runFullAudit(process.cwd());
        return textContent(formatFullAuditLines(result).join("\n"));
      }

      if (name === "purix_audit_trail") {
        requireEntitlement("auditExport");
        const format = (args)?.format === "json" ? "json" : "markdown";
        const report = buildAuditTrail({ componentId: (args)?.componentId, since: (args)?.since });
        const output = format === "json" ? formatAuditTrailJson(report) : formatAuditTrailMarkdown(report);
        return textContent(output);
      }

      if (name === "purix_audit_verify") {
        const result = verifyAuditChain();
        if (!result.valid) {
          return textContent(`Audit chain verification FAILED at record index ${result.compromisedIndex ?? "unknown"}: ${result.reason}`);
        }
        return textContent("Audit chain verification passed — no tampering detected.");
      }

      if (name === "purix_remember") {
        const note = (args)?.note;
        const componentId = (args)?.componentId;
        if (!note) {
          throw new Error("note is required");
        }
        recordMemory({ component_id: componentId ?? GLOBAL_SCOPE, kind: "decision", summary: note });
        return textContent(componentId ? `Recorded under "${componentId}".` : `Recorded as a repo-wide convention.`);
      }

      if (name === "purix_tools") {
        const purpose = (args)?.purpose;
        if (!purpose) {
          throw new Error("purpose is required");
        }
        const suggestions = await suggestTools(purpose);
        return textContent(formatSuggestions(suggestions));
      }

      if (name === "purix_backup") {
        const outFile = (args)?.outFile;
        if (!outFile) {
          throw new Error("outFile is required");
        }
        // Path containment (2026-09-24): this tool writes a file with no
        // approval checkpoint, so an agent-supplied path must not be able
        // to leave the project directory (e.g. "../../.bashrc").
        if (typeof outFile !== "string") throw new Error("outFile must be a string");
        const resolvedOut = resolve(process.cwd(), outFile);
        const rel = relative(process.cwd(), resolvedOut);
        if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
          throw new Error(`outFile must be a file path inside the project directory (got "${outFile}").`);
        }
        const data = exportManifestData();
        await writeFile(resolvedOut, JSON.stringify(data, null, 2), "utf-8");
        return textContent(`Backed up ${data.manifest.length} component(s) to ${resolvedOut}.`);
      }

      if (name === "purix_reconcile") {
        await reconcilePendingOperations();
        return textContent("Reconciliation check complete.");
      }

      throw new Error(`Unknown tool: ${name}`);
  } finally {
    console.log = origLog;
    console.warn = origWarn;
  }
}

export async function runMcpServer(): Promise<void> {
  const server = createPurixMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[purix-mcp] MCP server running on stdio transport.");
}