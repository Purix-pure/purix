// src/cli/commands/evidence.ts
//
// `purix evidence`: the outputs a reviewer can use without trusting Purix (G10).
//   export   the audit chain plus a component summary, as JSON, for the standalone verifier
//   report   a Markdown report for a pull request
//   trailer  git trailer lines; with --message-file, writes them into a commit message (use in a commit-msg hook)
// All three are read-only on the Purix store: no model, no network, nothing appended to the audit chain.
// To check a bundle without Purix, run verifier/purix-evidence-verify.mjs (shipped in this package).
import type { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";

async function load() {
  const [ev, atomic] = await Promise.all([import("@purix/core/evidence/evidence"), import("@purix/core/platform/atomic_write")]);
  const r = ev.buildEvidenceBundle();
  if (r.state === "absent") throw new Error("this folder has no Purix store, so there is no evidence to export. Run a Purix command here first, or cd to the project root.");
  if (r.state === "damaged") throw new Error(`the Purix store is unreadable (${r.detail}). Run \`purix check\` for details.`);
  return { ev, atomic, bundle: r.bundle };
}

function emit(text: string, out: string | undefined, atomic: { writeFileAtomic: (p: string, c: string) => void }, label: string) {
  if (out) {
    atomic.writeFileAtomic(out, text);
    console.error(`${label} written to ${out}`);
  } else process.stdout.write(text);
}

export function registerEvidenceCommands(program: Command) {
  const evidence = program.command("evidence").description("Evidence a reviewer can check without trusting Purix: bundle, PR report, git trailer");

  evidence
    .command("export")
    .description("Write the audit chain and component summary as JSON (read-only). The bundle contains audit record payloads: read it before sharing it.")
    .option("--out <file>", "write to a file instead of stdout")
    .action(async (opts: { out?: string }) => {
      try {
        const { atomic, bundle } = await load();
        emit(JSON.stringify(bundle, null, 2) + "\n", opts.out, atomic, "Evidence bundle");
      } catch (err) {
        console.error(`🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  evidence
    .command("report")
    .description("Write a Markdown verification report for a pull request (read-only)")
    .option("--out <file>", "write to a file instead of stdout")
    .action(async (opts: { out?: string }) => {
      try {
        const { ev, atomic, bundle } = await load();
        emit(ev.renderPrReport(bundle, ev.verifyBundleChain(bundle)), opts.out, atomic, "Report");
      } catch (err) {
        console.error(`🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });

  evidence
    .command("trailer")
    .description("Print git trailer lines (Purix-Evidence, Purix-Records, Purix-Verified); with --message-file, put them in that commit message")
    .option("--message-file <file>", "a commit message file (for a commit-msg hook); existing Purix trailers are replaced")
    .action(async (opts: { messageFile?: string }) => {
      try {
        const { ev, atomic, bundle } = await load();
        const verification = ev.verifyBundleChain(bundle);
        if (!verification.valid) {
          // Never anchor a broken chain into history.
          console.error(`🛑 the audit chain is not intact (${verification.reason}); no trailer written. Run \`purix check\`.`);
          process.exitCode = 1;
          return;
        }
        const lines = ev.trailerLines(bundle);
        if (opts.messageFile) {
          if (!existsSync(opts.messageFile)) throw new Error(`message file not found: ${opts.messageFile}`);
          atomic.writeFileAtomic(opts.messageFile, ev.applyTrailers(readFileSync(opts.messageFile, "utf-8"), lines));
        } else console.log(lines.join("\n"));
      } catch (err) {
        console.error(`🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
