// src/cli/commands/lock.ts
//
// `purix lock`: write purix.lock.json, the committed record of what Purix governs (a hash per governed file), so
// `purix check --strict` can verify a fresh checkout in CI, where the local store does not exist.
// Reads the store without changing it. Writes only purix.lock.json at the project root.
import type { Command } from "commander";

export function registerLockCommand(program: Command) {
  program
    .command("lock")
    .description("Write purix.lock.json: a hash per governed file, to commit so CI can run \"purix check --strict\" on a fresh checkout")
    .action(async () => {
      try {
        const [{ readStoreSnapshot }, lockMod] = await Promise.all([import("@purix/core/manifest/store"), import("@purix/core/state/governed_lock")]);
        const read = readStoreSnapshot();
        if (read.state === "absent") {
          console.error("🛑 No Purix state here, so there is nothing to lock. Run \"purix create\" or \"purix adopt\" first.");
          process.exitCode = 1;
          return;
        }
        if (read.state === "damaged") {
          const { describeStoreProblem } = await import("@purix/core/platform/disk_full");
          const { storeDirectory } = await import("@purix/core/manifest/store");
          const problem = describeStoreProblem(read.detail, storeDirectory());
          console.error(`🛑 ${problem[0]!.toUpperCase()}${problem.slice(1)} Nothing was written.`);
          process.exitCode = 1;
          return;
        }
        if (read.snapshot.manifest.length === 0) {
          console.error("🛑 No components are registered, so there is nothing to lock.");
          process.exitCode = 1;
          return;
        }
        const lock = lockMod.buildLock(read.snapshot.manifest, process.cwd());
        const path = lockMod.writeLock(process.cwd(), lock);
        const missing = lock.components.flatMap((c) => c.files.filter((f) => f.sha256 === null).map((f) => `${c.component_id}: ${f.path}`));
        console.log(`✅ Wrote ${lockMod.LOCK_FILENAME} (${lock.components.length} component(s), ${lock.components.reduce((n, c) => n + c.files.length, 0)} file(s)). Commit it; CI runs "purix check --strict" against it.`);
        console.log(`   ${path}`);
        if (missing.length > 0) {
          console.log(`  ⚠ ${missing.length} governed file(s) are missing on disk, so they cannot be checked later: ${missing.join(", ")}`);
        }
      } catch (err) {
        console.error(`🛑 purix lock failed: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 2;
      }
    });
}
