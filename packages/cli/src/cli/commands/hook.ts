// packages/cli/src/cli/commands/hook.ts
//
// `purix hook <agent> <event>`: what an agent's hook configuration runs. It reads the agent's JSON payload from stdin and
// answers with an exit code (and, for Cursor, JSON). It is hidden from `purix --help`: people run `purix hooks install`.
//
// Printing lives here, not in core (rule R1). Exit codes: 0 = no objection, 2 = block. Anything else would be read by
// Claude Code as "the hook failed, carry on", so every failure path in this file ends in 2 for a pre-tool event.
import type { Command } from "commander";
import type { HookAgent, HookEvent } from "@purix/core/hooks/protocol";
import { appendPayloadLog } from "./hook_payload_log.js";

const MAX_PAYLOAD_BYTES = 8 * 1024 * 1024;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buf.length;
    if (size > MAX_PAYLOAD_BYTES) throw new Error("the hook payload is larger than 8 MB");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

export function registerHookCommand(program: Command) {
  program
    .command("hook <agent> <event>", { hidden: true })
    .description("Run by a coding agent's hook configuration (not by hand): reads the agent's payload on stdin and allows or blocks the call")
    .action(async (agent: string, event: string) => {
      const { HOOK_AGENTS, HOOK_EVENTS, denyAnswer } = await import("@purix/core/hooks/protocol");
      if (!HOOK_AGENTS.includes(agent as HookAgent) || !HOOK_EVENTS.includes(event as HookEvent)) {
        console.error(`purix hook: unknown agent or event "${agent} ${event}" (agents: ${HOOK_AGENTS.join(", ")}; events: ${HOOK_EVENTS.join(", ")})`);
        process.exitCode = 2;
        return;
      }
      try {
        const [{ runHook }, payload] = await Promise.all([import("@purix/core/hooks/run"), readStdin()]);
        const answer = runHook(agent as HookAgent, event as HookEvent, payload);
        // Opt-in evidence for the real-agent runs (docs/HOOKS.md). Off unless PURIX_HOOK_PAYLOAD_LOG names a file.
        appendPayloadLog(process.env["PURIX_HOOK_PAYLOAD_LOG"], { agent, event, raw: payload, exitCode: answer.exitCode, stdout: answer.stdout, stderr: answer.stderr });
        if (answer.stdout) process.stdout.write(answer.stdout + "\n");
        if (answer.stderr) process.stderr.write(answer.stderr + "\n");
        process.exitCode = answer.exitCode;
      } catch (err) {
        // Could not even read the payload. A pre-tool call is blocked; a stop call is let through.
        if (event === "stop") {
          process.exitCode = 0;
          return;
        }
        const answer = denyAnswer(agent as HookAgent, `the Purix hook failed before it could check (${err instanceof Error ? err.message : String(err)}). Run \`purix check\` and tell the person.`);
        if (answer.stdout) process.stdout.write(answer.stdout + "\n");
        if (answer.stderr) process.stderr.write(answer.stderr + "\n");
        process.exitCode = answer.exitCode;
      }
    });
}
