// src/cli/commands/provider.ts
//
// CLI surface for the BYOK provider layer (src/llm/providers.ts).
import type { Command } from "commander";

export function registerProviderCommands(program: Command) {
  // COMMAND-SURFACE FIX (2026-09-22 CLI/MCP command-standard pass): grouped
  // from three flat, hyphenated top-level commands into a noun-then-verb
  // subcommand group — see security.ts's matching comment for the standard
  // this follows and why it's safe to do now (pre-first-release).
  const providerCmd = program.command("provider").description("Choose and inspect Purix's LLM provider (BYOK)");

  providerCmd
    .command("set <id>")
    .description("Choose which LLM provider Purix calls — bring your own key. Run provider list to see all supported ids.")
    .option("--base-url <url>", "required if id is 'custom': the OpenAI-compatible base URL")
    .option("--key-env <name>", "required if id is 'custom': env var / secret name holding the API key")
    .option("--model-low <id>", "required if id is 'custom': model id for the low tier")
    .option("--model-high <id>", "required if id is 'custom': model id for the high tier")
    .option("--label <text>", "optional display label for a custom provider")
    .action(async (id: string, opts: { baseUrl?: string; keyEnv?: string; modelLow?: string; modelHigh?: string; label?: string }) => {
      const { listProviders, persistProviderChoice, persistCustomProvider } = await import("@purix/core/llm/providers");
      if (id === "custom") {
        if (!opts.baseUrl || !opts.keyEnv || !opts.modelLow || !opts.modelHigh) {
          console.error(
            `"custom" needs all of: --base-url --key-env --model-low --model-high\n` +
              `Example: purix provider set custom --base-url https://api.example.ai/v1 ` +
              `--key-env EXAMPLE_API_KEY --model-low example-small --model-high example-large`
          );
          process.exitCode = 1;
          return;
        }
        // A malformed or non-HTTP(S) base URL used to be saved and only failed on the first LLM call.
        let urlOk: boolean;
        try {
          const u = new URL(opts.baseUrl);
          urlOk = u.protocol === "https:" || u.protocol === "http:";
        } catch {
          urlOk = false;
        }
        if (!urlOk) {
          console.error(`"${opts.baseUrl}" is not a valid http(s) URL. Example: --base-url https://api.example.ai/v1`);
          process.exitCode = 1;
          return;
        }
        persistCustomProvider({
          baseUrl: opts.baseUrl,
          keyEnvVar: opts.keyEnv,
          modelLow: opts.modelLow,
          modelHigh: opts.modelHigh,
          label: opts.label,
        });
        console.log(`✅ Custom provider configured (${opts.baseUrl}). Store the key: purix secret set ${opts.keyEnv}`);
        return;
      }
      const known = listProviders().find((p) => p.id === id);
      if (!known) {
        console.error(`Unknown provider "${id}". Run "purix provider list" to see supported ids, or use "custom" for anything else.`);
        process.exitCode = 1;
        return;
      }
      persistProviderChoice(id);
      console.log(`✅ Active provider set to "${id}" (${known.label}). Make sure a key is stored: purix secret set ${known.keyEnvVar}`);
    });

  providerCmd
    .command("trust")
    .description("Accept the custom endpoint this project's provider-config.json names, so Purix may send your API key there")
    .action(async () => {
      const { projectCustomProvider, trustCustomProvider } = await import("@purix/core/llm/providers");
      const found = projectCustomProvider();
      if (!found) {
        console.log(`This project has no custom provider to trust. (Registered providers need nothing: "purix provider set <id>".)`);
        return;
      }
      if (found.trusted) {
        console.log(`Already accepted: ${found.baseUrl} with the key ${found.keyEnvVar}.`);
        return;
      }
      console.log(`This project's provider-config.json asks Purix to send requests to:\n    ${found.baseUrl}\nusing the API key stored as ${found.keyEnvVar}, along with the code and instructions in each request.`);
      console.log(`Only accept this if you set it up yourself or know who runs that endpoint.`);
      const { confirm } = await import("@purix/core/cli-io/confirm");
      if (!(await confirm(`Send your ${found.keyEnvVar} key to ${found.baseUrl}?`))) {
        console.log(`Not accepted. Nothing changed.`);
        process.exitCode = 1;
        return;
      }
      trustCustomProvider(found);
      console.log(`✅ Accepted. This endpoint and key name are remembered for you on this machine, in any project.`);
    });

  providerCmd
    .command("status")
    .description("Show which LLM provider is active and whether a key is configured")
    .action(async () => {
      const { listProviders, activeProviderId, activeProviderSource, getProvider, providerKeyStatus } = await import("@purix/core/llm/providers");
      let id: string;
      try {
        id = activeProviderId();
      } catch {
        console.log(`No provider configured yet. Easiest: run "purix start" in your own terminal. Or run "purix provider list" to see options, then "purix provider set <id>".`);
        return;
      }
      const known = listProviders().find((p) => p.id === id);
      console.log(`Active provider: ${id}${known ? `  (${known.label})` : ""}`);
      const chosenBy = activeProviderSource();
      if (chosenBy === "environment") console.log(`Chosen by: the PURIX_LLM_PROVIDER variable (it wins over anything saved).`);
      else if (chosenBy === "project") console.log(`Chosen by: this folder's own setting (purix provider set).`);
      else if (chosenBy === "user_default") console.log(`Chosen by: your saved default for every folder (purix start).`);
      try {
        const p = getProvider(id);
        console.log(`Model (low tier):  ${p.modelFor("low")}`);
        console.log(`Model (high tier): ${p.modelFor("high")}`);
        const key = providerKeyStatus(id);
        // The key is looked up in this order: the environment (including .env), the user-level store, then this folder's old store.
        // Said every time, so "NOT FOUND" is never a mystery and a key that came from an unexpected place is named.
        const diff = key?.conflict ? " Another place holds a DIFFERENT value that is not used (run: purix secret status)." : "";
        if (key?.source === "environment") console.log(`API key (${key.envVar}): found in the environment (used before stored keys).${diff}`);
        else if (key?.source === "stored") console.log(`API key (${key.envVar}): found in your user-level Purix store.${diff}`);
        else if (key?.source === "stored_folder") console.log(`API key (${key.envVar}): found only in an OLD per-folder key store, so it is invisible from other projects. Move it: purix secret migrate.${diff}`);
        else if (key) console.log(`API key (${key.envVar}): NOT FOUND in the environment, your user-level store, or an old per-folder store (this folder or one above it). Run: purix secret set ${key.envVar}`);
        console.log(`(Whether the provider accepts the key is only known on the first real call.)`);
      } catch (err) {
        console.log(`🛑 ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  providerCmd
    .command("list")
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
        console.log(`\n(No provider configured yet — pick one above and run "purix provider set <id>".)`);
      }
      console.log(`\nDon't see your provider? Nearly every LLM vendor exposes an OpenAI-compatible endpoint —`);
      console.log(`use "purix provider set custom --base-url <url> --key-env <name> --model-low <id> --model-high <id>".`);
    });
}