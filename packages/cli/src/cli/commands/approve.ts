// packages/cli/src/cli/commands/approve.ts
//
// `purix approve <id>`, `purix deny <id>` and `purix approve --list` (C-30, D-20).
//
// When a coding agent cannot answer an MCP prompt, Purix returns a request id instead of acting. A person
// answers it here. These commands are not on the MCP surface, and they refuse to approve anything unless a
// person is at a terminal: no `--yes` flag, no piped input. An agent that runs shell commands without a
// terminal therefore cannot approve its own request. (An agent with a real terminal session can still type
// here; hooks that deny `purix approve` and writes to `.purix/` are what close that, see docs/HOOKS.md.)
import type { Command } from "commander";

export interface DecisionDeps {
  baseDir: string;
  /** True only when a person can answer: both stdin and stdout are terminals. */
  interactive: boolean;
  /** Asks the person the final yes/no. Injected so tests never touch a real terminal. */
  ask: (question: string) => Promise<boolean>;
  print: (line: string) => void;
}

export type DecisionResult = { code: 0 | 1; outcome: "approved" | "denied" | "refused" | "cancelled" | "error" };

export async function runDecision(id: string, decision: "approved" | "denied", deps: DecisionDeps): Promise<DecisionResult> {
  const { loadApprovalForReview, decideApproval, approvalStatus } = await import("@purix/core/approvals/pending");
  const verb = decision === "approved" ? "Approve" : "Deny";

  if (!deps.interactive) {
    deps.print(`${verb} needs a person at a terminal. Nothing was changed.`);
    deps.print("Run this yourself in a terminal window; it cannot be done from a script, a pipe or an agent's tool call.");
    return { code: 1, outcome: "refused" };
  }

  const record = loadApprovalForReview(deps.baseDir, id);
  if (!record) {
    const view = approvalStatus(deps.baseDir, id);
    deps.print(view?.state === "invalid" ? `Request ${id} failed its integrity check and was not used.` : `No request "${id}" in this folder.`);
    return { code: 1, outcome: "error" };
  }

  deps.print(`Request ${record.id}`);
  deps.print(`  Tool:      ${record.tool}`);
  deps.print(`  Component: ${record.componentId ?? "(none)"}`);
  deps.print(`  Asked by:  ${record.client ?? "unknown agent"}`);
  deps.print(`  Expires:   ${record.expiresAt}`);
  deps.print(`  Status:    ${record.status}`);
  deps.print("");
  deps.print(record.message);
  deps.print("");

  if (!(await deps.ask(`${verb} this request?`))) {
    deps.print("Cancelled. The request is unchanged.");
    return { code: 0, outcome: "cancelled" };
  }

  const result = decideApproval(deps.baseDir, id, decision);
  if (!result.ok) {
    deps.print(`Not recorded: ${result.reason}.`);
    return { code: 1, outcome: "error" };
  }

  const { recordEvent } = await import("@purix/core/manifest/events");
  recordEvent("confirm_response", {
    component_id: record.componentId,
    detail: {
      checkpoint_kind: record.checkpointKind,
      approved: decision === "approved",
      reason: decision === "approved" ? "pending_request_approved_cli" : "pending_request_denied_cli",
      request_id: record.id,
      ...(typeof (record.payload as { diffHash?: unknown } | undefined)?.diffHash === "string" ? { diff_hash: (record.payload as { diffHash: string }).diffHash } : {}),
      tool: record.tool,
      action_key: record.actionKey,
      message_hash: record.messageHash,
      client: record.client,
      decided_by: "terminal",
    },
  });
  deps.print(decision === "approved" ? "Approved. The agent can now call the tool again; this approval works once." : "Denied. The agent has been told not to retry.");
  return { code: 0, outcome: decision === "approved" ? "approved" : "denied" };
}

/**
 * `purix approve --show <id>`: prints the request and the complete diff it carries. Read-only (it decides nothing),
 * so unlike approve and deny it does not need a terminal. AI-09: the approval prompt shows the first 120 diff lines;
 * this is how a person reads the rest before answering.
 */
export async function runShow(id: string, deps: Pick<DecisionDeps, "baseDir" | "print">): Promise<DecisionResult> {
  const { loadApprovalForReview, approvalStatus } = await import("@purix/core/approvals/pending");
  const { createHash } = await import("node:crypto");
  const record = loadApprovalForReview(deps.baseDir, id);
  if (!record) {
    const view = approvalStatus(deps.baseDir, id);
    deps.print(view?.state === "invalid" ? `Request ${id} failed its integrity check and was not used.` : `No request "${id}" in this folder.`);
    return { code: 1, outcome: "error" };
  }
  deps.print(`Request ${record.id}  (${record.status}, expires ${record.expiresAt})`);
  deps.print(`  Tool:      ${record.tool}`);
  deps.print(`  Component: ${record.componentId ?? "(none)"}`);
  deps.print(`  Asked by:  ${record.client ?? "unknown agent"}`);
  deps.print("");
  const payload = record.payload as { diff?: unknown; diffHash?: unknown } | undefined;
  if (typeof payload?.diff !== "string" || typeof payload.diffHash !== "string") {
    deps.print("This request carries no stored diff. What the agent asked for:");
    deps.print("");
    deps.print(record.message);
    return { code: 0, outcome: "cancelled" };
  }
  const intact = createHash("sha256").update(payload.diff).digest("hex") === payload.diffHash;
  deps.print(`Diff hash: ${payload.diffHash.slice(0, 12)}${intact ? "" : "  (MISMATCH: the stored diff does not match its hash; do not approve)"}`);
  deps.print("");
  deps.print(payload.diff);
  return { code: intact ? 0 : 1, outcome: intact ? "cancelled" : "error" };
}

export async function runList(baseDir: string, print: (line: string) => void, all: boolean): Promise<void> {
  const { listApprovals } = await import("@purix/core/approvals/pending");
  const rows = listApprovals(baseDir).filter((r) => all || r.state === "pending");
  if (rows.length === 0) {
    print(all ? "No approval requests in this folder." : "No requests are waiting. (--all shows finished ones.)");
    return;
  }
  for (const r of rows) {
    print(`${r.id}  ${r.state.padEnd(8)} ${r.tool}  ${r.componentId ?? "-"}  expires ${r.expiresAt}`);
    print(`    ${r.summary}`);
  }
}

export function registerApproveCommands(program: Command) {
  const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const deps = async (): Promise<DecisionDeps> => {
    const { confirm } = await import("@purix/core/cli-io/confirm");
    return { baseDir: process.cwd(), interactive: interactive(), ask: confirm, print: (l) => console.log(l) };
  };

  program
    .command("approve [id]", { hidden: true })
    .description("Approve a request an agent made through MCP (needs a terminal; list waiting requests with --list)")
    .option("--list", "List requests waiting for an answer")
    .option("--all", "With --list: include answered and expired requests")
    .option("--show", "Print the request and its complete diff without answering it")
    .action(async (id: string | undefined, opts: { list?: boolean; all?: boolean; show?: boolean }) => {
      if (opts.show && id) {
        const res = await runShow(id, { baseDir: process.cwd(), print: (l) => console.log(l) });
        process.exitCode = res.code;
        return;
      }
      if (opts.list || !id) {
        await runList(process.cwd(), (l) => console.log(l), Boolean(opts.all));
        return;
      }
      const res = await runDecision(id, "approved", await deps());
      process.exitCode = res.code;
    });

  program
    .command("deny <id>", { hidden: true })
    .description("Deny a request an agent made through MCP (needs a terminal)")
    .action(async (id: string) => {
      const res = await runDecision(id, "denied", await deps());
      process.exitCode = res.code;
    });
}
