// packages/mcp-server/src/server.ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  listManifest,
  readManifest,
  writeManifest,
  writeManifestWithLimitCheck,
  linkComponents,
  deleteManifestEntry,
  removeDependent,
  removeDependencyReference,
  exportManifestData,
} from "@purix/core/manifest/store";
import { recordEvent } from "@purix/core/manifest/events";

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
async function mcpConfirmGated(
  message: string,
  checkpointKind: string,
  componentId: string | null
): Promise<boolean> {
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
import { verifyInSandbox } from "@purix/core/sandbox/sandbox";
import { readComponentFiles } from "@purix/core/entrypoints/modify";
import { ingestDiffFromFile } from "@purix/core/entrypoints/ingest";
import { classifyModification, classifyGreenfield } from "@purix/core/llm/classify";
import { scrubSecrets } from "@purix/core/security/secrets";
import { buildManifestEntry, writeScaffold } from "@purix/core/entrypoints/scaffold";
import { computeSyncHash } from "@purix/core/state/hash";
import { assertAuthorizedToApprove } from "@purix/core/security/auth";
import { checkDrift, acceptDrift } from "@purix/core/state/drift";
import { activateMigration, rollbackMigration } from "@purix/core/state/migration";
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
import { resolve, join } from "node:path";

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
//   - secret-set / secret-rotate / secret-remove / secrets-status: credential
//     management. An unattended coding agent should never hold the ability
//     to read, rotate, or delete stored secrets.
//   - auth login / auth logout: interactive account/session flow, not a
//     stdio tool call.
//   - provider-set: changes which LLM provider this whole install bills
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
//     purpose, citing ADR-057 ("MCP Client Commands Governance
//     Deferral") until identity/DLP/budget hardening lands. That hardening
//     is what THIS file now has — but ADR-057 governs a different surface
//     (Purix reaching out to arbitrary other MCP servers) and re-enabling
//     it is its own decision, not a side effect of this pass.
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
      version: "0.2.0-beta.0",
    },
    {
      capabilities: {
        tools: {},
      },
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        {
          name: "purix_status",
          description: "List all registered manifest components and their verification status.",
          inputSchema: {
            type: "object",
            properties: {},
          },
        },
        {
          name: "purix_create",
          description: "Scaffold a brand-new component from a name (Greenfield path; requires gated confirmation checkpoint). Fails if the component already exists — use purix_modify for existing components.",
          inputSchema: {
            type: "object",
            properties: {
              name: { type: "string", description: "New component name/id" },
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
          description: "Ingest an external diff patch file and verify in sandbox.",
          inputSchema: {
            type: "object",
            properties: {
              diffFilePath: { type: "string", description: "Path to diff/patch file" },
              sourceAgent: { type: "string", description: "Source agent name" },
            },
            required: ["diffFilePath"],
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
      ],
    };
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
        const componentName = (args as any)?.name;
        if (!componentName) {
          throw new Error("name is required");
        }

        if (readManifest(componentName)) {
          return textContent(`Component "${componentName}" already exists in the manifest. Use purix_modify instead.`);
        }

        const agentId = getAgentId();
        const plan = await classifyGreenfield(componentName);

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

        try {
          await assertAuthorizedToApprove();
        } catch (err) {
          return textContent(`Rejected: ${err instanceof Error ? err.message : err}`);
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
        const componentId = (args as any)?.componentId;
        const instruction = (args as any)?.instruction;
        if (!componentId || !instruction) {
          throw new Error("componentId and instruction are required");
        }

        const entry = readManifest(componentId);
        if (!entry) {
          throw new Error(`Component "${componentId}" not found in manifest.`);
        }

        const agentId = getAgentId();

        // Audit-trail parity fix (ADR-058's own caveat): CLI's lifecycle.ts
        // records "request" at the moment a modify invocation reaches the
        // pipeline. The MCP path previously skipped this entirely, meaning
        // an MCP-initiated modification left no trace in the same event
        // stream §10's observability report is built from. Mirror it here.
        recordEvent("request", { component_id: componentId, detail: { instruction, source: "mcp", agent_id: agentId } });

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

        const files = await readComponentFiles(entry, process.cwd());
        const candidateFiles = files.map((f) => ({ path: f.path, new_content: f.content }));
        
        const verdict = await classifyModification(componentId, instruction, files.map(f => ({ path: f.path, content: f.content })));
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

        const sandboxResult = verifyInSandbox(componentId, candidateFiles, process.cwd());

        if (sandboxResult.status === "fail") {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: verdict.operation,
            detail: { stage: "mcp_modify", reason: sandboxResult.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`Sandbox verification failed: ${sandboxResult.reason}`);
        }

        if (sandboxResult.status === "not_installed") {
          recordEvent("verification_failure", {
            component_id: componentId,
            operation: verdict.operation,
            detail: { stage: "mcp_modify", reason: sandboxResult.reason, not_installed: true, source: "mcp", agent_id: agentId },
          });
          return textContent(`Tooling not installed: ${sandboxResult.reason} (${sandboxResult.actionHint ?? ""})`);
        }

        recordEvent("verification_pass", {
          component_id: componentId,
          operation: verdict.operation,
          detail: { stage: "mcp_modify", source: "mcp", agent_id: agentId, isolation: sandboxResult.isolation },
        });

        entry.current_version += 1;
        entry.version_history.push({
          version: entry.current_version,
          operation: "mcp_modify",
          patch_ref: instruction,
          contract_changed: contractChanged,
          timestamp: new Date().toISOString(),
          provenance: { source_type: "instruction", source_agent: agentId },
        });
        writeManifest(entry);

        // BUG FIX (GAPS-REPORT §2.3): a "pass" reached with no sandbox
        // isolation (isolation: "none" — no bwrap/sandbox-exec available,
        // or, for TypeScript's tsc step specifically, a check that never
        // runs through the sandbox layer at all) is a materially weaker
        // guarantee than one reached under real containment, and an
        // agent reading this response has no other way to tell the
        // difference between the two.
        const isolationNote =
          sandboxResult.isolation === "none" ? " (⚠ isolation: none — this check ran without sandbox containment)" : "";
        return textContent(
          `Modification verified and committed for "${componentId}" (v${entry.current_version}, contract_changed: ${contractChanged}). Sandbox execution passed successfully.${isolationNote}`
        );
      }

      if (name === "purix_delete") {
        const componentId = (args as any)?.componentId;
        const force = Boolean((args as any)?.force);
        const deleteFiles = Boolean((args as any)?.deleteFiles);
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

        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_delete",
          componentId,
          `MCP Agent "${agentId}" requests permanent deletion of "${componentId}" from the manifest${deleteFiles ? " and its files from disk" : ""}. This cannot be undone. Approve?`,
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
                fileWarnings.push(`couldn't remove ${relPath}: ${err instanceof Error ? err.message : err}`);
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
        const full = Boolean((args as any)?.full);
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
        const baseDir = (args as any)?.path ? resolve(process.cwd(), (args as any).path) : process.cwd();
        const langs = (args as any)?.languages ? String((args as any).languages).split(",") : undefined;
        const result = await runIndex(baseDir, { full, languages: langs });
        return textContent(JSON.stringify(result, null, 2));
      }

      if (name === "purix_ingest") {
        const diffFilePath = (args as any)?.diffFilePath;
        const agentId = getAgentId();
        // sourceAgent is caller-supplied app-level provenance about who
        // authored the diff (may be arbitrary/unverified text); agentId
        // above is this MCP session's own identity and is recorded
        // alongside it so the two are never conflated in the audit trail.
        const sourceAgent = (args as any)?.sourceAgent ?? agentId;
        if (!diffFilePath) {
          throw new Error("diffFilePath is required");
        }

        const ingestRes = await ingestDiffFromFile(diffFilePath, sourceAgent, process.cwd());
        recordEvent("request", { component_id: null, detail: { diffFilePath, sourceAgent, source: "mcp", agent_id: agentId } });
        if (!ingestRes.ok) {
          recordEvent("verification_failure", {
            component_id: null,
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: ingestRes.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`Ingest failed: ${ingestRes.reason}`);
        }

        const sandboxResult = verifyInSandbox("ingested-diff", ingestRes.files, process.cwd());
        if (sandboxResult.status === "fail") {
          recordEvent("verification_failure", {
            component_id: "ingested-diff",
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: sandboxResult.reason, source: "mcp", agent_id: agentId },
          });
          return textContent(`Sandbox verification failed on ingested diff: ${sandboxResult.reason}`);
        }

        // Bug fix (2026-09-09): verifyInSandbox has a third status —
        // "not_installed" — that this branch previously fell straight
        // through, past the "fail" check, and into the pass path below.
        // That meant an ingest into a project with no detectable test
        // framework got recorded as verification_pass and reported back
        // as "Successfully ingested and verified" despite verification
        // never actually running. purix_modify already handled this
        // status correctly; this brings purix_ingest to parity with it.
        if (sandboxResult.status === "not_installed") {
          recordEvent("verification_failure", {
            component_id: "ingested-diff",
            operation: "diff_ingest",
            detail: { stage: "mcp_ingest", reason: sandboxResult.reason, not_installed: true, source: "mcp", agent_id: agentId },
          });
          return textContent(`Tooling not installed: ${sandboxResult.reason} (${sandboxResult.actionHint ?? ""})`);
        }

        recordEvent("verification_pass", {
          component_id: "ingested-diff",
          operation: "diff_ingest",
          detail: { stage: "mcp_ingest", file_count: ingestRes.files.length, source: "mcp", agent_id: agentId, isolation: sandboxResult.isolation },
        });

        // BUG FIX (GAPS-REPORT §2.3): see the identical note on the
        // purix_modify pass response above — isolation: "none" is a
        // materially weaker guarantee and needs to be visible here too.
        const isolationNote =
          sandboxResult.isolation === "none" ? " (⚠ isolation: none — this check ran without sandbox containment)" : "";
        return textContent(`Successfully ingested and verified diff across ${ingestRes.files.length} files.${isolationNote}`);
      }

      if (name === "purix_accept_drift") {
        const componentId = (args as any)?.componentId;
        const driftAgent = (args as any)?.agent ?? null;
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
          `"purix accept-drift ${componentId}"`,
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
        const componentId = (args as any)?.componentId;
        const records = listMigrations(componentId);
        return textContent(JSON.stringify(records, null, 2));
      }

      if (name === "purix_migration_activate") {
        const id = (args as any)?.id;
        if (!id) {
          throw new Error("id is required");
        }
        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_migration_activate",
          null,
          `MCP Agent "${agentId}" requests activating migration ${id} and writing it to real files. Approve?`,
          `"purix migration-activate"`,
          "Migration activation"
        );
        if (!gate.approved) {
          return textContent(gate.rejectionMessage);
        }

        const result = await activateMigration(id, process.cwd());
        return textContent(result.ok ? `Migration ${id} activated.` : `Failed to activate migration: ${result.reason}`);
      }

      if (name === "purix_migration_rollback") {
        const id = (args as any)?.id;
        if (!id) {
          throw new Error("id is required");
        }
        const agentId = getAgentId();

        const gate = await requireGatedApproval(
          gatedActionBudget,
          "mcp_migration_rollback",
          null,
          `MCP Agent "${agentId}" requests rolling back migration ${id}. Approve?`,
          `"purix migration-rollback"`,
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
        const format = (args as any)?.format === "json" ? "json" : "markdown";
        const report = buildAuditTrail({ componentId: (args as any)?.componentId, since: (args as any)?.since });
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
        const note = (args as any)?.note;
        const componentId = (args as any)?.componentId;
        if (!note) {
          throw new Error("note is required");
        }
        recordMemory({ component_id: componentId ?? GLOBAL_SCOPE, kind: "decision", summary: note });
        return textContent(componentId ? `Recorded under "${componentId}".` : `Recorded as a repo-wide convention.`);
      }

      if (name === "purix_tools") {
        const purpose = (args as any)?.purpose;
        if (!purpose) {
          throw new Error("purpose is required");
        }
        const suggestions = await suggestTools(purpose);
        return textContent(formatSuggestions(suggestions));
      }

      if (name === "purix_backup") {
        const outFile = (args as any)?.outFile;
        if (!outFile) {
          throw new Error("outFile is required");
        }
        const resolvedOut = resolve(process.cwd(), outFile);
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