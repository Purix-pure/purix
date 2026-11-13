// src/state/hash.ts
import { createHash } from "node:crypto";

/**
 * Deterministic content hash for a component's full file set. Order-
 * independent (sorted by path) so the hash doesn't change just because
 * readComponentFiles happened to iterate in a different order.
 */
export function computeSyncHash(files: { path: string; content: string }[]): string {
  // The same project must hash the same on every OS: paths are hashed with "/" and text with LF. Without this, a Windows editor,
  // core.autocrlf=true (CRLF) or a backslash path was read as an edit made outside Purix (Windows test D13). Real content
  // changes still change the hash, and so does a lone CR or a byte-order mark. The lock file hashes the same way.
  const sorted = files
    .map((f) => ({ path: f.path.replace(/\\/g, "/"), content: f.content.replace(/\r\n/g, "\n") }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const f of sorted) {
    hash.update(f.path);
    hash.update("\0");
    hash.update(f.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}