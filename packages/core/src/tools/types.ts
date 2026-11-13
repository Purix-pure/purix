// packages/core/src/tools/types.ts
//
// ADR-060: the vocabulary of the tools broker. Types only — no behaviour, no I/O.
//
// NEUTRALITY (ADR-060 D5, PURIX-14 decision 7): nothing in these types, in the catalog entry,
// or in the resolver input may carry a commercial relationship with a tool's vendor. Ranking
// inputs are exactly: does the project already use it, is it already installed, the catalog's
// own static priority, and the id. A test (resolver.test.ts) scans this file and resolver.ts to
// keep it that way.

export type ToolGroup = "language" | "testing" | "coding" | "maintenance";

/** What a caller needs done. Callers ask for a capability, never for a tool name. */
export type Capability = "type-check" | "run-tests" | "lint" | "dep-audit";

export type Platform = "linux" | "darwin" | "win32";

export type InstallMethod = "pip-venv" | "npm-ci";

export interface CatalogEntry {
  id: string;
  displayName: string;
  description: string;
  group: ToolGroup;
  capabilities: Capability[];
  /** Language ids as used by language packs: "python", "typescript". */
  languages: string[];
  platforms: Platform[];
  method: InstallMethod;
  /** Registry package name (PyPI or npm). */
  package: string;
  /** Exact version. Never a range. */
  version: string;
  /** Executable name inside the tool's own folder (no extension). */
  bin: string;
  license: string;
  /** ISO timestamp of the registry release of `version` (earliest file for PyPI). */
  releasedAt: string;
  /** Static catalog order within equal footing; lower is earlier. */
  priority: number;
  /**
   * The exact files written next to the install: pip -> requirements.txt (universal, fully hashed);
   * npm -> package.json + package-lock.json (sha512 integrity).
   */
  files: Record<string, string>;
  /** sha256 over `files` (see hashLockFiles in catalog.ts). */
  lockSha256: string;
}

export interface ToolNeed {
  capability: Capability;
  language: string;
}

export interface ProjectSignals {
  /** Catalog ids the project itself already declares (package.json, pyproject, requirements). */
  declaredIds: ReadonlySet<string>;
  /** Catalog ids whose binary already exists inside the project (npm only: node_modules/.bin). */
  projectBinaryIds: ReadonlySet<string>;
}

export interface Candidate {
  entry: CatalogEntry;
  /** Why this candidate is where it is, in the order the ranking applied them. */
  reasons: string[];
  usedByProject: boolean;
  installedByPurix: boolean;
}

export type NeedState = "installed" | "project-provided" | "missing" | "no-candidate";

export interface PlannedNeed {
  need: ToolNeed;
  state: NeedState;
  chosen: Candidate | null;
  candidates: Candidate[];
  note?: string;
}

export interface PlanResult {
  needs: PlannedNeed[];
}

export interface LockRecord {
  id: string;
  package: string;
  version: string;
  method: InstallMethod;
  lockSha256: string;
  installedAt: string;
  /** Path relative to the tool's folder, forward slashes. */
  binRelPath: string;
}

export interface LockFile {
  version: 1;
  records: LockRecord[];
}

export interface PendingRequest {
  id: string;
  toolId: string;
  requestedAt: string;
  origin: "agent" | "cli";
  /** Untrusted free text from the requester, length-capped, control characters removed. */
  reason: string;
  status: "pending";
}

export type RefusalReason =
  | "unknown-tool"
  | "unsupported-platform"
  | "too-new"
  | "lock-hash-mismatch"
  | "lock-invalid"
  | "runtime-missing"
  | "command-failed"
  /** The install command ran past its time limit and was stopped. Infrastructure, not a problem with the tool or the project. */
  | "install-timeout"
  /** The install command printed more than its output cap, or the machine ran out of memory, handles or processes. Infrastructure. */
  | "install-limit"
  /** Another install (or removal) of the same tool is running. */
  | "install-in-progress"
  | "bin-missing"
  | "consent-declined"
  | "no-consent-gate"
  | "audit-unavailable"
  | "state-corrupt"
  | "unknown-request";
