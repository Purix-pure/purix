// packages/cli/src/cli/commands/hook_payload_log.ts
//
// Opt-in record of what a real agent sends the hook, so the first run of each agent (C-20, docs/HOOKS.md "What is not
// verified") leaves evidence instead of a memory. OFF unless PURIX_HOOK_PAYLOAD_LOG names a file. Each call appends one JSON
// line: when, agent, event, what Purix answered, and the payload with every string cut to 200 characters (so a whole file
// body in a write call is not copied). It is meant for a throwaway project; it never throws and never changes the answer.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

const MAX_STRING = 200;

/** The payload with every string value shortened. Anything that is not valid JSON is logged as a shortened string. */
export function truncatePayload(raw: string): unknown {
  const cut = (v: unknown): unknown => {
    if (typeof v === "string") return v.length > MAX_STRING ? `${v.slice(0, MAX_STRING)}…[+${v.length - MAX_STRING} chars]` : v;
    if (Array.isArray(v)) return v.slice(0, 50).map(cut);
    if (v !== null && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 50).map(([k, x]) => [k, cut(x)]));
    return v;
  };
  try {
    return cut(JSON.parse(raw));
  } catch {
    return cut(raw);
  }
}

export function appendPayloadLog(
  file: string | undefined,
  entry: { agent: string; event: string; raw: string; exitCode: number; stdout: string; stderr: string },
): void {
  if (!file) return;
  try {
    mkdirSync(dirname(file), { recursive: true });
    const line = {
      time: new Date().toISOString(),
      agent: entry.agent,
      event: entry.event,
      exitCode: entry.exitCode,
      stdout: entry.stdout.slice(0, MAX_STRING),
      stderr: entry.stderr.slice(0, MAX_STRING),
      payload: truncatePayload(entry.raw),
    };
    appendFileSync(file, `${JSON.stringify(line)}\n`);
  } catch {
    /* a log that cannot be written must never change what the hook answers */
  }
}
