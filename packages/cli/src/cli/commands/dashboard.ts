// src/cli/commands/dashboard.ts
//
// `purix dashboard`: a read-only page of everything Purix did, across every project on this machine. It binds 127.0.0.1 on a random
// port, prints an address that carries a one-time token, and stops when the terminal closes. It never writes to any record.
import type { Command } from "commander";

export function registerDashboardCommand(program: Command) {
  program
    .command("dashboard")
    .description("Open a local, read-only page of what Purix did across your projects (127.0.0.1 only, nothing leaves this machine)")
    .option("--port <n>", "port to listen on (default: a random free one)")
    .option("--no-open", "print the address without opening a browser")
    .action(async (opts: { port?: string; open: boolean }) => {
      const { EXIT } = await import("@purix/core/cli-io/exit_codes");
      let port: number | undefined;
      if (opts.port !== undefined) {
        port = Number(opts.port);
        if (!Number.isInteger(port) || port < 1 || port > 65535) { console.error("Bad input: --port must be a whole number from 1 to 65535."); process.exitCode = EXIT.USAGE; return; }
      }
      const { listProjects, touchProject } = await import("@purix/core/observe/registry");
      const { openLedger } = await import("@purix/core/observe/ledger_reader");
      const { listApprovals } = await import("@purix/core/approvals/pending");
      const { verifyAuditRows } = await import("@purix/core/security/audit_tamper_evidence");
      const { readGitReverts } = await import("@purix/core/state/rework");
      const { storeExists } = await import("@purix/core/manifest/store");
      const { readTelemetry, effectiveConsent } = await import("@purix/core/usage/consent");
      const { buildNextPayload } = await import("@purix/core/usage/ledger");
      const { projectId, startDashboard } = await import("../dashboard/server.js");
      const { PURIX_VERSION } = await import("../../version.js");
      const { createCheckStateProvider, spawnCheckRunner, resolveCliEntry } = await import("../dashboard/check_state.js");
      const cli = resolveCliEntry();
      const checks = createCheckStateProvider({ run: spawnCheckRunner(cli.entry, 20_000, cli.execArgv) });
      if (storeExists()) touchProject({ agent: "cli" });
      const source: import("../dashboard/pages.js").DashboardSource = {
        now: () => new Date(),
        version: PURIX_VERSION,
        projects: () => listProjects().map((p) => ({ id: projectId(p.path), name: p.name, path: p.path, stateDir: p.stateDir, firstSeen: p.firstSeen, lastSeen: p.lastSeen, agents: p.agents })),
        openLedger: (p) => openLedger(p.stateDir),
        checkState: (p) => checks.get(p.path),
        pending: (p) => { try { return listApprovals(p.path).filter((r) => r.state === "pending").map((r) => ({ id: r.id, tool: r.tool })); } catch { return []; } },
        reverts: (p, sinceIso) => { const r = readGitReverts(p.path, sinceIso); return r.state === "ok" ? { state: "ok", count: r.reverts.length, commitsRead: r.commitsRead } : r; },
        verifyChain: (c) => verifyAuditRows(c.rows, c.checkpoint),
        telemetry: () => {
          const t = readTelemetry();
          const eff = effectiveConsent(t.state);
          const why: Record<string, string> = { enabled: "enabled", not_enabled: "off (you have not enabled it)", do_not_track: "off (DO_NOT_TRACK is set)", ci: "off (running in CI)" };
          return { state: t.state === "on" ? "on" : "off", sharingNow: why[eff.reason] ?? eff.reason, payload: buildNextPayload() };
        },
      };
      const running = await startDashboard(source, { port });
      console.log(`Purix dashboard (read-only, this machine only):\n  ${running.url}\nStop with Ctrl+C.`);
      if (opts.open) {
        try {
          const { spawn } = await import("node:child_process");
          const cmd = process.platform === "win32" ? ["cmd", ["/c", "start", "", running.url]] as const : process.platform === "darwin" ? ["open", [running.url]] as const : ["xdg-open", [running.url]] as const;
          spawn(cmd[0], [...cmd[1]], { stdio: "ignore", detached: true }).on("error", () => { /* no browser: the address is printed */ }).unref();
        } catch { /* the address is printed */ }
      }
      await new Promise<void>((r) => { process.once("SIGINT", () => r()); process.once("SIGTERM", () => r()); });
      await running.close();
    });
}
