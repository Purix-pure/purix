// src/sandbox/sandbox_env.ts

const SENSITIVE_KEY_RE = /API_KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL/i;

/**
 * Narrows one specific slice of Section 24's open sandbox-isolation
 * question: a subprocess executing code from a sandboxed copy (escalation
 * output, a drifted file, a dependency) shouldn't inherit anything that
 * looks like a credential from the parent process's environment. This is
 * NOT network-namespace isolation or filesystem containment — those are
 * still open. It only closes "test code reads process.env and leaks a
 * real key."
 */
// Runtime migration (ADR-009) fallout, caught by actually running the
// sandboxed test-run path end to end rather than trusting it compiled:
// when verify/tests.ts's own sandbox subprocess is itself a `node --test`
// invocation (running a component's own test suite via node:test + tsx —
// see tests.ts's header), and Purix's OWN test suite is what's driving
// that call (as it is here, and as it will be for anyone running `pnpm
// test` on this repo), the outer test runner sets NODE_TEST_CONTEXT on
// itself. Inheriting that into the child silently makes Node's test
// runner think it's a duplicate recursive run of the SAME test process
// and skip execution entirely — exit 0, no output, no error surfaced —
// which reads to everything upstream as "all tests passed" when nothing
// ran at all. Stripped here rather than special-cased in tests.ts, since
// any other test-runner subprocess this sandbox ever shells out to would
// hit the identical problem.
const RUNNER_CONTEXT_KEYS = new Set(["NODE_TEST_CONTEXT"]);

export function sandboxEnv(): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SENSITIVE_KEY_RE.test(key)) continue;
    if (RUNNER_CONTEXT_KEYS.has(key)) continue;
    safe[key] = value;
  }
  return safe;
}