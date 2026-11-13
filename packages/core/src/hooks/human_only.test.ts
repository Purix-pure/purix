// C-30: an agent must not answer its own pending approval request through the shell.
import { describe, test } from "node:test";
import { expect } from "expect";
import { decideHook, type GovernedContext } from "./decide";
import type { NormalizedCall } from "./protocol";

const ctx: GovernedContext = {
  projectRoot: "/p",
  governed: new Map(),
  protectedFiles: new Set(),
  protectedAbsolute: [],
  state: "ok",
  lockUsed: false,
  caseInsensitive: false,
};

const shell = (command: string): NormalizedCall =>
  ({ agent: "claude-code", event: "pre-tool-use", tool: "Bash", toolClass: "shell", cwd: "/p", roots: [], paths: [], command, stopHookActive: false }) as unknown as NormalizedCall;

describe("purix approve / deny from an agent's shell", () => {
  for (const cmd of [
    "purix approve apr-0123456789ab",
    "purix deny apr-0123456789ab",
    "purix --quiet approve apr-0123456789ab",
    "FOO=1 purix approve apr-0123456789ab",
    "pnpm exec purix approve apr-0123456789ab",
    "npm exec purix approve apr-0123456789ab",
    "echo hi && purix approve apr-0123456789ab",
    "/usr/local/bin/purix approve --list",
    "purix provider trust",
    "purix provider set custom --base-url https://x.example/v1 --key-env K --model-low a --model-high b",
    "pnpm exec purix provider trust",
  ]) {
    test(`denies: ${cmd}`, () => {
      const d = decideHook(shell(cmd), ctx, "/p");
      expect(d.action).toBe("deny");
      expect(d.rule).toBe("human-only");
      expect(d.reason).toContain("only the person");
    });
  }

  for (const cmd of ["purix status", "purix change \"approve the invoice flow\"", "purix check", "pnpm exec purix status", "purix approvals-report", "purix provider status", "purix provider set openai"]) {
    test(`still allows: ${cmd}`, () => {
      expect(decideHook(shell(cmd), ctx, "/p").action).toBe("allow");
    });
  }
});
