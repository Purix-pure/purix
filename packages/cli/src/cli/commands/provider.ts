// src/cli/commands/provider.ts
//
// CLI surface for the BYOK provider layer (src/llm/providers.ts).
import type { Command } from "commander";

export function registerProviderCommands(program: Command) {
  program
    .command("provider-set <id>")
    .description("Choose which LLM provider Purix calls — bring your own key. Run provider-list to see all supported ids.")
    .option("--base-url <url>", "required if id is 'custom': the OpenAI-compatible base URL")
    .option("--key-env <name>", "required if id is 'custom': env var / secret name holding the API key")
    .option("--model-low <id>", "required if id is 'custom': model id for the low tier")
    .option("--model-high <id>", "required if id is 'custom': model id for the high tier")
    .option("--label <text>", "optional display label for a custom provider")
    .action(async (id: string, opts: { baseUrl?: string; keyEnv?: string; modelLow?: string; modelHigh?: string; label?: string }) => {
      const { listProviders, persistProviderChoice, persistCustomProvider } = await import("@purix/core/llm/providers");
      if (id === "custom") {
        if (!opts.baseUrl || !opts.keyEnv || !opts.modelLow || !opts.modelHigh) {
          console.log(
            `"custom" needs all of: --base-url --key-env --model-low --model-high\n` +
              `Example: purix provider-set custom --base-url https://api.example.ai/v1 ` +
              `--key-env EXAMPLE_API_KEY --model-low example-small --model-high example-large`
          );
          return;
        }
        persistCustomProvider({
          baseUrl: opts.baseUrl,
          keyEnvVar: opts.keyEnv,
          modelLow: opts.modelLow,
          modelHigh: opts.modelHigh,
          label: opts.label,
        });
        console.log(`✅ Custom provider configured (${opts.baseUrl}). Store the key: purix secret-set ${opts.keyEnv} <your-key>`);
        return;
      }
      const known = listProviders().find((p) => p.id === id);
      if (!known) {
        console.log(`Unknown provider "${id}". Run "purix provider-list" to see supported ids, or use "custom" for anything else.`);
        return;
      }
      persistProviderChoice(id);
      console.log(`✅ Active provider set to "${id}" (${known.label}). Make sure a key is stored: purix secret-set ${known.keyEnvVar} <your-key>`);
    });

  program
    .command("provider-status")
    .description("Show which LLM provider is active and whether a key is configured")
    .action(async () => {
      const { listProviders, activeProviderId, getProvider } = await import("@purix/core/llm/providers");
      let id: string;
      try {
        id = activeProviderId();
      } catch {
        console.log(`No provider configured yet. Run "purix provider-list" to see options, then "purix provider-set <id>".`);
        return;
      }
      const known = listProviders().find((p) => p.id === id);
      console.log(`Active provider: ${id}${known ? `  (${known.label})` : ""}`);
      try {
        const p = getProvider(id);
        console.log(`Model (low tier):  ${p.modelFor("low")}`);
        console.log(`Model (high tier): ${p.modelFor("high")}`);
        console.log(`(Key resolution happens on first call — run a real "purix modify" to fully verify it.)`);
      } catch (err) {
        console.log(`🛑 ${err instanceof Error ? err.message : err}`);
      }
    });

  program
    .command("provider-list")
    .description("List every supported LLM provider (registry + the custom escape hatch)")
    .action(async () => {
      const { listProviders, activeProviderId } = await import("@purix/core/llm/providers");
      let active: string | null = null;
      try {
        active = activeProviderId();
      } catch {
        // No provider configured yet — that's expected for a fresh install, not an error here.
      }
      for (const p of listProviders()) {
        console.log(`${p.id}${p.id === active ? "  (active)" : ""} — ${p.label} — requires ${p.keyEnvVar}`);
      }
      if (!active) {
        console.log(`\n(No provider configured yet — pick one above and run "purix provider-set <id>".)`);
      }
      console.log(`\nDon't see your provider? Nearly every LLM vendor exposes an OpenAI-compatible endpoint —`);
      console.log(`use "purix provider-set custom --base-url <url> --key-env <n> --model-low <id> --model-high <id>".`);
    });
}