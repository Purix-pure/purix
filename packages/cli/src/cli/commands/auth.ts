// packages/cli/src/cli/commands/auth.ts
//
// Part 4: `purix login` / `purix logout`. No browser dependency — prompts
// for email then a 6-digit code, both over stdin/stdout, so this works
// over SSH exactly like the rest of the CLI.
import type { Command } from "commander";

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
  // Shared reader (core/cli-io/confirm.ts): resolves null at EOF instead of hanging (F6).
  const { promptLine } = await import("@purix/core/cli-io/confirm");
  return ((await promptLine(question)) ?? "").trim();
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

      if (!process.stdin.isTTY) {
        console.error("`purix login` asks for your email and a code, so it needs a terminal. Run it in an interactive shell.");
        process.exitCode = 1;
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
        console.error(`Couldn't send a login code: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      console.log(`A 6-digit code was sent to ${email}.`);
      const code = await prompt("Code: ");

      let login: { token: string; refreshToken?: string; expiresAt?: string; refreshExpiresAt?: string; sessionId?: string };
      try {
        // The same machine id the savings sync uses, so the dashboard's device list and savings list line up.
        const { hostname } = await import("node:os");
        login = await runtime.apiClient.verifyCode(email, code, { deviceId: runtime.getMachineId(), deviceName: hostname() });
      } catch (err) {
        console.error(`Login failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
        return;
      }

      runtime.saveSession(login.token, email, login);
      console.log(`✅ Logged in as ${email}.`);

      // Savings sync: event-ID endpoint first, legacy window-total call if the
      // server does not have it yet (see core/security/savings_sync_run.ts).
      // A failure here never fails the login; it is retried after later commands.
      const { runSavingsSync } = await import("@purix/core/security/savings_sync_run");
      const syncResult = await runSavingsSync();
      if (syncResult.status === "failed") {
        console.warn(`  (savings sync didn't complete — will retry on a future run: ${syncResult.reason})`);
      }

      try {
        const refreshed = await runtime.refreshEntitlements();
        if (refreshed.reason) console.warn(`  (${refreshed.reason})`);
      } catch (err) {
        if (!(err instanceof runtime.ApiUnreachableError)) {
          console.warn(`  (couldn't fetch entitlements yet: ${err instanceof Error ? err.message : String(err)})`);
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
          console.warn(`  (server logout didn't complete: ${err instanceof Error ? err.message : String(err)})`);
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
