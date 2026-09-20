import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync, mkdirSync, mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const scratch = mkdtempSync(join(tmpdir(), "purix-mcp-test-"));
const lines = [];
let pass = 0;
let fail = 0;

function log(label, ok, detail) {
  lines.push(`### ${label}`);
  lines.push("");
  lines.push("```");
  lines.push(typeof detail === "string" ? detail : JSON.stringify(detail, null, 2));
  lines.push("```");
  lines.push(ok ? "**Result: PASS**" : "**Result: FAIL**");
  lines.push("");
  ok ? pass++ : fail++;
}

// Find the repo root by walking up from this script's own location until
// we hit turbo.json — this script can live anywhere in the tree (repo
// root or scripts/) and this still resolves correctly. No hardcoded
// absolute path, so it works on any machine/CI runner, not just the one
// it was written on.
function findRepoRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, "turbo.json")) && existsSync(join(dir, "pnpm-workspace.yaml"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `Could not locate repo root (turbo.json + pnpm-workspace.yaml) walking up from ${startDir}. ` +
      `Run this script from inside the purix monorepo checkout.`,
  );
}

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = findRepoRoot(scriptDir);
const cliDistEntry = join(repoRoot, "packages", "cli", "dist", "cli.js");

// Build the real published artifact before testing it. A smoke test that
// skips this and points at src/*.ts via tsx is testing a path a real
// `npm install -g purix` / `npx purix` user never takes.
function buildCli() {
  console.log(`Building @purix/cli (and its workspace deps) via turbo in ${repoRoot} ...`);
  const result = spawnSync("npx", ["turbo", "run", "build", "--filter=@purix/cli..."], {
    cwd: repoRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
  if (result.status !== 0) {
    throw new Error(
      `turbo build failed (exit ${result.status}). Fix the build before trusting this smoke test — ` +
        `do not fall back to running src/cli.ts through tsx, that tests a path real users never hit.`,
    );
  }
  if (!existsSync(cliDistEntry)) {
    throw new Error(
      `Build reported success but ${cliDistEntry} still doesn't exist. ` +
        `Either the build target changed or packages/cli/package.json's "build" script/output moved — ` +
        `check tsconfig.build.json's outDir before assuming this script is wrong.`,
    );
  }
}

// Regression check for a lock bug found in practice: a stale lock file
// with a *live* PID (the OS had recycled the original PID onto an
// unrelated process) falsely blocked mcp-serve from starting, and the
// only way out was deleting .purix/repo.lock by hand. repo_lock.ts now
// also checks a heartbeat, not just PID liveness — this reproduces that
// exact shape (a PID guaranteed alive: this script's own pid, paired
// with a heartbeat well past the staleness window) and asserts mcp-serve
// starts anyway instead of rejecting with "already locked".
function checkStaleLockIsReclaimed() {
  const purixDir = join(repoRoot, ".purix");
  const lockPath = join(purixDir, "repo.lock");
  const hadExistingDir = existsSync(purixDir);
  mkdirSync(purixDir, { recursive: true });
  const staleTimestamp = new Date(Date.now() - 60_000).toISOString(); // 60s old
  writeFileSync(
    lockPath,
    JSON.stringify({ pid: process.pid, timestamp: staleTimestamp, updatedAt: staleTimestamp }),
  );

  const result = spawnSync("node", [cliDistEntry, "status"], {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, AUTO_CONFIRM: "1", PURIX_MCP_AGENT_ID: "smoke-test-stale-lock-check" },
  });

  const combined = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const wasRejected = combined.includes("already locked by active process PID");
  log(
    "Pre-seeded stale lock (live PID, old heartbeat) is reclaimed, not honored",
    result.status === 0 && !wasRejected,
    wasRejected
      ? `FAILED — command was rejected as locked even though the heartbeat was 60s stale:\n${combined.slice(0, 1000)}`
      : `\`purix status\` ran successfully against a lock file carrying a live PID (${process.pid}) and a 60s-old heartbeat — confirms the staleness check, not just PID liveness, is what actually reclaims an abandoned lock.`,
  );

  // Clean up: only remove the directory if this check created it fresh.
  if (!hadExistingDir) {
    rmSync(purixDir, { recursive: true, force: true });
  } else if (existsSync(lockPath)) {
    rmSync(lockPath, { force: true });
  }
}

async function main() {
  buildCli();
  checkStaleLockIsReclaimed();

  const transport = new StdioClientTransport({
    command: "node",
    args: [cliDistEntry, "mcp-serve"],
    cwd: repoRoot,
    env: { ...process.env, AUTO_CONFIRM: "1", PURIX_MCP_AGENT_ID: "smoke-test" },
  });

  const client = new Client({ name: "purix-smoke-test", version: "1.0.0" }, { capabilities: {} });

  try {
    await client.connect(transport);
    log("Handshake (initialize)", true, `Connected and initialized successfully against ${cliDistEntry}.`);
  } catch (err) {
    log("Handshake (initialize)", false, String(err));
    finish();
    return;
  }

  let tools = [];
  try {
    const res = await client.listTools();
    tools = res.tools ?? [];
    const names = tools.map((t) => t.name).sort();
    log(
      `Tool discovery (found ${tools.length})`,
      tools.length > 0,
      names.join("\n"),
    );
  } catch (err) {
    log("Tool discovery", false, String(err));
  }

  const readOnlyCalls = [
    { name: "purix_status", arguments: {} },
    { name: "purix_stats", arguments: {} },
    { name: "purix_library", arguments: {} },
    { name: "purix_audit", arguments: {} },
    { name: "purix_tools", arguments: { purpose: "parse CSV files" } },
  ];

  for (const call of readOnlyCalls) {
    const toolExists = tools.some((t) => t.name === call.name);
    if (!toolExists) {
      log(`Call ${call.name}`, false, "Tool was not present in tools/list — skipped.");
      continue;
    }
    try {
      const result = await client.callTool(call);
      const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
      log(`Call ${call.name}`, !result.isError, text.slice(0, 2000));
    } catch (err) {
      log(`Call ${call.name}`, false, String(err));
    }
  }

  await client.close();
  finish();
}

function finish() {
  const header = [
    "# Purix MCP Server Smoke Test",
    "",
    `- Generated: ${new Date().toISOString()}`,
    `- Repo root: \`${repoRoot}\``,
    `- CLI entrypoint under test: \`${cliDistEntry}\` (built fresh via turbo, run with plain \`node\`)`,
    `- Scratch dir (unused by the server, reserved for future fixture-project tests): \`${scratch}\``,
    `- Checks passed: ${pass}`,
    `- Checks failed: ${fail}`,
    "",
    "This confirms the MCP wire protocol works end to end (handshake, tool",
    "discovery, tool calls) against the actual built CLI entrypoint — the",
    "same file a real `npm install` / `npx purix` user runs. It does not",
    "judge whether tool output is semantically correct.",
    "",
  ];
  writeFileSync("purix-mcp-report.md", header.concat(lines).join("\n"));
  console.log(`Done. ${pass} passed, ${fail} failed. Report: purix-mcp-report.md`);
}

main().catch((err) => {
  console.error("Smoke test crashed:", err);
  process.exit(1);
});
