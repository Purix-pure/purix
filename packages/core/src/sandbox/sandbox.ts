// src/sandbox/sandbox.ts
import { mkdtempSync, rmSync, cpSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, relative } from "node:path";
import { scanForSecrets } from "../security/secrets.js";
import { runSecurityGate } from "../gates/security_gate.js";
import { getLanguageProvider, resolveLanguage } from "../language/registry.js";
import type { VerificationResult } from "../verify/verify.js";
import type { IdiomFinding } from "../verify/idiom.js";
import type { IsolationLevel } from "./sandbox_exec.js";

const openTempRoots = new Set<string>();

// LIFECYCLE FIX: this module used to register its own SIGINT/SIGTERM
// listeners (via registerSandboxInterruptHandlers(), called unconditionally
// at module load) that called process.exit() directly. cli.ts *also*
// registers SIGINT/SIGTERM listeners (to release the repo lock). Node
// invokes multiple listeners for the same signal synchronously, in
// registration order, but does NOT wait for an async listener to finish
// before calling the next one — so cli.ts's async handler (which awaits a
// dynamic import before calling releaseRepoLock()) would still be paused at
// its first `await` when this module's synchronous handler ran and called
// process.exit(), killing the process before releaseRepoLock() ever ran.
// Net effect: Ctrl+C during `purix modify`/`purix ingest` (both of which
// import this module) silently skipped repo-lock release.
//
// Fix: this module no longer touches process.on() at all. It exposes a
// plain, synchronous cleanup function; the single owner of SIGINT/SIGTERM
// handling (cli.ts) calls it as one step in one handler, in a guaranteed
// order, with no async gap for process.exit() to race against.
export function cleanupSandboxTempRoots(): void {
  for (const root of openTempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
  openTempRoots.clear();
}

export type SandboxVerificationResult = VerificationResult & { idiomFindings: IdiomFinding[] };

export function verifyInSandbox(
  componentId: string,
  changes: { path: string; new_content: string }[],
  targetDir: string = process.cwd(),
  // For callers whose componentId is synthetic and cannot resolve against a
  // real manifest entry (e.g. the codebase indexer's `comp-N` IDs) —
  // resolveLanguage()'s manifest-lookup step is structurally unable to
  // succeed for such an ID and silently falls through to whole-repository
  // marker-file auto-detection, verifying the file against whatever
  // language the repo as a whole happens to be, not the file's actual
  // language. Passing the already-known language here skips that fallback
  // entirely instead of letting dispatch quietly go wrong.
  languageOverride?: string
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

  // BUG FIX (GAPS-REPORT §2.2): runSecurityGate() — SQL/command injection,
  // weak crypto, unsafe deserialization, and dependency typosquatting
  // checks — had zero production callers anywhere in the codebase, while
  // its own bypass (setSecurityOverride(), armed from the CLI's
  // `--override` flag) was live and reachable. An active bypass for a
  // check that never runs is worse than neither existing. verifyInSandbox
  // is the one real choke point every write path (CLI, MCP server,
  // indexer, escalation, self-healing, migration, drift, reconciliation)
  // already routes through for the secrets scan above — wiring the gate
  // in here, rather than at each call site individually, is what actually
  // makes it a genuine, blocking check instead of a second inert layer.
  const securityGateResult = runSecurityGate(changes.map((c) => ({ path: c.path, content: c.new_content })));
  if (!securityGateResult.ok) {
    return {
      status: "fail",
      reason: securityGateResult.reason ?? "Security gate blocked this patch.",
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
      let lang: string;
      if (languageOverride) {
        lang = languageOverride;
      } else if (change.path.endsWith(".py")) {
        lang = "python";
      } else {
        try {
          lang = resolveLanguage(componentId, tmpRoot);
        } catch (err) {
          // resolveLanguage() throws specifically when it finds multiple
          // language markers with no explicit declaration — deliberately,
          // to force a real decision instead of guessing. Silently
          // defaulting to "typescript" here was the one behavior it exists
          // to prevent, and made this the one caller that undid it. Fail
          // closed instead: surface the ambiguity to the caller rather
          // than verify an ambiguous file against the wrong language's
          // tooling and report a false pass or a misleading failure.
          return {
            status: "fail",
            reason: `could not determine the language for ${change.path}: ${err instanceof Error ? err.message : String(err)} — refusing to guess "typescript"; set an explicit language in .purix/config.json`,
            idiomFindings: [],
          };
        }
      }
      const list = filesByLang.get(lang) || [];
      list.push({ path: change.path, absPath: join(tmpRoot, change.path) });
      filesByLang.set(lang, list);
    }

    const allIdiomFindings: IdiomFinding[] = [];
    // BUG FIX (GAPS-REPORT §2.3): verify() and runTests() each compute a
    // real isolation level (sandbox_exec.ts's runIsolated()) and it was
    // discarded at every one of these call sites — a "pass" reported
    // identically whether the check ran fully sandboxed or, on a machine
    // with neither bwrap nor sandbox-exec available, completely
    // unisolated. "none" always wins this aggregation: one unisolated
    // step (verifyComponent's tsc invocation never runs through
    // runIsolated() at all — see verify.ts) is enough to make the whole
    // result "none", because a caller trusting this "pass" needs to know
    // about the weakest link, not the best one.
    let overallIsolation: IsolationLevel | undefined;
    const noteIsolation = (level: IsolationLevel | undefined) => {
      if (!level) return;
      if (level === "none") {
        overallIsolation = "none";
      } else if (overallIsolation === undefined) {
        overallIsolation = level;
      }
    };

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
      noteIsolation(verifyRes.isolation);

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
      noteIsolation(testRes.isolation);

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

    // No language groups processed (e.g. an empty change set) means
    // nothing was actually run through any isolation layer — default to
    // the weakest claim ("none") rather than implying a guarantee that
    // never happened.
    return { status: "pass", idiomFindings: allIdiomFindings, isolation: overallIsolation ?? "none" };
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
    openTempRoots.delete(tmpRoot);
  }
}