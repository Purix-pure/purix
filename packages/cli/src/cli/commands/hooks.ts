// packages/cli/src/cli/commands/hooks.ts
//
// `purix hooks install|uninstall|status`: wires the one shared hook engine (`purix hook`, see hook.ts) into each coding
// agent's own config. This command is unlisted in `purix --help` (PURIX-23): people meet it through docs/HOOKS.md and through
// `purix connect`, not through the command list.
import type { Command } from "commander";
import type { HookAgent } from "@purix/core/hooks/protocol";
import type { HookScope } from "@purix/core/hooks/install";

interface ScopeOpts {
  shared?: boolean;
  user?: boolean;
  project?: boolean;
}

const SCOPE_OPTIONS: [string, string][] = [
  ["--shared", "Claude Code: write the committed .claude/settings.json instead of the personal, uncommitted file"],
  ["--user", "Antigravity: write the global ~/.gemini/config/hooks.json (the default for Antigravity)"],
  ["--project", "Antigravity: write the project's .agents/hooks.json (the Antigravity CLI is reported to ignore it)"],
];

function withScopeOptions(cmd: Command): Command {
  for (const [flag, help] of SCOPE_OPTIONS) cmd.option(flag, help);
  return cmd;
}

async function chooseAgents(agent: string | undefined): Promise<{ agents: HookAgent[]; error?: string }> {
  const { HOOK_AGENTS } = await import("@purix/core/hooks/protocol");
  const { detectHookAgents } = await import("@purix/core/hooks/install");
  if (agent) {
    if (!HOOK_AGENTS.includes(agent as HookAgent)) return { agents: [], error: `Unknown agent "${agent}". Supported: ${HOOK_AGENTS.join(", ")}.` };
    return { agents: [agent as HookAgent] };
  }
  const found = detectHookAgents(process.cwd());
  if (found.length === 0) {
    return { agents: [], error: `No supported agent found in this folder. Name one: purix hooks install <${HOOK_AGENTS.join("|")}>.` };
  }
  return { agents: found };
}

async function scopeFor(agent: HookAgent, opts: ScopeOpts): Promise<HookScope | null> {
  const { scopesFor, defaultScopeFor } = await import("@purix/core/hooks/install");
  const want: HookScope | undefined = opts.shared ? "shared" : opts.user ? "user" : opts.project ? "project" : undefined;
  if (want === undefined) return defaultScopeFor(agent);
  return scopesFor(agent).includes(want) ? want : null;
}

export function registerHooksCommands(program: Command) {
  const hooks = program
    .command("hooks", { hidden: true })
    .description("Make Purix enforce, not just advise: block an agent's direct edits to governed files (Claude Code, Cursor, Codex, Gemini CLI, Antigravity, OpenCode)");

  withScopeOptions(hooks.command("install [agent]").description("Add the Purix hook to an agent (no name: every supported agent already used in this folder). Merges; keeps your other hooks")).action(
    async (agent: string | undefined, opts: ScopeOpts) => {
      const chosen = await chooseAgents(agent);
      if (chosen.error) {
        console.error(chosen.error);
        process.exitCode = 1;
        return;
      }
      const { installHooks, agentLabel, agentNeedsTrust, agentNote } = await import("@purix/core/hooks/install");
      for (const a of chosen.agents) {
        const scope = await scopeFor(a, opts);
        if (scope === null) {
          console.log(`❌ ${agentLabel(a)}: that location option does not apply to it.`);
          process.exitCode = 1;
          continue;
        }
        const { path, result } = installHooks(a, scope, process.cwd());
        if (!result.ok) {
          console.log(`❌ ${agentLabel(a)}: not changed (${path}): ${result.error}`);
          process.exitCode = 1;
          continue;
        }
        console.log(`${result.changed ? "✅" : "✔ "} ${agentLabel(a)}: ${result.changed ? "hook written to" : "already installed in"} ${path}`);
        const trust = agentNeedsTrust(a);
        if (trust) console.log(`   → ${trust}`);
        const note = agentNote(a);
        if (note) console.log(`   ⚠ ${note}`);
      }
      const { commandResolves, PURIX_NOT_ON_PATH_WARNING } = await import("@purix/core/hooks/path_check");
      if (!commandResolves("purix")) console.log(`\n⚠ ${PURIX_NOT_ON_PATH_WARNING}`);
      console.log(
        "\nRestart the agent so it reads the new config. The hook blocks edits made with the agent's own file tools and screens its shell\n" +
          "commands; it does not see edits made by other means. Run `purix hooks status` to check, and see docs/HOOKS.md for the limits."
      );
    }
  );

  withScopeOptions(hooks.command("uninstall [agent]").description("Remove the Purix hook entries (other hooks are left alone)")).action(async (agent: string | undefined, opts: ScopeOpts) => {
    const chosen = await chooseAgents(agent);
    if (chosen.error) {
      console.error(chosen.error);
      process.exitCode = 1;
      return;
    }
    const { uninstallHooks, agentLabel } = await import("@purix/core/hooks/install");
    for (const a of chosen.agents) {
      const scope = await scopeFor(a, opts);
      if (scope === null) {
        console.log(`❌ ${agentLabel(a)}: that location option does not apply to it.`);
        process.exitCode = 1;
        continue;
      }
      const { path, result } = uninstallHooks(a, scope, process.cwd());
      if (!result.ok) {
        console.log(`❌ ${agentLabel(a)}: not changed (${path}): ${result.error}`);
        process.exitCode = 1;
      } else {
        console.log(`${result.changed ? "✅" : "✔ "} ${agentLabel(a)}: ${result.changed ? "hook removed from" : "no Purix hook in"} ${path}`);
      }
    }
  });

  hooks
    .command("status")
    .description("Show where the hook is installed for each agent")
    .action(async () => {
      const { HOOK_AGENTS } = await import("@purix/core/hooks/protocol");
      const { readHookInstallState, scopesFor, agentLabel, agentNeedsTrust } = await import("@purix/core/hooks/install");
      for (const a of HOOK_AGENTS) {
        const lines = scopesFor(a).map((s) => readHookInstallState(a, s, process.cwd()));
        const installed = lines.filter((l) => l.state === "installed");
        const bad = lines.filter((l) => l.state === "partial" || l.state === "unreadable");
        if (installed.length > 0) {
          const { hookStrengthFindings } = await import("@purix/core/hooks/install");
          const { readFileSync } = await import("node:fs");
          for (const l of installed) {
            let weak: string[] = [];
            try { weak = hookStrengthFindings(a, readFileSync(l.path, "utf-8")); } catch { /* unreadable is reported by state */ }
            for (const w of weak) console.log(`⚠  ${agentLabel(a)}: ${w}`);
          }
          const trust = agentNeedsTrust(a) ? " (needs a one-time trust in the agent)" : "";
          console.log(`✅ ${agentLabel(a)}: config present in ${installed.map((l) => l.path).join(", ")}${trust}`);
        } else if (bad.length > 0) console.log(`⚠  ${agentLabel(a)}: ${bad.map((l) => `${l.state} in ${l.path}`).join("; ")}. Run "purix hooks install ${a}" to repair.`);
        else console.log(`➖ ${agentLabel(a)}: not installed.`);
      }
      console.log("\n\"Config present\" is not \"enforcing\": it does not prove the agent loaded the hook. Restart the agent and try an edit to a governed file.");
    });

  hooks
    .command("doctor [agent]")
    .description("Check each installed hook: settings that fail closed, and a canary run of the installed command (simulated payload, not a live agent)")
    .action(async (agent: string | undefined) => {
      const { HOOK_AGENTS } = await import("@purix/core/hooks/protocol");
      if (agent && !HOOK_AGENTS.includes(agent as HookAgent)) {
        console.error(`Unknown agent "${agent}". Supported: ${HOOK_AGENTS.join(", ")}.`);
        process.exitCode = 1;
        return;
      }
      const { runHookDoctor } = await import("@purix/core/hooks/doctor");
      const report = runHookDoctor({ root: process.cwd(), ...(agent ? { agents: [agent as HookAgent] } : {}) });
      const icon = { pass: "✅", fail: "❌", "not-run": "➖" } as const;
      for (const a of report.agents) {
        console.log(`\n${a.label}`);
        for (const c of a.checks) console.log(`  ${icon[c.outcome]} ${c.id}: ${c.message}`);
        console.log(`  Run the canary by hand:\n    bash:       ${a.manual.posix}\n    PowerShell: ${a.manual.powershell}\n    (exit 2, or a JSON deny for Gemini and Antigravity, means a block)`);
      }
      console.log("");
      for (const n of report.notes) console.log(n);
      if (report.agents.some((a) => a.checks.some((c) => c.outcome === "fail")) || report.agents.length === 0) process.exitCode = 1;
    });
}
