// packages/cli/src/cli/commands/lang.ts
import type { Command } from "commander";

export function registerLangCommands(program: Command) {
  const langCmd = program.command("lang").description("Manage language packs and verification tooling");

  langCmd
    .command("list")
    .description("List registered language providers and pack install status")
    .action(async () => {
      const { getLanguageProvider, getLanguagePack } = await import("@purix/core/language/registry");
      const { getEntitlements } = await import("@purix/core/licensing/tier");
      const { discoverLanguages } = await import("@purix/core/language/discovery");
      const baseDir = process.cwd();
      const ent = getEntitlements(baseDir);
      // Sourced from the language_registry cache (discovered from real
      // on-disk manifests, see docs/adr-drafts/language-plugin-architecture.md)
      // rather than a hand-maintained array — the ["typescript", "python"]
      // literal here used to be exactly the kind of hardcoded list that
      // drifted out of sync with what BETA_SCOPE.md actually removed
      // elsewhere (scaffold.ts still listed rust/go/ruby well after this
      // array was correctly trimmed — see the design doc §1 for the full
      // pattern this replaces). The loop below still skips anything
      // getLanguageProvider() doesn't resolve, so a manifest without a
      // matching code-side provider degrades to "not shown" rather than
      // a crash.
      // Read-only command: read the manifests directly. getCachedOrRescan() opens the SQLite store,
      // which creates .purix/manifest.db in a folder that has no Purix state. `lang refresh` (a
      // write command) still rebuilds that cache explicitly.
      const languages = discoverLanguages().map((d) => d.manifest.id);

      console.log("Language Providers & Packs:");
      for (const langId of languages) {
        const prov = getLanguageProvider(langId);
        const pack = getLanguagePack(langId);
        if (!prov) continue;
        const entitled = ent.allowedLanguages.includes(langId);
        const tier = pack?.tier ?? "free";
        console.log(`  • ${langId} (min v${prov.minSupportedVersion}) — tools: ${await toolsSummary(baseDir, langId)} — entitled: ${entitled} — tier: ${tier}`);
      }
    });

  langCmd
    .command("refresh")
    .description("Force a fresh scan for installed/removed language plugins, bypassing the cache")
    .action(async () => {
      // Explicit escape hatch from design doc §5.1: getCachedOrRescan()
      // already rescans automatically whenever the discovery hash
      // changes (i.e. whenever a language was actually installed or
      // removed), so this should rarely be needed — but it exists for
      // the same reason `pnpm verify`/`aube ci --frozen` do: a safety
      // valve for the rare case someone suspects the automatic check
      // itself missed something, rather than no way to force a recheck
      // at all.
      const { rebuildLanguageRegistryCache } = await import("@purix/core/language/registry_cache");
      const rows = rebuildLanguageRegistryCache();
      console.log(`Rescanned. ${rows.length} language(s) discovered: ${rows.map((r) => r.languageId).join(", ") || "(none)"}`);
    });

  langCmd
    .command("status <id>")
    .description("Show detailed per-tool status and capabilities for a language pack")
    .action(async (id: string) => {
      const { getLanguageProvider, getLanguagePack } = await import("@purix/core/language/registry");
      const baseDir = process.cwd();
      const pack = getLanguagePack(id);
      const prov = getLanguageProvider(id);
      if (!prov) {
        // An unknown language is a failed lookup, not a result: a script must be able to tell (standard-10 rule 6).
        console.error(`No language provider found for "${id}". Run "purix lang list" to see the available languages.`);
        process.exitCode = 1;
        return;
      }
      console.log(`Language Provider & Pack: ${id} (min version ${prov.minSupportedVersion})`);
      if (pack) {
        console.log("Capabilities:");
        for (const [cap, active] of Object.entries(pack.capabilities)) {
          console.log(`  - ${cap}: ${active ? "✓" : "✗"}`);
        }
      } else {
        console.log(`  • Built-in language (no separate language pack).`);
      }
      // Tools are the tools broker's business: this is its answer for this language, not a second one.
      const broker = await import("@purix/core/tools/broker");
      const plan = broker.planForLanguages({ baseDir }, [id]);
      console.log("Tools (managed by `purix tools`):");
      for (const n of plan.needs) {
        if (!n.chosen) {
          console.log(`  - ${n.need.capability}: ${n.note ?? "nothing in the catalog"}`);
          continue;
        }
        const state = n.state === "installed" ? "installed" : n.state === "project-provided" ? "provided by your project" : `missing (purix tools install ${n.chosen.entry.id})`;
        console.log(`  - ${n.need.capability}: ${n.chosen.entry.id}@${n.chosen.entry.version} ${state}`);
      }
    });

  langCmd
    .command("verify <id>")
    .description("Run conformance suite and gate-parity verification for a language")
    .action(async (id: string) => {
      const { runConformanceSuite } = await import("@purix/core/language/conformance/run");
      const baseDir = process.cwd();
      console.log(`Running gate-parity conformance suite for "${id}"...`);
      const { createHumanGate } = await import("@purix/core/tools/consent");
      const { report } = await runConformanceSuite(baseDir, { consent: createHumanGate() });
      const langReport = report[id];
      if (!langReport) {
        console.error(`🛑 No conformance report generated for language "${id}".`);
        process.exitCode = 1;
        return;
      }
      console.log(`Language: ${id}`);
      console.log(`Certified: ${langReport.certified ? "✅ CERTIFIED" : "❌ NOT CERTIFIED"}`);
      console.log("Capabilities:");
      for (const [cap, active] of Object.entries(langReport.capabilities)) {
        console.log(`  - ${cap}: ${active ? "✓" : "✗"}`);
      }
      console.log("Fixtures:");
      for (const f of langReport.fixtures) {
        console.log(`  - ${f.name}: ${f.passed ? "✅ PASS" : `❌ FAIL (${f.error ?? "assertion/behavior mismatch"})`}`);
      }
      if (!langReport.certified) {
        process.exitCode = 1;
      }
    });

  // Tool installation moved to `purix tools` (ADR-060). These two names stay only to point people there.
  for (const name of ["install", "uninstall"] as const) {
    langCmd
      .command(`${name} <id>`, { hidden: true })
      .description("(moved) tool installation is handled by `purix tools`")
      .action((id: string) => {
        console.error(`\n🛑 \`purix lang ${name}\` no longer exists. Tools are managed in one place: \`purix tools\`.`);
        console.error(`   See what "${id}" needs: purix tools plan --for ${id}`);
        console.error(name === "install" ? "   Install one tool: purix tools install <id>" : "   Remove one tool: purix tools remove <id>");
        process.exitCode = 1;
      });
  }
}

/** One short phrase for `lang list`: are the tools this language needs available here? Read-only. */
async function toolsSummary(baseDir: string, languageId: string): Promise<string> {
  const broker = await import("@purix/core/tools/broker");
  const planned = broker.planForLanguages({ baseDir }, [languageId]).needs.filter((n) => n.chosen);
  if (planned.length === 0) return "none needed";
  const missing = planned.filter((n) => n.state === "missing").length;
  return missing === 0 ? "ready" : `${missing} of ${planned.length} missing (purix tools plan --for ${languageId})`;
}
