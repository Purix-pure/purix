// packages/cli/src/cli/commands/config.ts
//
// Part 2: `purix config set/get/delete`, backed by the new generic
// project-local key-value store in packages/core/src/state/config.ts.
import type { Command } from "commander";

async function loadConfigRuntime() {
  const configModule = await import("@purix/core/state/config");
  return { config: configModule.config };
}

export function registerConfigCommands(program: Command) {
  const configCmd = program.command("config").description("List optional data flows, or read or change local Purix configuration for this project");

  // TR-C07: `purix config` (and `purix config list`) show every optional flow, its state and last upload.
  // Read-only; see config_flows.ts.
  const showFlows = async () => {
    const { describeOptionalFlows, formatFlows } = await import("./config_flows.js");
    const { readTelemetry, effectiveConsent, hasStoredChoice } = await import("@purix/core/usage/consent");
    const { loadSession } = await import("@purix/core/security/session");
    const { purixEnv } = await import("@purix/core/platform/env");
    const { statSync } = await import("node:fs");
    const path = await import("node:path");
    const { purixDir } = await import("@purix/core/platform/layout");
    const providers = await import("@purix/core/llm/providers");
    const { DEFAULT_API_BASE_URL } = await import("@purix/core/security/api_contract");

    const t = readTelemetry();
    const eff = effectiveConsent(t.state);
    let login: { email: string } | null = null;
    try { const s = loadSession(); if (s) login = { email: s.email }; } catch { /* unreadable store: show as not signed in */ }
    let syncTime: string | null = null;
    try { syncTime = statSync(path.join(purixDir(process.cwd()), "savings-sync.json")).mtime.toISOString(); } catch { /* none yet */ }
    let providerId: string | null = null;
    let keySource: "stored" | "environment" | "missing" | null = null;
    try {
      providerId = providers.activeProviderId();
      keySource = providers.providerKeyStatus(providerId)?.source ?? null;
    } catch { /* no provider configured */ }

    console.log(formatFlows(describeOptionalFlows({
      telemetry: { stored: hasStoredChoice(), state: t.state, crashDiagnostics: t.crashDiagnostics, effective: { sharing: eff.reason === "enabled", reason: eff.reason } },
      login,
      savingsSyncFileTime: syncTime,
      apiUrl: purixEnv("PURIX_API_URL") ?? DEFAULT_API_BASE_URL,
      provider: { id: providerId, keySource },
      webhookUrlSet: Boolean(purixEnv("PURIX_WEBHOOK_URL")),
    })));
  };
  configCmd.action(showFlows);
  configCmd.command("list").description("List every optional data flow, its state and when it last sent anything").action(showFlows);

  configCmd
    .command("set <key> <value>")
    .description("Set a config value (e.g. `purix config set show-savings off`)")
    .action(async (key: string, value: string) => {
      const runtime = await loadConfigRuntime();
      // Coerce obviously-numeric/boolean-looking values so, e.g.,
      // `purix config set milestone-threshold 100` is stored as a number,
      // not the literal string "100" — matters for the milestone-upsell
      // comparison in lifecycle.ts.
      let coerced: string | number | boolean = value;
      if (value === "true" || value === "false") coerced = value === "true";
      else if (value !== "" && !Number.isNaN(Number(value))) coerced = Number(value);

      runtime.config.set(key, coerced);
      console.log(`✅ ${key} = ${coerced}`);
    });

  configCmd
    .command("get <key>")
    .description("Show a config value")
    .action(async (key: string) => {
      const runtime = await loadConfigRuntime();
      const value = runtime.config.get(key);
      console.log(value === undefined ? `(not set)` : String(value));
    });

  configCmd
    .command("delete <key>")
    .description("Remove a config override, reverting to the default")
    .action(async (key: string) => {
      const runtime = await loadConfigRuntime();
      runtime.config.delete(key);
      console.log(`✅ ${key} reset to default.`);
    });
}
