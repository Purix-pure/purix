// packages/cli/src/cli/greenfield_preflight.ts
//
// IDEA-090. Everything `create` (and `change`, when nothing matches) must know BEFORE it spends a model call or
// writes a file, in the order a new user trips over it:
//
//   1. a provider and its key are configured          (otherwise "Planning..." printed, then a failure)
//   2. the project has a language                      (resolveLanguage() used to answer "typescript" for an
//                                                       empty folder, a default nobody chose)
//   3. the type checker for that language is present   (the check used to run after the plan was approved and the
//                                                       files were written, then rolled everything back)
//   4. the planned files can actually be checked       (checkPlanPrerequisites, run after planning and before
//                                                       the approval prompt)
//
// Nothing here calls a model or writes project files. The one write is the language choice, saved to this
// project's config so the next command does not ask again. Installing a tool goes through the tools broker, which
// asks the person itself (ADR-060): this module never installs anything on its own.
import { existsSync, readFileSync } from "node:fs";
import { builtinModules } from "node:module";
import { dirname, join } from "node:path";

export interface PreflightIO {
  /** A person is at the keyboard and can answer. False in CI, pipes and agent-run commands. */
  interactive: boolean;
  /** One line typed by the person, or null when there is no input. */
  ask(question: string): Promise<string | null>;
  log(line: string): void;
}

export interface MissingTool {
  id: string;
  version: string;
}

/** Everything that touches core, behind one seam so tests can run without a terminal, a key or a network. */
export interface PreflightDeps {
  /** ok:false carries the sentence to show. Never reads the key out, never calls the provider. */
  providerStatus(): { ok: true } | { ok: false; message: string };
  configuredLanguage(baseDir: string): string | undefined;
  detectLanguages(baseDir: string): string[];
  /** Languages this build can verify, and whether the current tier may use each. */
  languages(): { id: string; allowed: boolean }[];
  saveLanguage(baseDir: string, id: string): void;
  /** Type-checker tools the language needs that neither the project nor Purix provides yet. */
  missingTypeCheckers(baseDir: string, language: string): MissingTool[];
  /** Goes through the broker's human consent gate. */
  installTool(baseDir: string, id: string): Promise<{ ok: true } | { ok: false; message: string; hint?: string }>;
}

export type PreflightResult = { ok: true; language: string } | { ok: false; message: string };

const NOTHING_HAPPENED = "Nothing was sent to the model and nothing was written.";

const LABELS: Record<string, string> = { typescript: "TypeScript", python: "Python" };
export function languageLabel(id: string): string {
  return LABELS[id] ?? id;
}

export async function runGreenfieldPreflight(baseDir: string, io: PreflightIO, deps: PreflightDeps): Promise<PreflightResult> {
  // 1. Provider and key.
  const provider = deps.providerStatus();
  if (!provider.ok) return { ok: false, message: `${provider.message}\n${NOTHING_HAPPENED}` };

  // 2. Language.
  const chosen = await decideLanguage(baseDir, io, deps);
  if (!chosen.ok) return chosen;
  const language = chosen.language;

  // 3. Type checker for that language.
  const missing = deps.missingTypeCheckers(baseDir, language);
  if (missing.length > 0) {
    io.log(`Purix needs a type checker to verify ${languageLabel(language)} code, and this project has none yet:`);
    for (const m of missing) io.log(`  ${m.id} ${m.version} (not installed)`);
    if (!io.interactive) {
      return {
        ok: false,
        message:
          `${NOTHING_HAPPENED}\nInstall it first (it asks before it installs anything):\n` +
          missing.map((m) => `  purix tools install ${m.id}`).join("\n"),
      };
    }
    for (const m of missing) {
      const installed = await deps.installTool(baseDir, m.id);
      if (!installed.ok) {
        return {
          ok: false,
          message: `${installed.message}${installed.hint ? `\n${installed.hint}` : ""}\n${NOTHING_HAPPENED}\nYou can install it yourself: purix tools install ${m.id}`,
        };
      }
      io.log(`Installed ${m.id} ${m.version} into your Purix tools folder (not into the project).`);
    }
  }

  return { ok: true, language };
}

async function decideLanguage(baseDir: string, io: PreflightIO, deps: PreflightDeps): Promise<PreflightResult> {
  const configured = deps.configuredLanguage(baseDir);
  if (configured) return { ok: true, language: configured };

  const found = deps.detectLanguages(baseDir);
  const known = deps.languages();
  if (found.length === 1) {
    io.log(`Using ${languageLabel(found[0]!)} (this folder already has ${languageLabel(found[0]!)} project files).`);
    return { ok: true, language: found[0]! };
  }

  // None found, or more than one: Purix does not guess.
  const options = found.length > 1 ? known.filter((k) => found.includes(k.id)) : known;
  const why = found.length > 1 ? `This folder has files for more than one language (${found.map(languageLabel).join(", ")}).` : "This folder has no project files yet, so there is no language to follow.";
  const setHint = options.map((o) => `purix config set language ${o.id}`).join("   or   ");
  if (!io.interactive) {
    return { ok: false, message: `${why}\n${NOTHING_HAPPENED}\nSay which language to use, then run the same command again:\n  ${setHint}` };
  }

  io.log(why);
  io.log("Which language should this project use?");
  options.forEach((o, i) => io.log(`  ${i + 1}. ${languageLabel(o.id)}${o.allowed ? "" : " (not available on this install)"}`));
  const answer = await io.ask(`Choose 1-${options.length} (Enter to cancel): `);
  const picked = answer === null ? NaN : Number.parseInt(answer.trim(), 10);
  const option = Number.isInteger(picked) ? options[picked - 1] : undefined;
  if (!option) {
    return { ok: false, message: `No language chosen. ${NOTHING_HAPPENED}\nTo skip this question: ${setHint}` };
  }
  if (!option.allowed) {
    return { ok: false, message: `${languageLabel(option.id)} is not available on this install. ${NOTHING_HAPPENED}` };
  }
  deps.saveLanguage(baseDir, option.id);
  io.log(`Saved: language = ${option.id} (change it any time with: purix config set language <id>)`);
  return { ok: true, language: option.id };
}

// ---------------------------------------------------------------------------------------------------------
// After planning: can the planned files be checked at all?

export interface PlanFile {
  path: string;
  starter_content: string;
}

const NODE_BUILTINS = new Set(builtinModules.filter((m) => !m.startsWith("_") && !m.includes("/")));
const NODE_SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
const NODE_GLOBALS = /\b(?:process\.(?:env|argv|cwd|exit|platform|stdout|stderr|stdin)|Buffer\.|__dirname|__filename)\b/;
const TS_FILE = /\.(?:[cm]?ts|tsx)$/i;

/** First planned TypeScript file that uses a Node built-in or global, with what gave it away; null when none does. */
export function findNodeUsage(files: readonly PlanFile[]): { path: string; evidence: string } | null {
  for (const f of files) {
    if (!TS_FILE.test(f.path)) continue;
    for (const m of f.starter_content.matchAll(NODE_SPECIFIER)) {
      const spec = m[1]!;
      if (spec.startsWith("node:")) return { path: f.path, evidence: `imports "${spec}"` };
      if (NODE_BUILTINS.has(spec)) return { path: f.path, evidence: `imports "${spec}"` };
    }
    const g = NODE_GLOBALS.exec(f.starter_content);
    if (g) return { path: f.path, evidence: `uses ${g[0]}` };
  }
  return null;
}

/**
 * True when `@types/node` is resolvable from `baseDir`, here or in any parent folder (a monorepo root counts).
 * `ceiling` stops the climb at that folder (inclusive). Tests pass their own temp folder so that a node_modules in a
 * parent of the temp folder (common on a developer machine) cannot change the answer.
 */
export function nodeTypesInstalled(baseDir: string, ceiling?: string): boolean {
  let dir = baseDir;
  for (;;) {
    if (existsSync(join(dir, "node_modules", "@types", "node", "package.json"))) return true;
    if (ceiling !== undefined && dir === ceiling) return false;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

function packageManagerAddCommand(baseDir: string): string {
  if (existsSync(join(baseDir, "pnpm-lock.yaml"))) return "pnpm add --save-dev @types/node";
  if (existsSync(join(baseDir, "yarn.lock"))) return "yarn add --dev @types/node";
  if (existsSync(join(baseDir, "bun.lock")) || existsSync(join(baseDir, "bun.lockb"))) return "bun add --dev @types/node";
  return "npm install --save-dev @types/node";
}

function hasPackageJson(baseDir: string): boolean {
  const p = join(baseDir, "package.json");
  if (!existsSync(p)) return false;
  try {
    JSON.parse(readFileSync(p, "utf-8"));
    return true;
  } catch {
    return true; // a package.json exists, even if damaged; do not tell someone to overwrite it
  }
}

/**
 * Stops a plan that cannot be verified here BEFORE the approval prompt, so nobody approves files that would be
 * written and then rolled back. Only TypeScript, and only the one case measured on a real empty folder: starter
 * files that import node:test, node:assert, fs and the like fail to compile without @types/node.
 */
export function checkPlanPrerequisites(language: string, files: readonly PlanFile[], baseDir: string, ceiling?: string): { ok: true } | { ok: false; message: string } {
  if (language !== "typescript") return { ok: true };
  const usage = findNodeUsage(files);
  if (!usage || nodeTypesInstalled(baseDir, ceiling)) return { ok: true };
  const steps = [...(hasPackageJson(baseDir) ? [] : ["npm init -y"]), packageManagerAddCommand(baseDir)];
  return {
    ok: false,
    message:
      `${usage.path} ${usage.evidence}, but @types/node is not installed in this project, so TypeScript cannot check it. ` +
      `If you approved this plan, the files would be written and then rolled back.\n` +
      `Nothing was written. Install the Node type definitions once, then run the same command again:\n` +
      steps.map((s) => `  ${s}`).join("\n"),
  };
}

// ---------------------------------------------------------------------------------------------------------
// The real wiring. Loaded lazily by the commands; tests pass their own PreflightDeps instead.

export async function defaultPreflightDeps(): Promise<PreflightDeps> {
  const [registry, providers, tier, config, broker, consent] = await Promise.all([
    import("@purix/core/language/registry"),
    import("@purix/core/llm/providers"),
    import("@purix/core/licensing/tier"),
    import("@purix/core/state/config"),
    import("@purix/core/tools/broker"),
    import("@purix/core/tools/consent"),
  ]);

  return {
    providerStatus() {
      try {
        const status = providers.providerKeyStatus();
        if (!status) return { ok: false, message: 'The configured provider is incomplete. Run "purix provider status" to see what is missing.' };
        if (status.source === "missing") {
          return {
            ok: false,
            message: `No API key found for your provider (looked for ${status.envVar}). Set it in your environment, or store it: purix secret set ${status.envVar} <key>`,
          };
        }
        return { ok: true };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    },
    configuredLanguage: (baseDir) => registry.configuredLanguage(baseDir),
    detectLanguages: (baseDir) => registry.detectLanguages(baseDir),
    languages() {
      const allowed = new Set(tier.getEntitlements().allowedLanguages);
      return registry.listLanguageIds().map((id) => ({ id, allowed: allowed.has(id) }));
    },
    saveLanguage: (baseDir, id) => config.createConfigStore(baseDir).set("language", id),
    missingTypeCheckers(baseDir, language) {
      const plan = broker.planForLanguages({ baseDir }, [language]);
      return plan.needs
        .filter((n) => n.need.capability === "type-check" && n.chosen && n.state === "missing")
        .map((n) => ({ id: n.chosen!.entry.id, version: n.chosen!.entry.version }));
    },
    async installTool(baseDir, id) {
      const result = await broker.installTool({ baseDir, consent: consent.createHumanGate() }, id);
      return result.ok ? { ok: true } : { ok: false, message: result.message, ...(result.hint ? { hint: result.hint } : {}) };
    },
  };
}
