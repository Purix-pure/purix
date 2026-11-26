// src/cli/commands/receipt.ts
//
// `purix receipt`: one change's receipt as Markdown, for a pull request description or a review comment.
//
// Why a command and not a file in the repository: the record lives in the project's git folder, which `clone` and `push` do not carry,
// so a reviewer cannot read it. The author renders the receipt from their own record and pastes it. The receipt carries the head of the
// hash chain, which is also in the `Purix-Evidence` commit trailer (`purix evidence trailer`), so a reviewer can compare the two and, with
// the evidence bundle and the standalone verifier, check the chain without trusting Purix.
//
// It reads the record read-only and writes nothing to it. The lines are the dashboard receipt's lines (one function), so a number in a
// pull request is the number in the browser.
import type { Command } from "commander";
import type { ChangeRecord } from "@purix/core/observe/ledger_reader";

export interface ReceiptMarkdownInput {
  change: ChangeRecord;
  lines: [string, string][];
  chain: { valid: boolean; recordCount?: number } | null;
  /** Hash at the head of the audit chain, or null when it could not be read. */
  headHash: string | null;
  version: string;
}

/** Pure: a change's receipt lines in, Markdown out. Tested without a store. */
export function receiptMarkdown(i: ReceiptMarkdownInput): string {
  const width = Math.max(...i.lines.map(([l]) => l.length)) + 2;
  const text = i.lines.map(([l, v]) => `${l.padEnd(width)}${v}`).join("\n");
  const head = i.headHash ? `\`sha256:${i.headHash}\`` : "not read";
  const chainWord = i.chain === null ? "not checked (this change did not land)" : i.chain.valid ? `intact over ${i.chain.recordCount ?? "?"} records` : "NOT intact";
  return [
    `### Purix receipt for change \`${i.change.changeId}\``,
    "",
    "```text",
    text,
    "```",
    "",
    `Chain head: ${head}. Chain: ${chainWord}. Compare the head with the \`Purix-Evidence\` trailer on the commit.`,
    "",
    `Made on the author's machine from the local Purix record (Purix ${i.version}), read-only. A pass means the checks named above passed. It does not mean the code is correct or safe, and costs are estimates. To check the chain without trusting Purix: \`purix evidence export\` and the standalone verifier.`,
    "",
  ].join("\n");
}

export function registerReceiptCommand(program: Command) {
  program
    .command("receipt [changeId]")
    .description("Print one change's receipt as Markdown for a pull request (read-only; default: the latest landed change)")
    .option("--last <n>", "print the last N changes that have an id, newest first (1 to 20)")
    .option("--out <file>", "write to a file instead of stdout")
    .option("--redact", "replace project, component, agent and file names with stable aliases")
    .action(async (changeId: string | undefined, opts: { last?: string; out?: string; redact?: boolean }) => {
      const { EXIT } = await import("@purix/core/cli-io/exit_codes");
      let last: number | undefined;
      if (opts.last !== undefined) {
        last = Number(opts.last);
        if (!Number.isInteger(last) || last < 1 || last > 20 || changeId) {
          console.error(changeId ? "Bad input: give a change id or --last, not both." : "Bad input: --last must be a whole number from 1 to 20.");
          process.exitCode = EXIT.USAGE;
          return;
        }
      }
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
      const { openLedger } = await import("@purix/core/observe/ledger_reader");
      const { resolveSharedStateDir } = await import("@purix/core/state/git_common_dir");
      const { verifyAuditRows } = await import("@purix/core/security/audit_tamper_evidence");
      const { receiptFor, Redactor } = await import("../dashboard/pages.js");
      const { PURIX_VERSION } = await import("../../version.js");
      const ledger = openLedger(resolveSharedStateDir());
      if (!ledger) { console.error("The Purix record could not be read. It may not exist yet, or another process may be holding it. Try again in a moment."); process.exitCode = EXIT.USAGE; return; }
      try {
        let picked: ChangeRecord[];
        if (changeId) {
          const c = ledger.change(changeId);
          if (!c) { console.error(`No change with id ${changeId} is in this project's record. List recent ones with: purix receipt --last 5`); process.exitCode = EXIT.USAGE; return; }
          picked = [c];
        } else if (last !== undefined) {
          picked = ledger.changes({ limit: last });
        } else {
          const latest = ledger.changes().find((c) => c.landedKind !== null) ?? ledger.changes({ limit: 1 })[0];
          picked = latest ? [latest] : [];
        }
        if (picked.length === 0) { console.error("No change with an id is recorded yet, so there is no receipt. Changes made before ids existed have none."); process.exitCode = EXIT.USAGE; return; }
        const red = new Redactor(opts.redact === true);
        const rows = ledger.auditChainRows();
        const headHash = rows.rows.length > 0 ? rows.rows[rows.rows.length - 1]!.hash : null;
        const text = picked.map((c) => {
          const r = receiptFor(ledger, c, (x) => verifyAuditRows(x.rows, x.checkpoint), red);
          return receiptMarkdown({ change: c, lines: r.lines, chain: r.chain, headHash, version: PURIX_VERSION });
        }).join("\n");
        if (opts.out) {
          const { writeFileAtomic } = await import("@purix/core/platform/atomic_write");
          writeFileAtomic(opts.out, text);
          console.error(`Receipt written to ${opts.out}`);
        } else process.stdout.write(text);
      } finally {
        ledger.close();
      }
    });
}
