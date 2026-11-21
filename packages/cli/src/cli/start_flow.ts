// packages/cli/src/cli/start_flow.ts
//
// `purix start`: one guided setup for a person at a terminal. Pick the model provider, give Purix its own key, check the key with one
// tiny request, connect a coding agent. Decisions D1 to D12 in docs/research/PURIX-RESEARCH-KEY-MANAGEMENT-AND-START-2026-11-21.md.
//
// Everything that touches the machine (the key store, the provider files, the network, the child process that runs `purix connect`) is
// behind StartDeps, so the flow can be tested without a terminal, a key or a network (same seam as greenfield_preflight.ts). The real
// wiring is in commands/start.ts. This module prints nothing by itself except through StartIO.
//
// What it will not do:
//   - run without a person at a terminal (it asks for a key and changes which key Purix uses; hooks list it as human-only);
//   - take a key from the command line or print one back (the value goes from the hidden prompt to the store);
//   - touch the agent's own login (that is the agent's, not Purix's);
//   - index the project (that is per project and takes time; the closing lines say what to run next).

export interface StartIO {
  /** A person is at the keyboard: stdin and stdout are both terminals. */
  interactive: boolean;
  log(line: string): void;
  err(line: string): void;
  /** One line typed by the person, or null when input ended. */
  ask(question: string): Promise<string | null>;
  /** The key, typed or pasted at a hidden prompt. Throws StartCancelled on Ctrl-C and Error on an empty value. */
  askSecret(name: string): Promise<string>;
}

export type ProviderChoiceSource = "environment" | "project" | "user_default";
export type KeySource = "environment" | "stored" | "stored_folder" | "missing";

export interface StartDeps {
  /** Registry providers a person can pick (no "custom": that is per project, behind the trust gate). */
  providers(): { id: string; label: string; keyEnvVar: string }[];
  /** The provider in force right now and where that comes from, or null when none is set. */
  currentProvider(): { id: string; source: ProviderChoiceSource } | null;
  saveDefaultProvider(id: string): void;
  keyStatus(providerId: string): { envVar: string; source: KeySource; conflict: boolean } | undefined;
  /** The environment variable's value, for copying to the store. Never printed. */
  envValue(name: string): string | undefined;
  /** True when the user-level store already holds this credential (a copy of the environment key, say). */
  hasStoredKey(name: string): boolean;
  /** Saves the key in the user-level store through the credential guard. */
  storeKey(name: string, value: string): { ok: true; backend: "keyring" | "file"; notes: string[] } | { ok: false; reason: string };
  /** One tiny request to the provider. */
  probe(providerId: string): Promise<{ ok: true; provider: string; model: string } | { ok: false; message: string }>;
  /** Runs `purix connect` (detect or ask which agent, then offer the hook). Resolves to its exit code. */
  runConnect(): Promise<number>;
}

/** Thrown by askSecret / answers when the person cancels. */
export class StartCancelled extends Error {
  constructor() {
    super("Cancelled.");
    this.name = "StartCancelled";
  }
}

export const NOT_A_TERMINAL_LINES: readonly string[] = [
  "🛑 `purix start` needs a person at a terminal: it asks for your API key and decides which key Purix uses, so a script or a coding agent cannot run it. Nothing was changed.",
  "Run it yourself in a terminal window:",
  "  purix start",
  "Or do the same steps by hand:",
  "  purix provider list               see the provider ids",
  "  purix provider set <id>           choose one",
  "  purix secret set <KEY_NAME>       asks for the key (never put a key on the command line)",
  "  purix connect                     connect your coding agent",
];

const MAX_KEY_ATTEMPTS = 3;

function where(backend: "keyring" | "file"): string {
  return backend === "keyring" ? "your OS keyring" : "an encrypted file in your user folder (not the OS keyring)";
}

export interface StartSummary {
  provider?: string;
  keyFrom?: "environment" | "saved" | "already saved";
  check?: "passed" | "failed" | "not run";
  agent?: "connected" | "skipped" | "failed";
}

/** Runs the guided setup. Returns the exit code: 0 set up (a skipped key check still counts), 1 not finished or the key check failed, 130 cancelled. */
export async function runStart(io: StartIO, deps: StartDeps): Promise<number> {
  if (!io.interactive) {
    for (const line of NOT_A_TERMINAL_LINES) io.err(line);
    return 1;
  }
  try {
    return await guided(io, deps);
  } catch (e) {
    if (e instanceof StartCancelled) {
      io.log("Cancelled. Anything already saved stays saved; run `purix start` again to continue.");
      return 130;
    }
    throw e;
  }
}

async function line(io: StartIO, question: string): Promise<string> {
  const answer = await io.ask(question);
  if (answer === null) throw new StartCancelled();
  return answer.trim();
}

/** Enter takes `dflt`; anything starting with y/n decides; anything else asks again once, then takes the default. */
async function yesNo(io: StartIO, question: string, dflt: boolean): Promise<boolean> {
  const hint = dflt ? "[Y/n]" : "[y/N]";
  for (let i = 0; i < 2; i++) {
    const a = (await line(io, `${question} ${hint} `)).toLowerCase();
    if (a === "") return dflt;
    if (a === "y" || a === "yes") return true;
    if (a === "n" || a === "no") return false;
    io.log("Please answer y or n.");
  }
  return dflt;
}

async function guided(io: StartIO, deps: StartDeps): Promise<number> {
  const summary: StartSummary = {};
  let exit = 0;

  io.log("Purix setup. Three short steps: pick the model Purix uses, give Purix its own key, connect your coding agent.");
  io.log("Your coding agent keeps its own login. This key is only for the requests Purix itself makes.");
  io.log("");

  // ---- 1. provider ---------------------------------------------------------------------------------------------------------------
  const providers = deps.providers();
  const current = deps.currentProvider();
  let providerId: string | undefined;

  if (current?.source === "environment") {
    providerId = current.id;
    io.log(`1/3 Provider: ${current.id}, set by the PURIX_LLM_PROVIDER variable. That variable wins over anything saved; unset it to choose here.`);
  } else {
    if (current !== null) {
      const label = providers.find((p) => p.id === current.id)?.label ?? current.id;
      const from = current.source === "project" ? "this folder's own setting" : "your saved default";
      io.log(`1/3 Provider: ${current.id} (${label}), from ${from}.`);
      if (await yesNo(io, "Keep it?", true)) providerId = current.id;
    } else {
      io.log("1/3 Which model provider should Purix use?");
    }
    if (providerId === undefined) {
      providers.forEach((p, i) => io.log(`  ${String(i + 1).padStart(2)}. ${p.id.padEnd(12)} ${p.label}`));
      io.log("  Not listed? Any OpenAI-compatible service works: purix provider set custom --help");
      const answer = await line(io, `Choose 1-${providers.length}, or type an id (Enter to cancel): `);
      if (answer === "") {
        io.log("Nothing changed.");
        return 1;
      }
      const n = Number.parseInt(answer, 10);
      const picked = String(n) === answer ? providers[n - 1] : providers.find((p) => p.id === answer.toLowerCase());
      if (!picked) {
        io.err(`🛑 "${answer}" is not one of the listed providers. Nothing was changed. Run \`purix start\` again.`);
        return 1;
      }
      providerId = picked.id;
      if (current?.id !== picked.id || current.source !== "user_default") {
        deps.saveDefaultProvider(picked.id);
        io.log(`   Saved ${picked.id} as your default provider. It applies in every folder.`);
        if (current?.source === "project" && current.id !== picked.id) {
          io.log(`   This folder has its own setting (${current.id}), which still wins here. Other folders use ${picked.id}.`);
        }
      }
    } else if (current?.source === "project") {
      // Kept as is: a project's own choice. Nothing saved at user level, so say how other folders will behave.
      io.log("   (Other folders have no provider yet. Choose it again, or run `purix start` there, to save a default for all folders.)");
    }
  }
  summary.provider = providerId;

  // ---- 2. key --------------------------------------------------------------------------------------------------------------------
  const status = deps.keyStatus(providerId);
  if (!status) {
    io.err(`🛑 The provider "${providerId}" is not complete, so there is no key name to look for. Run \`purix provider status\` to see what is missing.`);
    return 1;
  }
  const name = status.envVar;
  io.log("");
  io.log(`2/3 Key: Purix looks for ${name}.`);

  const saveFromPrompt = async (): Promise<boolean> => {
    for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
      let value: string;
      try {
        value = await io.askSecret(name);
      } catch (e) {
        if (e instanceof StartCancelled) throw e;
        io.err(`🛑 ${(e as Error).message}`);
        return false;
      }
      const saved = deps.storeKey(name, value);
      if (saved.ok) {
        io.log(`✅ Saved ${name} (${value.length} characters, not shown) in ${where(saved.backend)}. It is found from any folder and by your coding agent's tools.`);
        for (const note of saved.notes) io.log(`   ${note}`);
        return true;
      }
      io.err(`🛑 ${saved.reason}`);
      // Only a badly pasted value is worth asking for again; a refused name or a conflicting environment key will not change by retyping.
      if (!/^The value /.test(saved.reason)) return false;
      if (attempt < MAX_KEY_ATTEMPTS) io.log("Try pasting it again.");
    }
    return false;
  };

  if (status.source === "environment") {
    io.log(`   Found ${name} in your environment (not shown).`);
    summary.keyFrom = "environment";
    if (!deps.hasStoredKey(name)) {
      io.log("   Apps started outside a terminal (many coding agents) often do not see variables set in a shell, and the key would be missing there.");
      if (await yesNo(io, `Also save a copy of ${name} where your coding agent's tools can find it?`, true)) {
        const value = deps.envValue(name);
        if (value === undefined) {
          io.err("🛑 The variable is no longer set. Nothing was saved.");
        } else {
          const saved = deps.storeKey(name, value);
          if (saved.ok) {
            io.log(`✅ Saved a copy in ${where(saved.backend)}. The environment variable is still used first while it is set.`);
            for (const note of saved.notes) io.log(`   ${note}`);
            summary.keyFrom = "saved";
          } else {
            io.err(`🛑 ${saved.reason}`);
            exit = 1;
          }
        }
      }
    } else {
      io.log("   A copy is already saved too.");
    }
    if (status.conflict) io.log("   ⚠ Another place holds a DIFFERENT key. The environment one is used. `purix secret status` shows where.");
  } else if (status.source === "stored") {
    io.log("   A key is already saved for this provider.");
    summary.keyFrom = "already saved";
    if (status.conflict) io.log("   ⚠ Another place holds a DIFFERENT key that is not used. `purix secret status` shows where.");
    if (await yesNo(io, "Replace it with a new key?", false)) {
      if (await saveFromPrompt()) summary.keyFrom = "saved";
      else exit = 1;
    }
  } else {
    if (status.source === "stored_folder") {
      io.log("   Found only in an OLD per-folder key store, which other folders cannot see. `purix secret migrate` moves it; or paste the key now.");
    }
    io.log("   Paste your key. It is hidden as you type and goes straight to your OS keyring (or an encrypted file if there is none).");
    if (await saveFromPrompt()) summary.keyFrom = "saved";
    else {
      io.err(`The key was not saved. Run \`purix start\` again, or \`purix secret set ${name}\`.`);
      return 1;
    }
  }

  // ---- key check -----------------------------------------------------------------------------------------------------------------
  const label = providers.find((p) => p.id === providerId)?.label ?? providerId;
  io.log("");
  if (await yesNo(io, `Check the key now? This sends one tiny request (a few words, nothing from your project) to ${label}.`, true)) {
    io.log("   Checking...");
    const result = await deps.probe(providerId);
    if (result.ok) {
      io.log(`✅ ${label} accepted the key (model ${result.model}).`);
      summary.check = "passed";
    } else {
      io.err(`🛑 The check failed: ${result.message}`);
      io.err("   A rejected key and a network or provider problem look alike here. If the message says the key is not valid, replace it:");
      io.err(`   purix secret rotate ${name}`);
      summary.check = "failed";
      exit = 1;
    }
  } else {
    io.log("   Not checked. The first real request will be the first test.");
    summary.check = "not run";
  }

  // ---- 3. agent ------------------------------------------------------------------------------------------------------------------
  io.log("");
  io.log("3/3 Coding agent.");
  if (await yesNo(io, "Connect a coding agent (Claude Code, Cursor, Codex, OpenCode, ...) to Purix in this folder now?", true)) {
    io.log("");
    const code = await deps.runConnect();
    summary.agent = code === 0 ? "connected" : "failed";
    if (code !== 0) exit = 1;
  } else {
    io.log("   Skipped. Later: purix connect");
    summary.agent = "skipped";
  }

  // ---- summary -------------------------------------------------------------------------------------------------------------------
  io.log("");
  io.log(exit === 0 ? "Done." : "Finished with a problem (above).");
  io.log(`  Provider:  ${summary.provider}`);
  io.log(`  Key:       ${summary.keyFrom === "environment" ? "from your environment" : summary.keyFrom === "saved" ? "saved for your user account" : "already saved"}`);
  io.log(`  Key check: ${summary.check}`);
  io.log(`  Agent:     ${summary.agent}`);
  io.log("Not done: your project was not indexed. Next:");
  io.log('  purix create "what you want to build"   plan it, review the files, approve before anything is written');
  io.log("  purix index                             record the code that is already here");
  if (summary.agent === "connected") io.log("  Then restart your coding agent and ask it to run the purix_status tool.");
  return exit;
}
