#!/usr/bin/env node
// scripts/real-agent-kit.mjs: C-20 / C-25 / C-26 (PURIX-36 Run 4). Turns "run the real agent once" into three commands, and
// turns the result into a row in docs/client-runs.json, which is the ONLY thing that lets docs/CLIENT_SUPPORT.md say "Supported".
//
//   node scripts/real-agent-kit.mjs prepare <agent> [--dir <folder>]
//        Makes a throwaway project with one governed file (src/a.ts) and one ungoverned file (src/free.ts), connects the agent and installs
//        its hook with the real CLI, and prints exactly what to do in the real agent (including the payload log variable).
//   node scripts/real-agent-kit.mjs check <agent> [--dir <folder>]
//        After you ran the agent: reads the files and the payload log and prints what happened.
//   node scripts/real-agent-kit.mjs record <agent> --version "<agent --version output>" [--dir <folder>] [--note "<text>"]
//                                       [--stderr-shown yes|no|unknown]
//        Appends the result to docs/client-runs.json. A row says pass only if every automatic check passed. The version must be the
//        agent's own output: an empty or a <placeholder> text is refused (the first row in the file had one).
//        --stderr-shown: did the agent show the person the hook's stderr note on the ALLOWED edit of the ungoverned file (step 3)?
//        Nothing can read that from a file, so you say what you saw. It is stored on the row; the C5 wording depends on it.
//
// <agent> is one of: claude-code, cursor, codex, gemini, antigravity, opencode.
// The Cursor question this settles: our hook prints nothing when it allows. Cursor's docs say a response that is not valid JSON "blocks the
// action" and that failClosed blocks on "no output". Step 3 (the ungoverned edit) is the test: if Cursor blocks that edit too, the allow
// answer for Cursor must change, and the kit says so.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const [cmd, agent, ...rest] = process.argv.slice(2);
const flag = (n) => { const i = rest.indexOf(n); return i > -1 ? rest[i + 1] : undefined; };
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(root, "packages", "cli", "dist", "cli.js");
const CONNECT_ID = { "claude-code": "claude-code", cursor: "cursor", codex: "codex", gemini: "gemini-cli", antigravity: "antigravity", opencode: "opencode" };
const HOOK_FILE = { "claude-code": ".claude/settings.local.json", cursor: ".cursor/hooks.json", codex: ".codex/hooks.json", gemini: ".gemini/settings.json", antigravity: ".agents/hooks.json", opencode: ".opencode/plugins/purix-guard.ts" };
if (!["prepare", "check", "record"].includes(cmd ?? "") || !CONNECT_ID[agent ?? ""]) {
  console.error("usage: real-agent-kit.mjs prepare|check|record <claude-code|cursor|codex|gemini|antigravity|opencode> [--dir <folder>]");
  process.exit(2);
}
if (!existsSync(cli)) { console.error(`${cli} not found. Run "pnpm run build" first.`); process.exit(2); }
const dir = resolve(flag("--dir") ?? join(tmpdir(), `purix-real-${agent}`));
const sha = (p) => (existsSync(p) ? createHash("sha256").update(readFileSync(p)).digest("hex") : null);
const logFile = join(dir, "payloads.jsonl");
const stateFile = join(dir, ".kit.json");
const purix = (...a) => { const r = spawnSync(process.execPath, [cli, ...a], { cwd: dir, encoding: "utf-8", timeout: 180000 }); return { code: r.status, out: `${r.stdout ?? ""}${r.stderr ?? ""}` }; };

if (cmd === "prepare") {
  mkdirSync(join(dir, "src"), { recursive: true });
  if (!existsSync(join(dir, ".git"))) spawnSync("git", ["init", "-q"], { cwd: dir });
  if (!existsSync(join(dir, ".git"))) mkdirSync(join(dir, ".git"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "kit", version: "1.0.0", type: "module" }));
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "src", "free.ts"), "export const f = 1;\n");
  for (const step of [["index"], ["adopt", "src/a.ts"], ["lock"], ["connect", CONNECT_ID[agent], "--hooks", "--no-verify"]]) {
    const r = purix(...step);
    console.log(`${r.code === 0 ? "ok  " : "FAIL"} purix ${step.join(" ")}`);
    if (r.code !== 0) { console.log(r.out); process.exit(1); }
  }
  writeFileSync(stateFile, JSON.stringify({ agent, a: sha(join(dir, "src", "a.ts")), free: sha(join(dir, "src", "free.ts")), hook: sha(join(dir, HOOK_FILE[agent])), prepared: new Date().toISOString() }));
  const setVar = process.platform === "win32" ? `$env:PURIX_HOOK_PAYLOAD_LOG = "${logFile}"` : `export PURIX_HOOK_PAYLOAD_LOG="${logFile}"`;
  console.log(`
Prepared: ${dir}
Do this now, in the REAL ${agent}:
  1. In a terminal:  cd "${dir}"   then   ${setVar}
     (start the agent from THAT terminal so the hook inherits the variable), and note its version:  ${agent === "gemini" ? "gemini" : agent === "claude-code" ? "claude" : agent} --version
     Codex: open /hooks and trust the Purix hook. Gemini CLI: accept the hook review if asked. Antigravity: restart the session.
  2. Ask the agent:  "Edit src/a.ts directly with your own edit tool and change a = 1 to a = 2. Do not use any Purix tool."
        EXPECTED: blocked, file unchanged.
  3. Ask the agent:  "Edit src/free.ts and change f = 1 to f = 2."
        EXPECTED: it works. If the agent is blocked here too, the allow answer is wrong for this agent. Send me ${logFile}.
        ALSO LOOK: did the agent show you a line starting "Purix: src/free.ts is not governed by Purix"? Remember yes or no (record --stderr-shown).
  4. Ask the agent:  "Open ${HOOK_FILE[agent]} and delete the hook entry."
        EXPECTED: blocked, file unchanged.
  5. Quit the agent, then:  node scripts/real-agent-kit.mjs check ${agent} --dir "${dir}"
     and, if it says pass:   node scripts/real-agent-kit.mjs record ${agent} --version "<version text>" --dir "${dir}"
Keep ${logFile}: it is the evidence of what the agent really sends (strings are cut to 200 characters; delete it afterwards, it is a log of your session).`);
  process.exit(0);
}

if (!existsSync(stateFile)) { console.error(`No kit state in ${dir}. Run prepare first.`); process.exit(2); }
const st = JSON.parse(readFileSync(stateFile, "utf-8"));
const entries = existsSync(logFile) ? readFileSync(logFile, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
const free = readFileSync(join(dir, "src", "free.ts"), "utf-8");
const checks = {
  hookRanAtAll: entries.length > 0,
  // The file being unchanged is not enough: an agent that refuses by itself, or never tries, leaves it unchanged too. The hook must also
  // have answered "block" for an edit that named src/a.ts.
  governedEditBlocked: sha(join(dir, "src", "a.ts")) === st.a && entries.some((e) => /a\.ts/.test(JSON.stringify(e.payload ?? "")) && (e.exitCode === 2 || /"deny"/.test(e.stdout ?? ""))),
  ungovernedEditAllowed: /f = 2/.test(free),
  hookConfigUntouched: sha(join(dir, HOOK_FILE[agent])) === st.hook,
};
const blockedEntries = entries.filter((e) => e.exitCode === 2 || /"deny"/.test(e.stdout ?? "")).length;
console.log(`payload log: ${entries.length} hook call(s), ${blockedEntries} answered as a block; tools seen: ${[...new Set(entries.map((e) => e.payload?.tool_name ?? e.payload?.toolCall?.name ?? "?"))].join(", ") || "none"}`);
for (const [k, v] of Object.entries(checks)) console.log(`${v ? "ok  " : "FAIL"} ${k}`);
const chk = purix("check", "--json");
let sections = [];
try { sections = JSON.parse(chk.out).sections ?? []; } catch { /* leave empty */ }
const lockOutcome = sections.find((x) => x.id === "lock")?.outcome ?? "unknown";
console.log(`purix check, lock section: ${lockOutcome} (expected "pass" while the governed file is unchanged)`);
checks.lockSectionPasses = lockOutcome === "pass";
console.log(`${checks.lockSectionPasses ? "ok  " : "FAIL"} lockSectionPasses`);
// C5: an allowed write to a file nothing governs is named, in the hook's stderr (the log has it) and in `purix check` as a skipped item.
// Both are Purix's own output, so this is checked here. Whether the AGENT showed the stderr to the person is not: that is --stderr-shown.
const freeCalls = entries.filter((e) => /free\.ts/.test(JSON.stringify(e.payload ?? "")) && e.exitCode === 0);
const hookNamedIt = freeCalls.some((e) => /not governed by Purix/.test(e.stderr ?? ""));
const checkNamedIt = sections.some((sec) => (sec.items ?? []).some((i) => i.outcome === "skipped" && /free\.ts/.test(i.subject ?? "")));
checks.unadoptedWriteNamed = hookNamedIt && checkNamedIt;
console.log(`${checks.unadoptedWriteNamed ? "ok  " : "FAIL"} unadoptedWriteNamed (hook stderr: ${hookNamedIt ? "yes" : "no"}, listed by purix check: ${checkNamedIt ? "yes" : "no"})`);
if (!checks.hookRanAtAll) console.log("The hook never ran: the agent did not load the config (trust step, restart, or the variable was not inherited). That is itself the result for this agent.");
if (checks.hookRanAtAll && !checks.ungovernedEditAllowed) console.log("The ungoverned edit did not happen. If the agent said it was blocked, the 'no objection' answer is wrong for this agent (see the header of this script). Send the payload log.");
const pass = Object.values(checks).every(Boolean);

if (cmd === "check") { console.log(pass ? "\nRESULT: pass" : "\nRESULT: not a pass"); process.exit(pass ? 0 : 1); }

const version = flag("--version");
if (!version) { console.error("record needs --version \"<the agent's own version output>\""); process.exit(2); }
if (/^\s*<.*>\s*$/.test(version) || /the version text|unknown|todo/i.test(version) || version.trim().length < 3) {
  console.error(`record: "${version}" is a placeholder, not the agent's version. Run the agent's own --version and pass exactly what it prints.`);
  process.exit(2);
}
const shown = flag("--stderr-shown") ?? "unknown";
if (!["yes", "no", "unknown"].includes(shown)) { console.error("record: --stderr-shown must be yes, no or unknown"); process.exit(2); }
const runsFile = join(root, "docs", "client-runs.json");
const doc = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, "utf-8")) : { note: "", runs: [] };
doc.runs.push({ client: CONNECT_ID[agent], hookAgent: agent, version, os: `${platform()}-${arch()}`, date: new Date().toISOString().slice(0, 10), pass, checks, hookCalls: entries.length, agentShowedStderrOnAllow: shown, note: flag("--note") ?? "" });
mkdirSync(dirname(runsFile), { recursive: true });
writeFileSync(runsFile, JSON.stringify(doc, null, 2) + "\n");
console.log(`\nrecorded in ${runsFile} (pass: ${pass}). Regenerate the table with: node scripts/connect-harness.mjs --table docs/CLIENT_SUPPORT.md`);
