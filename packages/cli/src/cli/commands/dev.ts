// packages/cli/src/cli/commands/dev.ts
import { Command } from "commander";
import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, join } from "node:path";

export function registerDevCommands(program: Command): void {
  const dev = program.command("dev").description("Internal development tools");

  dev
    .command("scaffold-language")
    .argument("<id>", "language id")
    .option("--bin <name>", "toolchain binary name")
    .option("--ext <pattern>", "file extension pattern")
    .option("--manifest <filename>", "manifest filename")
    .action((id: string, options: any) => {
      const baseDir = process.cwd();
      const providersDir = resolve(baseDir, "packages/core/src/language/providers");
      const fixturesDir = resolve(baseDir, "packages/core/src/language/conformance/fixtures", id);
      
      if (!existsSync(providersDir)) {
          console.error("Providers directory not found");
          return;
      }
      
      // Generate Provider
      const providerTemplate = `// Generated for ${id}
import type { LanguageProvider } from "../provider";
import { runIsolatedOrNotInstalled, resolveToolchainCache, parseLockfileFingerprint } from "../provider-kit";

export const ${id}Provider: LanguageProvider = {
  id: "${id}",
  minSupportedVersion: "0.1.0",
  detect(baseDir: string = process.cwd()): boolean { return false; },
  verify(filePaths: string[], baseDir: string = process.cwd()) { throw new Error("Not implemented for ${id}"); },
  runTests(componentId: string, testFiles: string[], baseDir: string = process.cwd()) { throw new Error("Not implemented for ${id}"); },
  checkIdiom(filePaths: string[], baseDir: string = process.cwd()) { throw new Error("Not implemented for ${id}"); },
  async auditDependencies(baseDir: string = process.cwd()) { throw new Error("Not implemented for ${id}"); },
  async getFingerprint(baseDir: string = process.cwd()) { return {}; }
};
`;
      writeFileSync(join(providersDir, `${id}.ts`), providerTemplate);
      
      // Generate Pack
      const packTemplate = `// Generated for ${id}
import type { LanguagePack } from "../pack";
export const ${id}Pack: LanguagePack = {
  languageId: "${id}",
  minSupportedVersion: "0.1.0",
  isFullyInstalled(baseDir: string = process.cwd()) { return false; }
};
`;
      writeFileSync(join(providersDir, `${id}.pack.ts`), packTemplate);
      
      // Generate Fixtures
      mkdirSync(fixturesDir, { recursive: true });
      writeFileSync(join(fixturesDir, "readme.md"), `Fixtures for ${id}`);

      console.log(`Generated scaffolding for ${id}`);
      console.log(`Manual steps remaining:`);
      console.log(`1. Register ${id}Provider and ${id}Pack in registry.ts`);
      console.log(`2. Implement all methods in ${id}.ts`);
      console.log(`3. Populate fixtures in ${fixturesDir}`);
    });
}
