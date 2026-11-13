// packages/core/src/language/extension_table.ts
//
// PURIX-21 D12 (language contract): "which language does this file belong to" is answered from the
// language manifests (field `fileExtensions`, falling back to `scaffoldExtensions`), not from a table
// that names languages inside registry.ts or scaffold.ts. Adding a language means adding a manifest.
//
// Rules, all fail-closed:
//   - an extension no manifest claims is unclaimed (callers report it, never default it);
//   - an extension two manifests claim is ambiguous and also unclaimed, because picking one would let
//     the wrong toolchain judge the file (ADR-017, false-pass defect);
//   - a manifest that failed to parse is not discovered, so it claims nothing.
import { discoverLanguages, type DiscoveredLanguage } from "./discovery.js";

export interface ExtensionTable {
  /** extension (lower-case, leading dot) to the one language id that claims it */
  claimed: Map<string, string>;
  /** extension to the ids that both claim it; these resolve to nothing */
  ambiguous: Map<string, string[]>;
}

export function buildExtensionTable(discovered: DiscoveredLanguage[]): ExtensionTable {
  const owners = new Map<string, Set<string>>();
  for (const d of discovered) {
    const exts = d.manifest.fileExtensions ?? d.manifest.scaffoldExtensions;
    for (const raw of exts) {
      const ext = raw.toLowerCase();
      const set = owners.get(ext) ?? new Set<string>();
      set.add(d.manifest.id);
      owners.set(ext, set);
    }
  }
  const claimed = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();
  for (const [ext, ids] of owners) {
    if (ids.size === 1) claimed.set(ext, [...ids][0]!);
    else ambiguous.set(ext, [...ids].sort());
  }
  return { claimed, ambiguous };
}

/** The extension of a path, lower-case with its dot, or undefined when the file name has none. */
export function extensionOf(path: string): string | undefined {
  const slash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const name = path.slice(slash + 1);
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return undefined; // no dot, or a dotfile such as ".gitignore"
  return name.slice(dot).toLowerCase();
}

export function languageForExtensionTable(path: string, table: ExtensionTable): string | undefined {
  const ext = extensionOf(path);
  return ext === undefined ? undefined : table.claimed.get(ext);
}

let cached: ExtensionTable | undefined;

/** The table for the manifests shipped with Purix, built once per process. */
export function defaultExtensionTable(): ExtensionTable {
  cached ??= buildExtensionTable(discoverLanguages());
  return cached;
}

/** Test hook: forget the cached table. */
export function resetExtensionTableCache(): void {
  cached = undefined;
}
