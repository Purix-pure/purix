// src/sandbox/copy_exclusions.ts
//
// F01-06: which files stay out of the verification copy because they hold credentials.
//
// The copy is what generated code and its tests run against, so a credential in it is readable by that code. Before this, only a
// `.env` at the project root was left out. This is the name list from research 01, section 5.2 (option B), applied at any depth.
// A name list is incomplete by nature: it narrows the exposure, it does not close it. The strict-isolation sandbox stays the
// boundary. Every path left out is returned to the caller so a test that fails for a missing file can be traced (see sandbox.ts).

/** A credential-holding file name (matched on the last path segment, case-insensitive). */
const FILE_NAME_RULES: { test: (name: string) => boolean; why: string }[] = [
  { test: (n) => n === ".env" || n.startsWith(".env."), why: "environment file" },
  { test: (n) => n === ".npmrc" || n === ".pypirc" || n === ".netrc", why: "package-registry or network credentials" },
  { test: (n) => /\.(pem|key|p12|pfx)$/.test(n), why: "private key or certificate bundle" },
  { test: (n) => /^id_(rsa|dsa|ecdsa|ed25519)/.test(n), why: "SSH private key" },
  { test: (n) => n.endsWith(".tfvars"), why: "Terraform variables (often secrets)" },
  { test: (n) => /^credentials.*\.json$/.test(n), why: "credentials file" },
];

/** A directory whose whole contents are credentials. */
const DIRECTORY_NAMES = new Set([".aws", ".ssh"]);

/**
 * Why `relPath` (relative to the project root) must not be copied, or undefined when it may be. Separators of either kind are read.
 * A directory path (for example `.ssh`) is answered too, so the copy can skip the whole folder without walking it.
 */
export function credentialFileReason(relPath: string): string | undefined {
  const segments = relPath.split(/[\\/]/).filter((s) => s !== "").map((s) => s.toLowerCase());
  if (segments.length === 0) return undefined;
  for (const s of segments) {
    if (DIRECTORY_NAMES.has(s)) return `${s} folder holds credentials`;
  }
  const name = segments[segments.length - 1]!;
  const parent = segments[segments.length - 2];
  if (parent === ".docker" && name === "config.json") return "Docker registry credentials";
  for (const rule of FILE_NAME_RULES) {
    if (rule.test(name)) return rule.why;
  }
  return undefined;
}
