// packages/cli/src/cli/commands/telemetry.ts
//
// `purix telemetry` (Purix 4, section 6): status, enable, disable, show,
// reset, forget. Usage data is OFF by default. The local ledger always
// records (closed schema, no free text); nothing leaves the machine unless
// the user enables telemetry AND an upload endpoint exists. Upload is not
// shipped in this version, and these messages say so plainly.
import type { Command } from "commander";

const NOT_SHIPPED = "Upload is not available in this version, so nothing is sent either way.";

export function registerTelemetryCommands(program: Command) {
  const cmd = program.command("telemetry").description("Control anonymous usage data (off by default)");

  cmd
    .command("status")
    .description("Show whether usage data may be shared, and why")
    .action(async () => {
      const { readTelemetry, effectiveConsent } = await import("@purix/core/usage/consent");
      const { readLedger } = await import("@purix/core/usage/ledger");
      const t = readTelemetry();
      const eff = effectiveConsent(t.state);
      const why: Record<string, string> = {
        enabled: "enabled",
        not_enabled: "off (you have not enabled it)",
        do_not_track: "off (DO_NOT_TRACK is set)",
        ci: "off (running in CI)",
      };
      console.log(`Telemetry:           ${t.state === "on" ? "on" : "off"}`);
      console.log(`Sharing right now:   ${why[eff.reason]}`);
      console.log(`Crash diagnostics:   ${t.crashDiagnostics ? "on" : "off"}`);
      console.log(`Install id:          ${t.installId} (random; not linked to your email or account)`);
      console.log(`Local ledger rows:   ${readLedger().length}`);
      console.log(NOT_SHIPPED);
    });

  cmd
    .command("enable")
    .description("Allow sharing anonymous usage aggregates")
    .action(async () => {
      const { setConsent } = await import("@purix/core/usage/consent");
      setConsent("on");
      console.log("Telemetry enabled. Run `purix telemetry show` to see exactly what would be shared.");
      console.log(NOT_SHIPPED);
    });

  cmd
    .command("disable")
    .description("Stop sharing usage data")
    .action(async () => {
      const { setConsent } = await import("@purix/core/usage/consent");
      setConsent("off");
      console.log("Telemetry disabled. Local usage counts are still kept on this machine for `purix stats`.");
    });

  cmd
    .command("show")
    .description("Print the exact payload that would be shared next")
    .action(async () => {
      const { buildNextPayload } = await import("@purix/core/usage/ledger");
      console.log(JSON.stringify(buildNextPayload(), null, 2));
    });

  cmd
    .command("reset")
    .description("Make a new random install id")
    .action(async () => {
      const { resetInstallId } = await import("@purix/core/usage/consent");
      console.log(`New install id: ${resetInstallId().installId}`);
    });

  cmd
    .command("forget")
    .description("Disable telemetry and delete the local usage ledger")
    .action(async () => {
      const { setConsent, resetInstallId } = await import("@purix/core/usage/consent");
      const { eraseLedger } = await import("@purix/core/usage/ledger");
      setConsent("off");
      eraseLedger();
      resetInstallId();
      console.log("Telemetry disabled, local usage ledger deleted, install id replaced.");
      console.log("Nothing has been uploaded by this version, so there is no server copy to erase.");
    });
}
