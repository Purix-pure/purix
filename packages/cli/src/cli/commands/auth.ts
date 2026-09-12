// packages/cli/src/cli/commands/auth.ts
//
// Part 4: `purix login` / `purix logout`. No browser dependency — prompts
// for email then a 6-digit code, both over stdin/stdout, so this works
// over SSH exactly like the rest of the CLI.
import type { Command } from "commander";
import * as readline from "node:readline/promises";

async function loadAuthRuntime() {
  const [apiClientModule, sessionModule, licensingModule, projectIdModule, machineIdModule, budgetModule] = await Promise.all([
    import("@purix/core/security/api_client"),
    import("@purix/core/security/session"),
    import("@purix/core/licensing/tier"),
    import("@purix/core/state/project_id"),
    import("@purix/core/state/machine_id"),
    import("@purix/core/llm/budget"),
  ]);

  return {
    apiClient: apiClientModule.apiClient,
    ApiUnreachableError: apiClientModule.ApiUnreachableError,
    saveSession: sessionModule.saveSession,
    clearSession: sessionModule.clearSession,
    loadSession: sessionModule.loadSession,
    refreshEntitlements: licensingModule.refreshEntitlements,
    clearEntitlementsCache: licensingModule.clearEntitlementsCache,
    getProjectId: projectIdModule.getProjectId,
    getMachineId: machineIdModule.getMachineId,
    getSavingsSummary: budgetModule.getSavingsSummary,
  };
}

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

export function registerAuthCommands(program: Command) {
  program
    .command("login")
    .description("Log in to sync savings history and unlock your web dashboard")
    .action(async () => {
      const runtime = await loadAuthRuntime();
      const existing = runtime.loadSession();
      if (existing) {
        console.log(`Already logged in as ${existing.email}. Run "purix logout" first to switch accounts.`);
        return;
      }

      const email = await prompt("Email: ");
      if (!email.includes("@")) {
        console.error("That doesn't look like an email address.");
        process.exitCode = 1;
        return;
      }

      try {
        await runtime.apiClient.requestCode(email);
      } catch (err) {
        // Part 3: "if email delivery fails, return a real error to the
        // CLI, never a silent 'check your email'" — surfaced verbatim
        // here, not swallowed into a generic message.
        console.error(`Couldn't send a login code: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return;
      }

      console.log(`A 6-digit code was sent to ${email}.`);
      const code = await prompt("Code: ");

      let token: string;
      try {
        const result = await runtime.apiClient.verifyCode(email, code);
        token = result.token;
      } catch (err) {
        console.error(`Login failed: ${err instanceof Error ? err.message : err}`);
        process.exitCode = 1;
        return;
      }

      runtime.saveSession(token, email);
      console.log(`✅ Logged in as ${email}.`);

      // Part 4: "On first successful login, call /sync/savings with the
      // full local ledger history across every project this machine has
      // data for." Honest limitation, not silently glossed over: nothing
      // in this codebase maintains a registry of every project directory
      // Purix has ever been run in — each project's .purix/ is
      // independent and unaware of siblings — so "every project" isn't
      // achievable from a single `purix login` invocation without adding
      // that registry. What this DOES do is sync the current project
      // (the one login was run from); the architecture doc's "periodic /
      // per-run" sync trigger picks up every other project incrementally
      // as the user works in them, so the end state converges to "every
      // project synced" over time rather than instantly at login.
      try {
        const summary = runtime.getSavingsSummary(3650); // ~10 years — effectively "all time" for this project
        if (summary.callCount > 0) {
          await runtime.apiClient.syncSavings([
            {
              projectId: runtime.getProjectId(),
              machineId: runtime.getMachineId(),
              windowStart: new Date(0).toISOString(),
              totalSavingsUsd: summary.totalSavingsUsd,
              callCount: summary.callCount,
            },
          ]);
        }
      } catch (err) {
        // Part 3: "a network blip mid-purix login shouldn't fail the
        // login itself, log and retry the sync on next invocation
        // instead of blocking session issuance on it." Login has already
        // succeeded above; this failure is logged, not fatal.
        console.warn(`  (savings sync didn't complete — will retry on a future run: ${err instanceof Error ? err.message : err})`);
      }

      try {
        await runtime.refreshEntitlements();
      } catch (err) {
        if (!(err instanceof runtime.ApiUnreachableError)) {
          console.warn(`  (couldn't fetch entitlements yet: ${err instanceof Error ? err.message : err})`);
        }
      }
    });

  program
    .command("logout")
    .description("Log out and clear the local session")
    .action(async () => {
      const runtime = await loadAuthRuntime();
      if (!runtime.loadSession()) {
        console.log("Not logged in.");
        return;
      }

      try {
        await runtime.apiClient.logout();
      } catch (err) {
        // Best-effort server-side invalidation — local logout must
        // succeed even offline, or a user with no connectivity could
        // never log out of a machine.
        if (!(err instanceof runtime.ApiUnreachableError)) {
          console.warn(`  (server logout didn't complete: ${err instanceof Error ? err.message : err})`);
        }
      }

      runtime.clearSession();
      // This must happen immediately, not on the next TTL expiry — see
      // the design note in tier.ts / the offline-grace interaction this
      // exists to close: without it, logging out, then losing
      // connectivity, then running a Pro-gated command would read the
      // stale cached tier under the 72-hour grace window and let a
      // logged-out session through as Pro for up to three days.
      runtime.clearEntitlementsCache();
      console.log("✅ Logged out.");
    });
}
