// src/cli/commands/tools.ts
//
// ADR-060 D9: `purix tools` is the human front door to the tools broker in core. This file only parses
// arguments and renders results; every decision (resolve, consent, install, record, audit) is in
// @purix/core/tools/broker.
import type { Command } from "commander";

const GROUPS = ["language", "testing", "coding", "maintenance"];

type BrokerModule = typeof import("@purix/core/tools/broker");
type Failure = { reason: string; message: string; hint?: string };

function printFailure(f: Failure): void {
  console.error(`\n🛑 ${f.message}`);
  if (f.hint) console.error(`   ${f.hint}`);
  process.exitCode = 1;
}

async function loadBroker(): Promise<BrokerModule> {
  return import("@purix/core/tools/broker");
}

async function withHumanGate() {
  const { createHumanGate } = await import("@purix/core/tools/consent");
  return createHumanGate();
}

export function registerToolsCommands(program: Command) {
  const tools = program
    .command("tools")
    .description("Find, install and check the tools Purix runs (pytest, ruff, tsc, ...). Installs always ask you first.")
    .argument("[purpose...]", 'what you need, in plain words, e.g. "run tests" or "lint python"; matched offline against the catalog')
    .action(async (purpose: string[]) => {
      if (purpose.length === 0) {
        tools.help();
        return;
      }
      await runPurposeSearch(purpose.join(" "));
    });

  tools
    .command("list")
    .description("List the tools in the catalog shipped with this Purix release")
    .option("--group <group>", `only one group: ${GROUPS.join(" | ")}`)
    .action(async (opts: { group?: string }) => {
      if (opts.group && !GROUPS.includes(opts.group)) {
        console.error(`\n🛑 Unknown group "${opts.group}". Choose one of: ${GROUPS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const broker = await loadBroker();
      const entries = broker.listCatalog({ baseDir: process.cwd() }, opts.group ? { group: opts.group as "language" } : {});
      if (entries.length === 0) {
        console.log("(no tools in that group)");
        return;
      }
      console.log("Tools in this release's catalog (pinned versions, hash-locked):");
      for (const e of entries) {
        console.log(`  ${e.id.padEnd(11)} ${e.version.padEnd(8)} ${e.group.padEnd(12)} ${e.capabilities.join(",").padEnd(10)} ${e.languages.join(",")} — ${e.description}`);
      }
    });

  tools
    .command("plan")
    .description("Show which tools this project needs and which are missing. Read-only: installs and creates nothing.")
    .option("--for <languages>", "comma-separated languages (default: detected from the folder)")
    .action(async (opts: { for?: string }) => {
      const broker = await loadBroker();
      const deps = { baseDir: process.cwd() };
      let languages = opts.for ? opts.for.split(",").map((l) => l.trim()).filter(Boolean) : broker.detectLanguages(deps);
      if (languages.length === 0) {
        const all = new Set(broker.listCatalog(deps).flatMap((e) => e.languages));
        languages = [...all].sort();
        console.log(`(no project files found here; showing every language in the catalog: ${languages.join(", ")})`);
      }
      const plan = broker.planForLanguages(deps, languages);
      if (plan.warning) console.log(`⚠ ${plan.warning}`);
      for (const language of languages) {
        console.log(`\n${language}:`);
        for (const n of plan.needs.filter((x) => x.need.language === language)) {
          const label = n.need.capability.padEnd(10);
          if (!n.chosen) {
            console.log(`  ${label} — nothing in the catalog (${n.note ?? "no candidate"})`);
            continue;
          }
          const id = n.chosen.entry.id;
          const state =
            n.state === "installed" ? "installed" : n.state === "project-provided" ? "project provides its own" : `missing — run: purix tools install ${id}`;
          console.log(`  ${label} ${id}@${n.chosen.entry.version} — ${state}`);
          console.log(`  ${" ".repeat(10)} why: ${n.chosen.reasons.join("; ")}`);
          const others = n.candidates.slice(1).map((c) => c.entry.id);
          if (others.length > 0) console.log(`  ${" ".repeat(10)} also available: ${others.join(", ")}`);
        }
      }
    });

  tools
    .command("install <id>")
    .description("Install one tool from the catalog into your Purix tools folder (asks first; hash-checked; no install scripts)")
    .action(async (id: string) => {
      const broker = await loadBroker();
      const result = await broker.installTool({ baseDir: process.cwd(), consent: await withHumanGate() }, id);
      if (!result.ok) return printFailure(result);
      console.log(result.alreadyInstalled ? `✅ ${id} is already installed (${result.record.version}).` : `✅ Installed ${id} ${result.record.version} into your Purix tools folder (not into the project).`);
      if (result.warning) console.log(`⚠ ${result.warning}`);
    });

  tools
    .command("approve <requestId>")
    .description("Review and approve an install an AI agent asked for (shows what it will do; asks you)")
    .action(async (requestId: string) => {
      const broker = await loadBroker();
      const result = await broker.approveRequest({ baseDir: process.cwd(), consent: await withHumanGate() }, requestId);
      if (!result.ok) return printFailure(result);
      console.log(`✅ Installed ${result.record.id} ${result.record.version} into your Purix tools folder (not into the project).`);
      if (result.warning) console.log(`⚠ ${result.warning}`);
    });

  tools
    .command("status")
    .description("Show installed tools, whether they still match their lock, and install requests waiting for you")
    .action(async () => {
      const broker = await loadBroker();
      const { listPending } = await import("@purix/core/tools/consent");
      const baseDir = process.cwd();
      const s = broker.toolStatus({ baseDir });
      if (s.corrupt) console.log(`⚠ the install records in your Purix tools folder are unreadable: ${s.corrupt}`);
      if (s.ignoredInProject) console.log(`⚠ ${s.ignoredInProject} inside this project is not used: Purix keeps its tools in your user folder, and a project's own copy is never trusted. Run \`purix tools install <id>\` to install them again.`);
      if (s.installed.length === 0) console.log("No tools installed by Purix in this project.");
      for (const i of s.installed) {
        const mark = i.state === "ok" ? "ok" : `${i.state}${i.detail ? ` (${i.detail})` : ""}`;
        console.log(`  ${i.record.id.padEnd(11)} ${i.record.version.padEnd(8)} ${mark}`);
      }
      const pending = listPending(baseDir);
      if (pending.length > 0) {
        console.log("\nInstall requests waiting for you:");
        for (const p of pending) console.log(`  ${p.id}  ${p.toolId}  from ${p.origin}${p.reason ? ` — "${p.reason}"` : ""}  → purix tools approve ${p.id}`);
      }
    });

  tools
    .command("remove <id>")
    .description("Delete an installed tool from your Purix tools folder and record it")
    .action(async (id: string) => {
      const broker = await loadBroker();
      const result = broker.removeTool({ baseDir: process.cwd() }, id);
      if (!result.ok) return printFailure(result);
      console.log(result.removed ? `✅ Removed ${id}.` : `${id} was not installed.`);
    });
}

/**
 * `purix tools "<purpose>"`: match plain words against the catalog shipped with this release.
 * Offline, read-only, installs nothing. The next step is always a command the user can read and run.
 */
async function runPurposeSearch(purpose: string): Promise<void> {
  const broker = await loadBroker();
  console.log(broker.formatPurposeResult(broker.searchPurpose({ baseDir: process.cwd() }, purpose)));
}
