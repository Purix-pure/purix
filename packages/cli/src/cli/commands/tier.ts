// packages/cli/src/cli/commands/tier.ts
//
// CLI surface for tier/entitlements. `tier-set` (a locally-editable
// offline license key) is retired as of Part 3/4 — the whole point of
// the new backend is replacing that spoofable local flag with a
// server-verified one. Becoming Pro now happens via `purix login`
// (cli/commands/auth.ts) against whatever the billing/licenses system
// says server-side, not by handing this CLI a key it can only check the
// *format* of. `tier-status` stays, and now does a live refresh rather
// than only reading whatever's cached.
import type { Command } from "commander";
import { getEntitlements, refreshEntitlements } from "@purix/core/licensing/tier";

export function registerTierCommands(program: Command) {
  program
    .command("tier-status")
    .description("Show current tier and what it unlocks (refreshes from the server if logged in)")
    .action(async () => {
      try {
        await refreshEntitlements();
      } catch (err) {
        // A real rejection (e.g. an expired/invalid session) still falls
        // through to printing whatever's cached below, rather than
        // aborting the whole command — tier-status should always show
        // *something*, even a stale answer with a warning.
        console.warn(`  (couldn't refresh from the server: ${err instanceof Error ? err.message : err})`);
      }
      const ent = getEntitlements();
      console.log(`Tier: ${ent.tier}`);
      console.log(`  Tracked components:     ${ent.componentLimit === null ? "unlimited" : ent.componentLimit}`);
      console.log(`  Audit export:           ${ent.auditExport ? "✅" : "❌"}`);
      console.log(`  Webhooks:               ${ent.webhooks ? "✅" : "❌"}`);
      if (ent.tier === "free") {
        console.log(`\nRun "purix login" to upgrade.`);
      }
    });
}
