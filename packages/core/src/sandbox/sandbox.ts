// src/sandbox/sandbox.ts
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { scanForSecrets } from "../security/secrets.js";
import { getLanguageProvider, resolveLanguage } from "../language/registry.js";
import type { VerificationResult } from "../verify/verify.js";
import type { IdiomFinding } from "../verify/idiom.js";

const openTempRoots = new Set<string>();
let interruptHandlersRegistered = false;

function registerSandboxInterruptHandlers(): void {
  if (interruptHandlersRegistered) return;
  interruptHandlersRegistered = true;

  const SIGNAL_EXIT_CODES: { SIGINT: number; SIGTERM: number } = { SIGINT: 130, SIGTERM: 143 };

  const cleanupAndExit = (signal: "SIGINT" | "SIGTERM") => {
    for (const root of openTempRoots) {
      rmSync(root, { recursive: true, force: true });
    }
    openTempRoots.clear();
    process.exit(SIGNAL_EXIT_CODES[signal]);
  };

  process.on("SIGINT", () => cleanupAndExit("SIGINT"));
  process.on("SIGTERM", () => cleanupAndExit("SIGTERM"));
}

registerSandboxInterruptHandlers();

export type SandboxVerificationResult = VerificationResult & { idiomFindings: IdiomFinding[] };

export function verifyInSandbox(
  componentId: string,
  changes: { path: string; new_content: string }[],
  targetDir: string = process.cwd()
): SandboxVerificationResult {
  const secretFindings = scanForSecrets(changes.map((c) => ({ path: c.path, content: c.new_content })));
  if (secretFindings.length > 0) {
    return {
      status: "fail",
      reason:
        `Secrets/entropy scan blocked this patch:\n` +
        secretFindings.map((f) => `  ${f.path}:${f.line} — ${f.reason} (${f.match})`).join("\n"),
      idiomFindings: [],
    };
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "purix-verify-"));
  openTempRoots.add(tmpRoot);
  try {
    cpSync(targetDir, tmpRoot, {
      recursive: true,
      filter: (src: string) => {
        const rel = relative(targetDir, src);
        if (rel === ".env" || rel.startsWith(".env.")) return false;
        if (rel === "") return true;
        const segments = rel.split(/[\\/]/);
        return !segments.includes("node_modules") && !segments.includes(".git") && !segments.includes(".purix");
      },
    });

    // targetDir/node_modules is frequently itself a symlink — always true
    // for pnpm-managed packages, and also true whenever targetDir is a
    // synthetic/test directory that set up its own node_modules symlink
    // before calling in here (as every test in this file's own test suite
    // does). realpathSync resolves through any such chain so tmpRoot's own
    // symlink points directly at the ultimate physical directory. Without
    // this, tmpRoot/node_modules -> targetDir/node_modules -> real dir is
    // two hops, and the caller (tests.ts) can only see and bind the first
    // hop's target — the second hop resolves to a path never bound into
    // the sandbox at all, breaking module resolution inside bwrap.
    let realNodeModules = join(targetDir, "node_modules");
    if (existsSync(realNodeModules)) {
      try {
        realNodeModules = realpathSync(realNodeModules);
      } catch {}
      try {
        symlinkSync(realNodeModules, join(tmpRoot, "node_modules"), "junction");
      } catch (err) {
        console.warn(`[sandbox] Could not link node_modules into verification copy: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    for (const change of changes) {
      const dest = join(tmpRoot, change.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, change.new_content, "utf-8");
    }

    // Group files by language
    const filesByLang = new Map<string, { path: string; absPath: string }[]>();

    for (const change of changes) {
      let lang = "typescript";
      if (change.path.endsWith(".py")) {
        lang = "python";
      } else {
        try {
          lang = resolveLanguage(componentId, tmpRoot);
        } catch {
          lang = "typescript";
        }
      }
      const list = filesByLang.get(lang) || [];
      list.push({ path: change.path, absPath: join(tmpRoot, change.path) });
      filesByLang.set(lang, list);
    }

    const allIdiomFindings: IdiomFinding[] = [];

    for (const [langId, fileEntries] of filesByLang.entries()) {
      const provider = getLanguageProvider(langId);
      if (!provider) {
        return {
          status: "fail",
          reason: `no verification provider registered for language ${langId} — refusing to silently pass`,
          idiomFindings: [],
        };
      }

      const paths = fileEntries.map((e) => e.absPath);
      const relPaths = fileEntries.map((e) => e.path);

      const verifyRes = provider.verify(paths, tmpRoot);
      if (verifyRes.status === "not_installed") {
        return {
          status: "not_installed",
          reason: verifyRes.reason,
          actionHint: verifyRes.actionHint,
          idiomFindings: [],
        };
      }
      if (verifyRes.status === "fail") {
        return { ...verifyRes, idiomFindings: [] };
      }

      const testRes = provider.runTests(componentId, relPaths, tmpRoot);
      if (testRes.status === "not_installed") {
        return {
          status: "not_installed",
          reason: testRes.reason ?? `tooling not installed for ${langId}`,
          actionHint: testRes.actionHint,
          idiomFindings: [],
        };
      }
      if (testRes.status === "fail") {
        return { status: "fail", reason: testRes.reason ?? "tests failed", idiomFindings: [] };
      }

      const idiomRes = provider.checkIdiom(paths, tmpRoot);
      if (idiomRes.status === "not_installed") {
        return {
          status: "not_installed",
          reason: idiomRes.reason ?? `tooling not installed for ${langId}`,
          actionHint: idiomRes.actionHint,
          idiomFindings: [],
        };
      }
      if (idiomRes.findings) {
        allIdiomFindings.push(...idiomRes.findings);
      }
    }

    return { status: "pass", idiomFindings: allIdiomFindings };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    openTempRoots.delete(tmpRoot);
  }
}