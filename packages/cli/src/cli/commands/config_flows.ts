// packages/cli/src/cli/commands/config_flows.ts
//
// TR-C07: `purix config` lists every OPTIONAL flow (anything that can send data off this machine),
// its state, where the data would go, and when something was last sent. Read-only: it creates no
// file, opens no manifest, and makes no network call. The gathering is split from the printing so
// a test can feed it fixed inputs.
//
// "Last sent" for savings sync is the modification time of savings-sync.json, which the client only
// rewrites after the server acknowledges events. It is a file time, not a server record, and the
// output says so. Telemetry upload does not exist in this version, so its last-sent value is "never".

export type FlowState = "on" | "off" | "not set up";

export interface OptionalFlow {
  id: "telemetry" | "crash-diagnostics" | "savings-sync" | "llm-provider" | "webhook";
  title: string;
  state: FlowState;
  /** Plain-words reason for the state. */
  detail: string;
  /** What leaves the machine when this flow runs. */
  sends: string;
  /** Where it goes. */
  to: string;
  /** How to change it. */
  control: string;
  lastSent: string;
}

export interface FlowInputs {
  telemetry: { stored: boolean; state: "unset" | "on" | "off"; crashDiagnostics: boolean; effective: { sharing: boolean; reason: string } };
  login: { email: string } | null;
  /** ISO time of the last acknowledged savings upload for this project, or null if none/unknown. */
  savingsSyncFileTime: string | null;
  apiUrl: string;
  provider: { id: string | null; keySource: "stored" | "environment" | "missing" | null };
  webhookUrlSet: boolean;
}

const TELEMETRY_WHY: Record<string, string> = {
  enabled: "enabled",
  not_enabled: "off (not enabled)",
  do_not_track: "off (DO_NOT_TRACK is set)",
  ci: "off (running in CI)",
};

function host(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function describeOptionalFlows(i: FlowInputs): OptionalFlow[] {
  const flows: OptionalFlow[] = [];

  flows.push({
    id: "telemetry",
    title: "Anonymous usage data",
    state: i.telemetry.state === "on" ? "on" : "off",
    detail: i.telemetry.state === "on" ? `consent given; sharing right now: ${TELEMETRY_WHY[i.telemetry.effective.reason] ?? i.telemetry.effective.reason}` : i.telemetry.stored ? "you turned it off" : "off by default; you have not chosen",
    sends: "nothing: upload is not available in this version (see `purix telemetry show` for the payload that would be sent)",
    to: "no endpoint exists yet",
    control: "purix telemetry enable | disable",
    lastSent: "never (no upload exists)",
  });

  flows.push({
    id: "crash-diagnostics",
    title: "Crash diagnostics",
    state: i.telemetry.crashDiagnostics ? "on" : "off",
    detail: i.telemetry.crashDiagnostics ? "switch is on" : "off by default",
    sends: "nothing: no upload exists in this version",
    to: "no endpoint exists yet",
    control: "purix telemetry status",
    lastSent: "never (no upload exists)",
  });

  flows.push({
    id: "savings-sync",
    title: "Savings sync to your Purix account",
    state: i.login ? "on" : "off",
    detail: i.login ? `signed in as ${i.login.email}` : "not signed in, so nothing is synced",
    sends: "a random machine id, a random per-install project label, and per call: time, type and dollar saving. Never code, paths or prompts",
    to: host(i.apiUrl),
    control: i.login ? "purix logout" : "purix login",
    lastSent: !i.login ? "never (not signed in)" : i.savingsSyncFileTime ? `${i.savingsSyncFileTime} (time of this project's sync file)` : "no upload recorded for this project",
  });

  const p = i.provider;
  flows.push({
    id: "llm-provider",
    title: "LLM provider",
    state: p.id ? "on" : "not set up",
    detail: p.id ? `${p.id}${p.keySource ? `; key ${p.keySource === "missing" ? "missing" : `from ${p.keySource}`}` : ""}` : "no provider configured, so no model call can be made",
    sends: "the content needed for a classify or modify call (for example a diff or file excerpt), only when you run such a command",
    to: p.id ? `the ${p.id} service you chose` : "n/a",
    control: "purix provider set <id> | purix provider status",
    lastSent: "not recorded by Purix (calls go straight to the provider)",
  });

  flows.push({
    id: "webhook",
    title: "Notification webhook",
    state: i.webhookUrlSet ? "on" : "off",
    detail: i.webhookUrlSet ? "PURIX_WEBHOOK_URL is set in this environment" : "PURIX_WEBHOOK_URL is not set",
    sends: "a short signed notice when a gated action needs confirmation",
    to: i.webhookUrlSet ? "the URL you set (not shown here)" : "n/a",
    control: "set or unset the PURIX_WEBHOOK_URL environment variable",
    lastSent: "not recorded by Purix",
  });

  return flows;
}

export function formatFlows(flows: OptionalFlow[]): string {
  const lines: string[] = ["Optional flows (anything that can send data off this machine). Nothing here is checked over the network.", ""];
  for (const f of flows) {
    lines.push(`${f.title}: ${f.state.toUpperCase()}`);
    lines.push(`  why:        ${f.detail}`);
    lines.push(`  sends:      ${f.sends}`);
    lines.push(`  goes to:    ${f.to}`);
    lines.push(`  last sent:  ${f.lastSent}`);
    lines.push(`  change:     ${f.control}`);
    lines.push("");
  }
  lines.push("Local settings: `purix config get <key>`, `purix config set <key> <value>`.");
  return lines.join("\n");
}
