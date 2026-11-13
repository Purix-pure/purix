// src/gates/manifest_delta.ts
//
// F03-02 / F03-03 first part (research 03, tasks 3.1, 3.3, 3.4). What a change did to a dependency manifest, judged against what the file held
// before it (`base`). Pure and synchronous: no network. The gate is synchronous and ADR-009 keeps the network out of its path, so this does
// not look a package up. What it does is stop the silence: a version override that was added or raised is named as NOT looked up for known
// vulnerabilities, so an unchecked addition can never read as a clean one (ADR-062). A source that bypasses the registry, an install-time
// script and a changed registry line are judged here because they are readable in the file itself.
//
// Not covered, on purpose: lockfile `resolved` hosts and integrity values (research 3.3, needs a lockfile parser per manager),
// requirements.txt and pyproject.toml, and any lookup of whether a name exists or has a known advisory (F03-03; needs the network door and a ruling).

export interface DeltaFinding {
  line: number;
  category: "Dependency Source" | "Override Added" | "Install Script" | "Registry Change";
  severity: "High" | "Medium";
  message: string;
}

// Sections whose values are version specs for packages that get installed or that redirect which version is installed.
const DEP_SECTIONS = ["dependencies", "devDependencies", "optionalDependencies", "overrides", "resolutions"] as const;
// The scripts npm, pnpm and Yarn run on their own during an install. `prepare` is left out: husky and many builds legitimately use it.
const INSTALL_HOOKS = ["preinstall", "install", "postinstall"] as const;
const MAX_NAMED = 8;

type SpecMap = Map<string, string>;

function parse(text: string | undefined): Record<string, unknown> | undefined {
  if (text === undefined) return undefined;
  try {
    const v: unknown = JSON.parse(text);
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function specs(pkg: Record<string, unknown> | undefined): SpecMap {
  const out: SpecMap = new Map();
  if (!pkg) return out;
  const take = (section: string, obj: unknown, prefix = ""): void => {
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) return;
    for (const [name, value] of Object.entries(obj as Record<string, unknown>)) {
      // A nested override (`{ "a": { "b": "1" } }`) is read one level down; its key is the path.
      if (typeof value === "string") out.set(`${section}:${prefix}${name}`, value);
      else if (section === "overrides" || section === "resolutions") take(section, value, `${prefix}${name}>`);
    }
  };
  for (const s of DEP_SECTIONS) take(s, pkg[s]);
  const pnpm = pkg["pnpm"];
  if (pnpm !== null && typeof pnpm === "object") take("overrides", (pnpm as Record<string, unknown>)["overrides"], "pnpm:");
  return out;
}

/** "git", "url" or "path" for a spec that does not come from the registry; undefined for a registry range, tag, alias or workspace link. */
export function nonRegistryKind(spec: string): "git" | "url" | "path" | undefined {
  const s = spec.trim();
  if (/^(?:git\+[a-z]+:|git:|github:|gitlab:|bitbucket:|gist:)/i.test(s)) return "git";
  // GitHub shorthand: "owner/repo" or "owner/repo#ref". A semver range never contains a slash.
  if (/^[\w.-]+\/[\w.-]+(?:#.+)?$/.test(s)) return "git";
  if (/^https?:/i.test(s)) return "url";
  if (/^(?:file|link|portal):/i.test(s)) return "path";
  return undefined;
}

function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  return at < 0 ? 1 : text.slice(0, at).split("\n").length;
}

function nameOf(key: string): string {
  const i = key.indexOf(":");
  return (i < 0 ? key : key.slice(i + 1)).replace(/^pnpm:/, "");
}

/** Findings for one package.json. `base` is the file as it was; absent for a new file or one that could not be read (then everything counts as added). */
export function manifestDeltaFindings(content: string, base: string | undefined): DeltaFinding[] {
  const now = parse(content);
  if (!now) return []; // not valid JSON: the gate already says its dependencies were not checked
  const before = parse(base);
  const out: DeltaFinding[] = [];

  const oldSpecs = specs(before);
  const newSpecs = specs(now);
  const added: string[] = [];
  for (const [key, spec] of newSpecs) {
    if (oldSpecs.get(key) === spec) continue;
    const name = nameOf(key);
    const kind = nonRegistryKind(spec);
    if (kind) {
      out.push({
        line: lineOf(content, `"${name.split(">").pop() ?? name}"`),
        category: "Dependency Source",
        severity: kind === "path" ? "Medium" : "High",
        message:
          kind === "path"
            ? `Dependency "${name}" now points at a local path (${spec}). It does not come from the registry, so no registry check applies to it.`
            : `Dependency "${name}" now comes from ${kind === "git" ? "a git repository" : "a web address"} (${spec}), not from the registry. Nothing a registry knows about it applies, and its code can change without a version change. If this is intended, override with a reason.`,
      });
      continue;
    }
    // Ordinary dependencies, devDependencies and optionalDependencies are reported as "not checked" by dependencyFindings in security_gate.ts
    // (security/dep_delta.ts), which also reads the lockfile and requirements.txt. An override or resolution redirects the version of a package
    // somewhere else in the tree and is not read there, so it is named here.
    if (key.startsWith("overrides:") || key.startsWith("resolutions:")) added.push(`${name}@${spec} (override)`);
  }
  if (added.length > 0) {
    const shown = added.slice(0, MAX_NAMED).join(", ");
    const more = added.length > MAX_NAMED ? ` and ${added.length - MAX_NAMED} more` : "";
    out.push({
      line: 1,
      category: "Override Added",
      severity: "Medium",
      message: `${added.length} version override${added.length === 1 ? " was" : "s were"} added or raised: ${shown}${more}. They were not looked up for known vulnerabilities or for whether the name exists (no lookup is made here); run \`purix audit\` or your package manager's audit after installing.`,
    });
  }

  const scripts = now["scripts"];
  const oldScripts = before?.["scripts"];
  if (scripts !== null && typeof scripts === "object" && !Array.isArray(scripts)) {
    for (const hook of INSTALL_HOOKS) {
      const cmd = (scripts as Record<string, unknown>)[hook];
      if (typeof cmd !== "string") continue;
      const was = oldScripts !== null && typeof oldScripts === "object" ? (oldScripts as Record<string, unknown>)[hook] : undefined;
      if (was === cmd) continue;
      out.push({
        line: lineOf(content, `"${hook}"`),
        category: "Install Script",
        severity: "High",
        message: `The "${hook}" script was ${typeof was === "string" ? "changed" : "added"} (${cmd.length > 80 ? `${cmd.slice(0, 80)}…` : cmd}). It runs on its own when anyone installs this package's dependencies, before anyone reads it.`,
      });
    }
  }
  return out;
}

/** Findings for one `.npmrc`: a `registry=` or `@scope:registry=` line that is new or changed. */
export function npmrcDeltaFindings(content: string, base: string | undefined): DeltaFinding[] {
  const registryLines = (text: string | undefined): Map<string, string> => {
    const m = new Map<string, string>();
    for (const raw of (text ?? "").split(/\r?\n/)) {
      const line = raw.trim();
      const hit = /^((?:@[\w.-]+:)?registry)\s*=\s*(.+)$/i.exec(line);
      if (hit && hit[1] && hit[2]) m.set(hit[1].toLowerCase(), hit[2].trim());
    }
    return m;
  };
  const before = registryLines(base);
  const out: DeltaFinding[] = [];
  for (const [key, value] of registryLines(content)) {
    if (before.get(key) === value) continue;
    out.push({
      line: lineOf(content, value),
      category: "Registry Change",
      severity: "High",
      message: `The ${key === "registry" ? "default" : key.replace(/:registry$/, "")} package registry is now ${value}. Every install would fetch from there instead.`,
    });
  }
  return out;
}
