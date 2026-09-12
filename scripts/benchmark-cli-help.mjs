import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const cliPath = join(repoRoot, "packages", "cli", "dist", "cli.js");

if (!existsSync(cliPath)) {
  console.error(`Built CLI not found at ${cliPath}. Run \`pnpm --filter @purix/cli run build\` first.`);
  process.exit(1);
}

const commandSpecs = [
  "create",
  "modify",
  "ingest",
  "delete",
  "accept-drift",
  "migration-activate",
  "migration-rollback",
  "migrations",
  "status",
  "library",
  "stats",
  "audit",
  "audit-trail",
  "audit-verify",
  "diagnostics",
  "secret-set",
  "secret-rotate",
  "secret-remove",
  "secrets-status",
  "provider-set",
  "provider-status",
  "provider-list",
  "tier-status",
  "backup",
  "restore",
  "reconcile",
  "remember",
  "tools",
  "config",
  "config set",
  "config get",
  "config delete",
  "login",
  "logout",
  "lang",
  "lang list",
  "lang status",
  "lang verify",
  "lang install",
  "lang uninstall",
  "index",
  "mcp-serve",
  "connect",
];

const runsPerCommand = 3;
const results = [];

for (const spec of commandSpecs) {
  const args = spec.split(" ").filter(Boolean);
  const runDurations = [];

  for (let runIndex = 0; runIndex < runsPerCommand; runIndex += 1) {
    const start = Date.now();
    const result = spawnSync(process.execPath, [cliPath, ...args, "--help"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        PURIX_DEBUG_TIMING: "1",
      },
    });
    const elapsedMs = Date.now() - start;
    runDurations.push(elapsedMs);

    if (result.status !== 0) {
      console.error(`Command failed: ${spec} (run ${runIndex + 1})`);
      console.error(result.stderr || result.stdout || "No output");
      process.exit(result.status ?? 1);
    }
  }

  const avgMs = runDurations.reduce((sum, value) => sum + value, 0) / runDurations.length;
  results.push({ spec, runDurations, avgMs });

  console.log(`${spec}: ${runDurations.join("ms, ")}ms | avg=${avgMs.toFixed(1)}ms`);
}

const totalAverage = results.reduce((sum, result) => sum + result.avgMs, 0) / results.length;
console.log(`\nSummary: ${results.length} commands benchmarked across ${runsPerCommand} runs each | average=${totalAverage.toFixed(1)}ms`);
