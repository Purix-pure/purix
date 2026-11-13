// packages/cli/src/cli/commands/adopt.ts
//
// `purix adopt <file-or-symbol>`: register ONE already-indexed file as a real
// component so `modify` / `change` can target it. Registers ownership only;
// it edits no source and changes nothing about how a later change is gated.
import { noteLanded } from "./landed.js";
import type { Command } from "commander";

export interface AdoptResult {
  ok: boolean;
  componentId?: string;
  files?: string[];
  message: string;
}

/** Shared by `purix adopt` and by `purix change` when it offers adoption inline. */
export async function runAdopt(target: string, baseDir: string = process.cwd()): Promise<AdoptResult> {
  const [{ listManifest, writeManifestWithLimitCheck }, adopt, { recordEvent }] = await Promise.all([
    import("@purix/core/manifest/store"),
    import("@purix/core/manifest/adopt"),
    import("@purix/core/manifest/events"),
  ]);
  const manifest = listManifest();
  const found = adopt.lookupAdoptable(target, manifest, baseDir);

  if (found.outcome === "already_owned") {
    return { ok: false, message: `"${found.file}" already belongs to component "${found.owner}". Use it directly: purix modify ${found.owner} "<instruction>".` };
  }
  if (found.outcome === "ambiguous") {
    return { ok: false, message: `"${target}" is defined in more than one indexed file:\n${found.candidates.map((c) => `  - ${c}`).join("\n")}\nRe-run with the file path, e.g. purix adopt ${found.candidates[0]}` };
  }
  if (found.outcome === "not_indexed") {
    return { ok: false, message: `"${target}" is not in the index. Run \`purix index\` first (only TypeScript and Python files are indexed), or pass the exact file path or symbol name.` };
  }

  const { entry } = adopt.buildAdoptedEntry({ file: found.file, manifest, baseDir });
  try {
    writeManifestWithLimitCheck(entry); // counts toward the tier's component limit like any other component
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
  recordEvent("component_adopted", { component_id: entry.component_id, operation: "adopt", detail: { files: entry.files, matched_on: found.matchedOn, via: found.via } });
  await noteLanded({ kind: "adopt", component_id: entry.component_id, version: entry.current_version, sync_hash: entry.last_synced_hash, operation: "adopt", source: null });
  return {
    ok: true,
    componentId: entry.component_id,
    files: entry.files,
    message: `Adopted ${entry.files.join(", ")} as component "${entry.component_id}".`,
  };
}

export function registerAdoptCommand(program: Command): void {
  program
    .command("adopt <fileOrSymbol>")
    .description("Make an indexed file changeable: register it (and its test file) as a component, then use modify / change on it")
    .addHelpText(
      "after",
      `
Run \`purix index\` first. Adopt registers ownership only; it does not edit code.

Examples:
  $ purix adopt src/billing/totals.ts
  $ purix adopt roundTotal
  $ purix modify totals "round to 2 decimals"
`
    )
    .action(async (target: string) => {
      if (target.trim().length === 0) {
        console.error("Give a file path or an indexed symbol name, e.g. purix adopt src/api/client.ts");
        process.exitCode = 1;
        return;
      }
      try {
        const result = await runAdopt(target);
        if (!result.ok) {
          console.error(`\n🛑 ${result.message}`);
          process.exitCode = 1;
          return;
        }
        console.log(`✅ ${result.message}`);
        console.log(`   Next: purix modify ${result.componentId} "<what to change>"`);
      } catch (err) {
        console.error(`\n🛑 ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
