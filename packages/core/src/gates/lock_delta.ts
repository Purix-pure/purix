// src/gates/lock_delta.ts
//
// F03-02 remainder (research 03, task 3.3): what a change did to a lockfile, judged against what the file held before (`base`).
// Pure and synchronous, no network. This is the 2019 lockfile-injection pattern: one entry's source moved to an attacker's host, which
// reviewers miss because lockfile diffs are collapsed and unread. Only entries the change ADDED or CHANGED are judged.
//
//   High  "Lockfile Source"    a changed or new entry that does not come from a registry by name: a git, ssh, URL or file source.
//   High  "Lockfile Host"      a changed or new entry fetched from a host no entry of the old lockfile used. One finding per host, so a
//                              legitimate move to a company registry is ONE finding naming the host, not hundreds. Needs an old file
//                              with at least one host to compare against; a brand-new lockfile has nothing to compare with and is
//                              judged by the "Lockfile Source" rule only.
//   High  "Lockfile Integrity" the SAME name and version with a different integrity value, or with the value removed. A registry
//                              version's bytes do not change, so this is the strongest sign of tampering. A version change legitimately
//                              changes the value and is not judged here.
//
// Not covered: the yarn.lock and pnpm-lock.yaml readers were written from format knowledge and hand-made fixtures, not run on real files
// from each tool; a file they cannot read gives "Lockfile Unreadable" (Medium), never silence. A lockfile that only bumps versions on
// the registry already in use is reported by the dependency check (added or raised pairs), not here.
import { parseLockEntries, isLockfile, type LockEntry } from "../security/lock_parsers.js";

export interface LockFinding {
  line: number;
  category: "Lockfile Source" | "Lockfile Host" | "Lockfile Integrity" | "Lockfile Unreadable";
  severity: "High" | "Medium";
  message: string;
}

const MAX_NAMED = 5;
const label = (e: LockEntry): string => `${e.name}@${e.version}`;
const named = (list: LockEntry[]): string => {
  const shown = list.slice(0, MAX_NAMED).map(label).join(", ");
  return list.length > MAX_NAMED ? `${shown} and ${list.length - MAX_NAMED} more` : shown;
};

/** The host of a fetch location, or undefined when it has none (a path, a registry-style resolution string). */
export function hostOf(resolved: string | undefined): string | undefined {
  if (!resolved) return undefined;
  const m = /^(?:[a-z][a-z0-9+.-]*:\/\/)(?:[^@/]*@)?([^/:?#]+)/i.exec(resolved.replace(/^git\+/i, ""));
  return m?.[1]?.toLowerCase();
}

function entriesChanged(before: Map<string, LockEntry>, after: Map<string, LockEntry>): LockEntry[] {
  const out: LockEntry[] = [];
  for (const [key, e] of after) {
    const old = before.get(key);
    if (!old || old.version !== e.version || old.resolved !== e.resolved || old.integrity !== e.integrity) out.push(e);
  }
  return out;
}

export function lockDeltaFindings(path: string, content: string, base: string | undefined): LockFinding[] {
  if (!isLockfile(path)) return [];
  const after = parseLockEntries(path, content);
  if (after === undefined) {
    return [{ line: 1, category: "Lockfile Unreadable", severity: "Medium", message: `${path} could not be read in a format this check knows, so what the change did to its sources and integrity values was not checked.` }];
  }
  const before = base === undefined ? undefined : parseLockEntries(path, base);
  const findings: LockFinding[] = [];
  const changed = before ? entriesChanged(before, after) : [...after.values()];

  const offRegistry = changed.filter((e) => e.nonRegistry === true);
  if (offRegistry.length > 0) {
    findings.push({
      line: 1, category: "Lockfile Source", severity: "High",
      message: `This change adds or changes ${offRegistry.length} lockfile entr${offRegistry.length === 1 ? "y" : "ies"} that did not come from a registry by name (git, URL, file or a private index): ${named(offRegistry)}. A lockfile edit like this redirects what gets installed and is easy to miss in review.`,
    });
  }

  if (before && before.size > 0) {
    const knownHosts = new Set<string>();
    for (const e of before.values()) {
      const h = hostOf(e.resolved);
      if (h) knownHosts.add(h);
    }
    if (knownHosts.size > 0) {
      const byHost = new Map<string, LockEntry[]>();
      for (const e of changed) {
        if (e.nonRegistry) continue; // already reported above
        const h = hostOf(e.resolved);
        if (h && !knownHosts.has(h)) byHost.set(h, [...(byHost.get(h) ?? []), e]);
      }
      for (const [host, list] of byHost) {
        findings.push({
          line: 1, category: "Lockfile Host", severity: "High",
          message: `This change fetches ${list.length} package${list.length === 1 ? "" : "s"} from ${host}, a host no entry in the old lockfile used: ${named(list)}. If you moved to another registry on purpose, override this finding with a reason; if not, someone redirected the install.`,
        });
      }
    }

    const tampered: LockEntry[] = [];
    for (const e of after.values()) {
      const old = before.get(e.key);
      if (old && old.version === e.version && old.integrity !== undefined && old.integrity !== e.integrity) tampered.push(e);
    }
    if (tampered.length > 0) {
      findings.push({
        line: 1, category: "Lockfile Integrity", severity: "High",
        message: `This change alters the integrity value of ${tampered.length} package${tampered.length === 1 ? "" : "s"} whose version did not change, or removes it: ${named(tampered)}. A registry version's contents do not change, so this can mean the package was swapped.`,
      });
    }
  }
  return findings;
}
