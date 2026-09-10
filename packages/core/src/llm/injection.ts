// src/llm/injection.ts
// §9.3's shared, fast, local injection-heuristic pass. One definition,
// imported by both the escalation path (dependency-context scanning)
// and diff-classify (external diff content) — a second, independent
// copy of this marker list is exactly the kind of drift that leaves
// one call site catching a phrase the other one doesn't.

export const INJECTION_MARKERS: RegExp[] = [
  /ignore (all |any )?(previous|prior|above) instructions/i,
  /disregard (all |any )?(previous|prior|above)/i,
  /you are now/i,
  /new system prompt/i,
  /act as (an? )?(unrestricted|jailbroken)/i,
  /\bsystem\s*:\s*/i,
];

/** Heuristic, not a guarantee — same honest tradeoff secrets.ts makes. Fails toward "ask a human," not toward silently trusting the content. */
export function scanForInjectionAttempts(text: string): string[] {
  const hits: string[] = [];
  for (const re of INJECTION_MARKERS) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
}