// packages/cli/src/cli/commands/start.ts
//
// `purix start`: guided first-run setup. The flow itself (questions, order, wording) is in ../start_flow.ts and is tested with fakes;
// this file is only the real wiring: the key store, the provider files, the one-request key check, and `purix connect` as a child
// process of this same CLI. It writes nothing in the project: the provider default and the key go in the user's own folder.
import type { Command } from "commander";
import { spawnSync } from "node:child_process";

export function registerStartCommand(program: Command) {
  program
    .command("start")
    .description("Set Purix up in a few questions: choose the model provider, give Purix its own API key, check it, connect your coding agent")
    .addHelpText(
      "after",
      `
Run it in your own terminal. It asks for your API key at a hidden prompt, so it will not run from a script or through a coding agent.
Your coding agent keeps its own login; the key you give here is only for the requests Purix itself makes.

Example:
  $ purix start
`,
    )
    .action(async () => {
      const [{ runStart, StartCancelled }, secrets, guard, providers, confirmIo, envMod] = await Promise.all([
        import("../start_flow.js"),
        import("@purix/core/security/user_secrets"),
        import("@purix/core/security/credential_guard"),
        import("@purix/core/llm/providers"),
        import("@purix/core/cli-io/confirm"),
        import("@purix/core/platform/env"),
      ]);
      const store = secrets.createUserSecrets();

      const io = {
        interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY),
        log: (l: string) => console.log(l),
        err: (l: string) => console.error(l),
        ask: (q: string) => confirmIo.promptLine(q),
        askSecret: async (name: string) => {
          const { readSecretValue, SecretInputCancelled } = await import("./secret_input.js");
          try {
            // The shared line reader also hears what the hidden prompt reads; withExclusiveStdin drops what it queued.
            return await confirmIo.withExclusiveStdin(() => readSecretValue(name, { stdin: process.stdin, stderr: process.stderr }));
          } catch (e) {
            if (e instanceof SecretInputCancelled) throw new StartCancelled();
            throw e;
          }
        },
      };

      const deps = {
        providers: () => providers.listProviders().filter((p) => p.id !== "custom"),
        currentProvider: () => {
          try {
            const id = providers.activeProviderId();
            const source = providers.activeProviderSource();
            return source === null ? null : { id, source };
          } catch {
            return null;
          }
        },
        saveDefaultProvider: (id: string) => providers.persistUserDefaultProvider(id),
        keyStatus: (id: string) => providers.providerKeyStatus(id),
        envValue: (name: string) => {
          const v = envMod.dataDrivenEnv(name);
          return v !== undefined && v !== "" ? v : undefined;
        },
        hasStoredKey: (name: string) => store.has(name),
        storeKey: (name: string, value: string) => {
          const ctx = guard.defaultGuardContext(process.cwd(), store);
          // An existing entry is replaced under the rotate rules (same value checks, and the environment may not disagree).
          const verdict = ctx.storedNames.includes(name) ? guard.checkSecretRotate(name, value, ctx) : guard.checkSecretSet(name, value, ctx);
          if (!verdict.ok) return { ok: false as const, reason: verdict.reason };
          try {
            const { backend } = store.set(name, value);
            return { ok: true as const, backend, notes: verdict.notes };
          } catch (e) {
            return { ok: false as const, reason: (e as Error).message };
          }
        },
        probe: async (id: string) => (await import("@purix/core/llm/classify")).probeProviderKey(id),
        runConnect: async () => {
          // The same CLI, run again for `connect`: it keeps its own detection, agent picker, hook offer and exit code. Started with this
          // process's own Node flags and entry file, so it works from a global install and from a source checkout alike.
          const entry = process.argv[1];
          if (entry === undefined) return 1;
          const r = spawnSync(process.execPath, [...process.execArgv, entry, "connect"], { stdio: "inherit" });
          return r.status ?? 1;
        },
      };

      process.exitCode = await runStart(io, deps);
    });
}
