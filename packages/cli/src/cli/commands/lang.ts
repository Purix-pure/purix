// packages/cli/src/cli/commands/lang.ts
import type { Command } from "commander";
import { getLanguageProvider, getLanguagePack } from "@purix/core/language/registry";
import { requireLanguage, getEntitlements } from "@purix/core/licensing/tier";
import { confirm } from "@purix/core/cli-io/confirm";
import { runConformanceSuite } from "@purix/core/language/conformance/run";

export function registerLangCommands(program: Command) {
  const langCmd = program.command("lang").description("Manage language packs and verification tooling");

  langCmd
    .command("list")
    .description("List registered language providers and pack install status")
    .action(() => {
      const baseDir = process.cwd();
      const ent = getEntitlements(baseDir);
      const languages = ["typescript", "python", "rust", "go", "ruby"];

      console.log("Language Providers & Packs:");
      for (const langId of languages) {
        const prov = getLanguageProvider(langId);
        const pack = getLanguagePack(langId);
        if (!prov) continue;
        const entitled = ent.allowedLanguages.includes(langId);
        const installed = pack ? pack.isFullyInstalled(baseDir) : true;
        const tier = pack?.tier ?? "free";
        console.log(`  • ${langId} (min v${prov.minSupportedVersion}) — installed: ${installed} — entitled: ${entitled} — tier: ${tier}`);
      }
    });

  langCmd
    .command("status <id>")
    .description("Show detailed per-tool status and capabilities for a language pack")
    .action((id: string) => {
      const baseDir = process.cwd();
      const pack = getLanguagePack(id);
      const prov = getLanguageProvider(id);
      if (!prov) {
        console.log(`No language provider found for "${id}".`);
        return;
      }
      console.log(`Language Provider & Pack: ${id} (min version ${prov.minSupportedVersion})`);
      if (pack) {
        console.log(`Fully installed: ${pack.isFullyInstalled(baseDir)}`);
        console.log("Capabilities:");
        for (const [cap, active] of Object.entries(pack.capabilities)) {
          console.log(`  - ${cap}: ${active ? "✓" : "✗"}`);
        }
        console.log("Tools:");
        for (const tool of pack.tools) {
          const inst = tool.isInstalled(baseDir);
          const path = tool.resolveBinPath(baseDir);
          console.log(`  - ${tool.name} (pinned v${tool.pinnedVersion}): installed=${inst}, path=${path}`);
        }
      } else {
        console.log(`  • Built-in language (no external tool pack required).`);
      }
    });

  langCmd
    .command("verify <id>")
    .description("Run conformance suite and gate-parity verification for a language")
    .action(async (id: string) => {
      const baseDir = process.cwd();
      console.log(`Running gate-parity conformance suite for "${id}"...`);
      const { certified, report } = await runConformanceSuite(baseDir);
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

  langCmd
    .command("install <id>")
    .description("Install tooling for a language pack in strict sequence")
    .action(async (id: string) => {
      const baseDir = process.cwd();

      const pack = getLanguagePack(id);
      if (!pack) {
        console.error(`🛑 No language pack registered for "${id}".`);
        process.exitCode = 1;
        return;
      }

      // 1. Check runtime present
      const runtimeCheck = pack.checkRuntimePresent(baseDir);
      if (!runtimeCheck.present) {
        console.error(`🛑 Runtime check failed: ${runtimeCheck.message ?? "required runtime not found"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  ✅ Runtime check passed.`);

      // 2. Tier check
      try {
        requireLanguage(id);
      } catch (err: any) {
        console.error(`🛑 Tier check failed: ${err.message}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  ✅ Tier entitlement check passed.`);

      // 3. Project validity check
      const projCheck = pack.checkProjectValid(baseDir);
      if (!projCheck.valid) {
        console.error(`🛑 Project validity check failed: ${projCheck.reason ?? "invalid project directory for language"}`);
        process.exitCode = 1;
        return;
      }
      console.log(`  ✅ Project validity check passed.`);

      if (pack.isFullyInstalled(baseDir)) {
        console.log(`✅ All tools for "${id}" pack are already fully installed.`);
        return;
      }

      console.log(`Language pack "${id}" requires the following tools (pinned versions):`);
      for (const t of pack.tools) {
        console.log(`  - ${t.name} @ ${t.pinnedVersion}`);
      }

      const proceed = await confirm(`Install these tools now?`);
      if (!proceed) {
        console.log(`Installation declined.`);
        return;
      }

      console.log(`Installing ${id} language pack tools...`);
      const results = await pack.install(baseDir);
      for (const r of results) {
        if (r.ok) {
          console.log(`  ✅ ${r.tool} installed successfully`);
        } else {
          console.error(`  ❌ ${r.tool} failed to install: ${r.error}`);
        }
      }

      // 4. Extra setup if defined
      if (pack.extraSetup) {
        console.log(`Running extra setup for ${id}...`);
        const setupRes = await pack.extraSetup(baseDir);
        if (!setupRes.ok) {
          console.error(`  ❌ Extra setup failed: ${setupRes.error}`);
          process.exitCode = 1;
          return;
        }
        console.log(`  ✅ Extra setup completed successfully.`);
      }

      if (pack.isFullyInstalled(baseDir)) {
        console.log(`✅ Language pack "${id}" successfully installed and verified.`);
      } else {
        console.error(`🛑 Language pack "${id}" installation incomplete.`);
        process.exitCode = 1;
      }
    });

  langCmd
    .command("uninstall <id>")
    .description("Uninstall tools for a language pack")
    .action(async (id: string) => {
      const baseDir = process.cwd();
      const pack = getLanguagePack(id);
      if (!pack) {
        console.error(`🛑 No language pack registered for "${id}".`);
        process.exitCode = 1;
        return;
      }

      const proceed = await confirm(`Uninstall language pack "${id}"?`);
      if (!proceed) {
        console.log(`Uninstall declined.`);
        return;
      }

      const res = await pack.uninstall(baseDir);
      if (res.ok) {
        console.log(`✅ Language pack "${id}" uninstalled successfully.`);
      } else {
        console.error(`🛑 Failed to uninstall language pack "${id}": ${res.error}`);
        process.exitCode = 1;
      }
    });
}