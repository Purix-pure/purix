// src/state/hash.ts
import { createHash } from "node:crypto";

/**
 * Deterministic content hash for a component's full file set. Order-
 * independent (sorted by path) so the hash doesn't change just because
 * readComponentFiles happened to iterate in a different order.
 */
export function computeSyncHash(files: { path: string; content: string }[]): string {
  const sorted = [...files].sort((a, b) => a.path.localeCompare(b.path));
  const hash = createHash("sha256");
  for (const f of sorted) {
    hash.update(f.path);
    hash.update("\0");
    hash.update(f.content);
    hash.update("\0");
  }
  return hash.digest("hex");
}