// packages/cli/src/cli/commands/connect.ts
//
// Registers Purix's MCP server (`purix mcp-serve`) with a coding agent's
// own config, via the `add-mcp` library. Writes project-scoped config
// (e.g. .mcp.json, .cursor/mcp.json, opencode.json) for agents that support
// it, and falls back to that agent's global config path for agents that
// don't (e.g. Antigravity, Windsurf — see connect.global-fallback.test.ts
// for why that fallback has to be exercised in a separate child process).
//
// connectAgent() itself (and the `add-mcp` import it needs) lives in
// ./connect_agent.js, imported lazily below — see that file's header
// comment for why. This file only imports `add-mcp`'s types, which are
// erased at compile time and cost nothing at runtime, so registering this
// command (loading this file, which happens for `purix connect --help`
// too) no longer pays to load `add-mcp` itself.
//
// IDEA-090: `connect` is the first command a new user runs, in a folder that has no agent files yet. It used to
// print one sentence and stop, exit 0, with nothing connected. Now: it names the agents it can connect, lets a person
// pick one at a terminal, and exits non-zero when it connected nothing so a script can tell. It also never creates
// Purix state (.purix/) — it only writes the agent's own config.
import type { Command } from "commander";
import type { HookAgent } from "@purix/core/hooks/protocol";

type AgentModule = typeof import("./connect_agent.js");

function printSupportedAgents(mod: AgentModule, write: (line: string) => void): void {
  const all = mod.supportedAgents();
  const common = mod.COMMON_AGENTS.map((id) => all.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => a !== undefined);
  const others = all.filter((a) => !mod.COMMON_AGENTS.includes(a.id));
  const line = (a: (typeof all)[number]) =>
    `  ${a.id.padEnd(20)} ${a.displayName.padEnd(24)} ${a.scope === "project" ? `writes ${a.config} in this project` : "writes your per-user config (applies to every project)"}`;
  write("Coding agents Purix can connect to:");
  for (const a of common) write(line(a));
  if (others.length > 0) {
    write("  more:");
    for (const a of others) write(line(a));
  }
}

/** At a terminal only: shows the common agents and returns the id the person picked, or undefined. */
async function pickAgent(mod: AgentModule): Promise<string | undefined> {
  const { promptLine } = await import("@purix/core/cli-io/confirm");
  const all = mod.supportedAgents();
  const choices = mod.COMMON_AGENTS.map((id) => all.find((a) => a.id === id)).filter((a): a is NonNullable<typeof a> => a !== undefined);
  console.log("No coding agent was found in this folder. Which one do you use?");
  choices.forEach((a, i) => console.log(`  ${i + 1}. ${a.displayName} (${a.id})`));
  const answer = await promptLine(`Choose 1-${choices.length}, or type an agent id (purix connect --list shows all; Enter to cancel): `);
  const text = answer?.trim() ?? "";
  if (text === "") return undefined;
  const number = Number.parseInt(text, 10);
  if (String(number) === text) return choices[number - 1]?.id;
  return mod.resolveAgentId(text);
}

export function registerConnectCommand(program: Command) {
  program
    .command("connect [agent]")
    .description(
      "Register Purix's MCP server with a coding agent (Claude Code, Cursor, Codex, OpenCode, etc.) — auto-detects the agent(s) in this project if none is given",
    )
    .option(
      "--agent-id <id>",
      "Identity recorded in the audit trail for actions from this agent (defaults to the identity already recorded for this agent, else the agent type)",
    )
    .option("--list", "List the coding agents Purix can connect to, and where each one's config is written, then stop")
    .option("--user", "Write the agent's per-user config (applies to every project) instead of this project's file")
    .option("--no-verify", "Do not start the Purix server to check it works on this machine")
    .option("--no-instructions", "Do not write the short 'how to use Purix' note into CLAUDE.md / AGENTS.md / GEMINI.md / Cursor rules")
    .option("--hooks", "Install the agent's Purix hook after connecting, without asking")
    .option("--no-hooks", "Do not offer to install the hook")
    .addHelpText(
      "after",
      `
Examples:
  $ purix connect                 find the agent(s) already used in this folder (or ask which one)
  $ purix connect opencode        connect OpenCode (adds to your opencode.json or opencode.jsonc; in a project with neither it creates opencode.jsonc)
  $ purix connect claude-code
  $ purix connect --list
`,
    )
    .action(
      async (
        agent: string | undefined,
        options: { agentId?: string; list?: boolean; user?: boolean; verify?: boolean; instructions?: boolean; hooks?: boolean },
      ) => {
      const [mod, { detectProjectAgents }] = await Promise.all([import("./connect_agent.js"), import("add-mcp")]);
      const { connectAgent, readRecordedAgentId, resolveAgentId, planConnectTargets, supportedAgents } = mod;

      if (options.list) {
        printSupportedAgents(mod, (l) => console.log(l));
        return;
      }

      const cwd = process.cwd();
      let targets: string[];

      if (agent) {
        const id = resolveAgentId(agent);
        if (id === undefined) {
          console.error(`\n🛑 "${agent}" is not an agent Purix knows how to connect to.\n`);
          printSupportedAgents(mod, (l) => console.error(l));
          process.exitCode = 1;
          return;
        }
        targets = [id];
      } else {
        const plan = planConnectTargets(detectProjectAgents(cwd), cwd);
        for (const s of plan.sharedWith) {
          console.log(`ℹ ${s.agent} reads the same config file as ${s.covered}, so connecting ${s.covered} covers it.`);
        }
        targets = plan.targets;
        if (targets.length === 0) {
          const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
          const picked = interactive ? await pickAgent(mod) : undefined;
          if (picked === undefined) {
            if (interactive) console.log("Nothing connected.");
            else {
              console.error("No coding agent was found in this folder, and there is no terminal to ask in. Nothing was connected.\n");
              printSupportedAgents(mod, (l) => console.error(l));
              console.error("\nPick one, for example: purix connect opencode");
            }
            process.exitCode = 1;
            return;
          }
          targets = [picked];
        }
      }

      const extras = await import("./connect_extras.js");
      const scope: "project" | "user" = options.user ? "user" : "project";
      const names = new Map(supportedAgents().map((a) => [a.id, a]));
      const connected: string[] = [];
      for (const target of targets) {
        const info = names.get(target);
        const label = info ? `${info.displayName} (${target})` : target;
        const agentId = options.agentId ?? readRecordedAgentId(target, cwd, scope) ?? target;
        const { result } = connectAgent(target, cwd, agentId, scope);
        if (result.success) {
          connected.push(target);
          const perUser = info?.scope === "global" || scope === "user";
          console.log(`✅ Connected purix to ${label} — wrote ${result.path}`);
          console.log(`   Audit identity: ${agentId}${options.agentId ? "" : " (pass --agent-id <id> to change it)"}`);
          if (perUser) {
            console.log(
              info?.scope === "global"
                ? "   This agent only has a per-user config, so the connection applies to every project you open with it."
                : "   Written to your per-user config, so the connection applies to every project you open with this agent.",
            );
          } else if (info?.scope === "project") {
            console.log("   Scope: this project only (use --user to write your per-user config instead).");
          }
          // Per-user connections apply to every project; a project instruction file would only cover this one.
          if (options.instructions !== false && !perUser) {
            try {
              const wrote = extras.writeInstructionBlock(cwd, target);
              if (wrote.changed) console.log(`   Wrote a short "how to use Purix" note to ${wrote.path} (your own text there is untouched; --no-instructions skips this).`);
              else if (wrote.skipped) console.log(`   Did not write the instruction note to ${wrote.path}: ${wrote.skipped}.`);
            } catch (err) {
              console.log(`   Could not write the instruction note: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
          console.log(`   Next: restart ${info?.displayName ?? target} so it loads the new server, then ask it to run the purix_status tool.`);
        } else {
          console.log(`❌ Failed to connect purix to ${label}: ${result.error ?? "unknown error"}`);
          process.exitCode = 1;
        }
      }
      if (connected.length === 0) return;

      if (!extras.commandOnPath("purix")) {
        console.log(
          "\n⚠ `purix` is not on your PATH, and the agent starts the server with that command. Install it globally (npm install -g @purix/cli) or edit the config to use `npx -y @purix/cli mcp-serve`.",
        );
      }

      if (options.verify !== false) {
        const check = await extras.checkServerStarts();
        if (check.ok) {
          console.log(`\n✅ Checked on this machine: the Purix server starts and answers (${check.tools} tools). This does not show your agent has loaded it; restart the agent for that.`);
        } else {
          console.log(`\n❌ The Purix server did not start on this machine: ${check.reason}`);
          console.log("   The config was written, but the agent would fail to start the server. (--no-verify skips this check.)");
          process.exitCode = 1;
        }
      }

      // Hooks are what make Purix enforce rather than advise. Offered, never installed silently, and never without a person to answer.
      if (options.hooks !== false) {
        // Loaded only when there is something to ask or install: a plain `purix connect` run should not pay for them.
        const offer = await extras.offerHooks({
          cwd,
          connected,
          flag: options.hooks,
          interactive: extras.canPrompt(),
          ask: async (question) => (await import("@purix/core/cli-io/confirm")).confirm(question),
          print: (l) => console.log(l),
          install: async (hookAgent, dir) => {
            const { installHooks, defaultScopeFor } = await import("@purix/core/hooks/install");
            const agentName = hookAgent as HookAgent;
            const res = installHooks(agentName, defaultScopeFor(agentName), dir);
            const { commandResolves, PURIX_NOT_ON_PATH_WARNING } = await import("@purix/core/hooks/path_check");
            if (res.result.ok && !commandResolves("purix")) console.log(`⚠ ${PURIX_NOT_ON_PATH_WARNING}`);
            return res.result.ok ? { ok: true, path: res.path } : { ok: false, error: res.result.error ?? "unknown error" };
          },
        });
        if (offer.failed > 0) process.exitCode = 1;
      }
      },
    );
}
