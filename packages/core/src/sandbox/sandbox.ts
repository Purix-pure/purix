// src/sandbox/sandbox.ts
import { changedLineNumbers, summarizeCoverage, type ChangedLineCoverage } from "../verify/changed_line_coverage.js";
import { isJsTsFile, isTestPath } from "../verify/test_discovery.js";
import { precheckEdits } from "../verify/precheck.js";
import { recordEvent } from "../manifest/events.js";
import { storeExists } from "../manifest/store.js";
import { mkdtempSync, cpSync, mkdirSync, writeFileSync, symlinkSync, existsSync, realpathSync, statSync, readFileSync } from "node:fs";
import { safeRmSync } from "../platform/fs_retry.js";
import { dependencyGateOptions } from "../security/dep_lookup.js";
import { resolveSafePath } from "../gates/path_guard.js";
import { aliasToolState, clearToolStateAliases, unaliasToolState } from "../tools/state.js";
import { tmpdir } from "node:os";
import { join, dirname, relative, sep } from "node:path";
import { scanForSecrets } from "../security/secrets.js";
import { runSecurityGate } from "../gates/security_gate.js";
import { credentialFileReason } from "./copy_exclusions.js";
import { getLanguageProvider, resolveLanguage } from "../language/registry.js";
import type { VerificationResult } from "../verify/verify.js";
import { notTestedMessage } from "../verify/outcome.js";
import { changedFilesNotVouchedFor } from "../verify/discovery_cut.js";
import { unsupportedLanguageOfFile } from "../language/unsupported_languages.js";
import type { IdiomFinding } from "../verify/idiom.js";
import { IsolationRequiredError, SandboxUnavailableError, type IsolationLevel } from "./sandbox_exec.js";
import { PURIX_DIRNAME } from "../platform/layout.js";

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
    safeRmSync(root);
  }
  openTempRoots.clear();
  clearToolStateAliases();
}

export type SandboxVerificationResult = VerificationResult & { idiomFindings: IdiomFinding[] };

/** One place for the "a link into the verification copy failed" warning (node_modules, installed tools). */
function warnLinkFailed(what: string, err: unknown): void {
  console.warn(`[sandbox] Could not link ${what} into verification copy: ${err instanceof Error ? err.message : String(err)}`);
}

/**
 * Fills `tmpRoot` with a copy of the project to verify in: no .env or other credential file (copy_exclusions.ts), no .git, no node_modules or .purix (except .purix/tmp), with
 * node_modules and the installed-tools folder linked to the real ones. Shared by the sandbox and the dependents re-check
 * (verify/impact.ts), so both copy the same way and neither ever hands a tool the person's real project folder.
 */
export function populateVerificationCopy(targetDir: string, tmpRoot: string): string[] {
  // F01-06: credential-holding files (any depth) stay out, and are returned so a result can say what was left out.
  const excludedForSafety: string[] = [];
  cpSync(targetDir, tmpRoot, {
    recursive: true,
    filter: (src: string) => {
      const rel = relative(targetDir, src);
      if (rel === "") return true;
      const segments = rel.split(/[\\/]/);
      if (segments.includes("node_modules") || segments.includes(".git")) return false;
      // .purix holds secrets, the manifest and locks: never copied. The one exception is
      // .purix/tmp (tool caches, the test reporter). Installed tools are not copied either:
      // the copy links to the real tools folder below, so a tool's recorded paths stay valid.
      if (segments[0] === PURIX_DIRNAME) return segments.length === 1 || segments[1] === "tmp";
      if (segments.includes(PURIX_DIRNAME)) return false;
      // F01-06: credential-holding files (any depth) stay out. Checked last so a path already left out above is not listed twice.
      if (credentialFileReason(rel) !== undefined) {
        excludedForSafety.push(segments.join("/"));
        return false;
      }
      return true;
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
    } catch { /* realpath is a best-effort resolution; fall back to the original path on failure */ }
    try {
      symlinkSync(realNodeModules, join(tmpRoot, "node_modules"), "junction");
    } catch (err) {
      warnLinkFailed("node_modules", err);
    }
  }

  // Tools installed through `purix tools` live in the user's tools state (T1: never in the project), keyed by the real project.
  // The copy reads the real project's tools through an alias, so nothing is copied or linked on disk: a Python virtualenv does not
  // survive being copied, and the tools must stay the hash-checked originals. The caller removes the alias with the copy.
  aliasToolState(tmpRoot, targetDir);
  return excludedForSafety;
}

/** A fresh verification copy of the project, plus the function that removes it. */
export function makeVerificationCopy(targetDir: string): { dir: string; dispose: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "purix-verify-"));
  openTempRoots.add(dir);
  const dispose = () => {
    unaliasToolState(dir); // before the folder goes: the alias is keyed by the folder's real path
    safeRmSync(dir);
    openTempRoots.delete(dir);
  };
  try {
    populateVerificationCopy(targetDir, dir);
  } catch (err) {
    dispose();
    throw err;
  }
  return { dir, dispose };
}

/** The most of a file's old content the gate will read to tell old findings from new ones; a larger file is judged whole. */
const BASE_READ_LIMIT = 5 * 1024 * 1024;

/**
 * What `relPath` holds in the project now, for the security gate to compare against. Undefined (so the file is judged whole, the
 * stricter reading) when the file is new, unreadable, over the limit, or the path leaves the project: a file outside the project
 * must never excuse a finding.
 */
function readBaseContent(targetDir: string, relPath: string): string | undefined {
  try {
    if (!resolveSafePath(targetDir, relPath).ok) return undefined;
    const abs = join(targetDir, relPath);
    // A link inside the project that points outside is followed to where it really lands: that file must not excuse a finding either.
    const root = realpathSync(targetDir);
    const real = realpathSync(abs);
    if (!real.startsWith(root.endsWith(sep) ? root : root + sep)) return undefined;
    const st = statSync(real);
    if (!st.isFile() || st.size > BASE_READ_LIMIT) return undefined;
    return readFileSync(real, "utf-8");
  } catch {
    return undefined; // new file or unreadable: nothing to compare with, so nothing is forgiven
  }
}

/** F06-04: the changed executable-source lines of one language group, in the form `runTests` takes. Undefined when the group holds no source file. */
function coverageRequest(
  changes: { path: string; new_content: string }[],
  relPaths: string[],
  targetDir: string
): { changed: Record<string, number[]>; newText: Record<string, string> } | undefined {
  const changed: Record<string, number[]> = {};
  const newText: Record<string, string> = {};
  for (const c of changes) {
    if (!relPaths.includes(c.path) || !isJsTsFile(c.path) || isTestPath(c.path)) continue;
    changed[c.path] = changedLineNumbers(readBaseContent(targetDir, c.path), c.new_content);
    newText[c.path] = c.new_content;
  }
  return Object.keys(changed).length > 0 ? { changed, newText } : undefined;
}

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
  languageOverride?: string,
  /** Files the change deletes. They are removed from the verification copy, so an import of one that is left behind fails here and not after the change lands. */
  removePaths: string[] = [],
  /**
   * F06-02 regression fix: set by a caller whose candidate IS the code already on disk (accepting drift), so there is no unmodified code
   * to compare a failing test with. The project folder already holds the same failure, and a baseline built from it would forgive a test
   * that fails there too. Without a baseline the older rule applies (a failure blocks unless a re-run passes).
   */
  options: { candidateOnDisk?: boolean } = {}
): SandboxVerificationResult {
  const secretFindings = scanForSecrets(changes.map((c) => ({ path: c.path, content: c.new_content })));
  if (secretFindings.length > 0) {
    return {
      status: "fail",
      reason:
        `Secrets/entropy scan blocked this patch:\n` +
        secretFindings.map((f) => `  ${f.path}:${f.line} — ${f.reason} (${f.match})`).join("\n"),
      policyBlock: true,
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
  // F03-05: the gate also gets what each file held before, so an old finding does not block an unrelated edit.
  // F03-03 / F03-02 (D-q): when PURIX_DEP_LOOKUP is set, the caller has already filled the lookup cache (prefetchDependencyLookup, awaited in
  // resolveVerification); `dependencyGateOptions()` is empty when the lookup is off, so nothing changes by default.
  const securityGateResult = runSecurityGate(changes.map((c) => ({ path: c.path, content: c.new_content, base: readBaseContent(targetDir, c.path) })), undefined, dependencyGateOptions());

  if (!securityGateResult.ok) {
    return {
      status: "fail",
      reason: securityGateResult.reason ?? "Security gate blocked this patch.",
      policyBlock: true,
      idiomFindings: [],
    };
  }

  // AI-07: the cheapest check first. An edit that no longer parses is refused here, after the policy blocks above (which keep
  // precedence) and before any temporary directory or copy exists. Compiler and tests stay below, in the sandbox.
  const syntax = precheckEdits(changes, targetDir);
  if (syntax) {
    if (storeExists()) recordEvent("precheck_block", { component_id: componentId, detail: { errorClass: syntax.errorClass, files: syntax.files.slice(0, 10) } });
    return { status: "fail", reason: syntax.reason, errorClass: syntax.errorClass, idiomFindings: [] };
  }

  const tmpRoot = mkdtempSync(join(tmpdir(), "purix-verify-"));
  openTempRoots.add(tmpRoot);
  try {
    const excludedForSafety = populateVerificationCopy(targetDir, tmpRoot);
    // F01-06: a failure may be only that a credential-looking file the test needs was left out. Say which files were, in the reason.
    const excludedNote = excludedForSafety.length > 0
      ? `\nNote: ${excludedForSafety.length} credential-looking file(s) were left out of the verification copy for safety: ${excludedForSafety.slice(0, 10).join(", ")}${excludedForSafety.length > 10 ? ", ..." : ""}. If this failure is a missing file, that is why.`
      : "";
    const withExcluded = <R extends { status: string }>(r: R): R =>
      excludedForSafety.length > 0 ? { ...r, excludedForSafety } : r;

    for (const gone of removePaths) {
      const safe = resolveSafePath(tmpRoot, gone);
      if (!safe.ok) return { status: "fail", reason: `${gone}: ${safe.reason}`, policyBlock: true, idiomFindings: [] };
      safeRmSync(join(tmpRoot, gone));
    }

    for (const change of changes) {
      const dest = join(tmpRoot, change.path);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, change.new_content, "utf-8");
    }

    // Group files by language
    const filesByLang = new Map<string, { path: string; absPath: string }[]>();

    // A10a-1: a source file in a language no provider covers is set aside here. It must not reach resolveLanguage(), whose last
    // answer is a silent "typescript": a Go file would get a TypeScript error, and a file the compiler ignores would read as clean.
    // A caller that names the language itself (languageOverride) has already decided; that path is unchanged.
    const unchecked: { path: string; language: string }[] = [];
    for (const change of changes) {
      let lang: string;
      const unsupported = languageOverride ? undefined : unsupportedLanguageOfFile(change.path);
      if (unsupported) {
        unchecked.push({ path: change.path, language: unsupported });
        continue;
      }
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
            reason: `could not determine the language for ${change.path}: ${err instanceof Error ? err.message : String(err)} — refusing to guess "typescript"; set an explicit language in ${PURIX_DIRNAME}/config.json`,
            idiomFindings: [],
          };
        }
      }
      const list = filesByLang.get(lang) || [];
      list.push({ path: change.path, absPath: join(tmpRoot, change.path) });
      filesByLang.set(lang, list);
    }

    if (unchecked.length > 0 && filesByLang.size === 0) {
      const names = [...new Set(unchecked.map((u) => u.language))].join(", ");
      return {
        status: "fail",
        reason: `Unsupported language, not checked: ${names} (${unchecked.map((u) => u.path).join(", ")}). Purix has no checker for ${names}, so nothing was compiled or tested.`,
        infrastructure: "unsupported_language",
        idiomFindings: [],
      };
    }

    const allIdiomFindings: IdiomFinding[] = [];
    const notTested: string[] = [];
    let testSearchCut = false;
    const testSearchCutFiles: string[] = [];
    // F06-04: one coverage part per language group; summarised into the result. Information only.
    const coverageParts: { coverage?: ChangedLineCoverage; notMeasured?: string; files: string[] }[] = [];
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

    try {
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
        return withExcluded({ ...verifyRes, reason: verifyRes.reason + excludedNote, idiomFindings: [] });
      }
      noteIsolation(verifyRes.isolation);

      // F06-02: a failing test is judged against the project as it is now (the unmodified code), copied only if a test fails.
      // Not offered when the candidate is already what is on disk: that copy would hold the same failure (see `options`).
      // F06-04: ask for line coverage of the changed source lines (not test files). A runner with no producer says so in the result.
      const coverageAsk = coverageRequest(changes, relPaths, targetDir);
      const testRes = provider.runTests(componentId, relPaths, tmpRoot, {
        ...(options.candidateOnDisk ? {} : { baseline: () => makeVerificationCopy(targetDir) }),
        ...(coverageAsk ? { coverage: coverageAsk } : {}),
      });
      if (coverageAsk && testRes.status === "pass") {
        coverageParts.push({ coverage: testRes.changedLineCoverage, notMeasured: testRes.coverageNotMeasured, files: Object.keys(coverageAsk.changed) });
      }
      if (testRes.status === "not_installed") {
        return {
          status: "not_installed",
          reason: testRes.reason ?? `tooling not installed for ${langId}`,
          actionHint: testRes.actionHint,
          idiomFindings: [],
        };
      }
      if (testRes.status === "fail") {
        return withExcluded({ status: "fail", reason: (testRes.reason ?? "tests failed") + excludedNote, idiomFindings: [], ...(testRes.infrastructure ? { infrastructure: testRes.infrastructure } : {}) });
      }
      noteIsolation(testRes.isolation);
      if (testRes.discovery) notTested.push(...testRes.discovery.uncovered);
      // F06-05: a search for tests that hit its file limit cannot vouch for any changed file, so they read as partial, not clean.
      notTested.push(...changedFilesNotVouchedFor(testRes.discovery, relPaths));
      if (testRes.discovery?.truncated) { testSearchCut = true; testSearchCutFiles.push(...changedFilesNotVouchedFor(testRes.discovery, relPaths)); }

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
    } catch (err) {
      // A4-1: a sandbox that cannot be used (strict isolation with no sandbox tool, or bwrap that cannot start) used to escape this
      // function as an exception. It is the machine that cannot run the check, not the code: an infrastructure result, never repaired.
      if (err instanceof IsolationRequiredError || err instanceof SandboxUnavailableError) {
        return { status: "fail", reason: err.message, infrastructure: "sandbox_unavailable", idiomFindings: [] };
      }
      throw err;
    }

    // No language groups processed (e.g. an empty change set) means
    // nothing was actually run through any isolation layer — default to
    // the weakest claim ("none") rather than implying a guarantee that
    // never happened.
    if (notTested.length > 0) {
      console.log(`  ⚠ ${notTestedMessage(notTested, { searchCut: testSearchCut, cutFiles: testSearchCutFiles })}`);
    }
    const notChecked = [...new Set(unchecked.map((u) => u.path))];
    const coverageSummary = summarizeCoverage(coverageParts);
    return {
      status: "pass",
      idiomFindings: allIdiomFindings,
      isolation: overallIsolation ?? "none",
      ...(notTested.length > 0 ? { notTested: [...new Set(notTested)] } : {}),
      ...(testSearchCut ? { testSearchCut: true } : {}),
      ...(testSearchCut && testSearchCutFiles.length > 0 ? { testSearchCutFiles: [...new Set(testSearchCutFiles)] } : {}),
      ...(notChecked.length > 0 ? { notChecked } : {}),
      ...(excludedForSafety.length > 0 ? { excludedForSafety } : {}),
      ...(securityGateResult.advisories.length > 0 ? { securityAdvisories: securityGateResult.advisories.map((f) => ({ path: f.path, line: f.line, category: f.category, message: f.message })) } : {}),
      ...(securityGateResult.notRead.length > 0 ? { securityNotRead: securityGateResult.notRead } : {}),
      ...(coverageSummary ? { changedCoverage: coverageSummary } : {}),
    };
  } finally {
    unaliasToolState(tmpRoot);
    safeRmSync(tmpRoot);
    openTempRoots.delete(tmpRoot);
  }
}