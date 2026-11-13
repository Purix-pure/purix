// Child process for exclusive_create_race.test.ts. Not a test itself. Waits for a shared start time so the
// processes really do collide, does one thing, reports one JSON line on stdout.
// Writes through fs.writeSync(1, ...) because core does not use process.stdout.write (single-point rule R1).
import { writeSync } from "node:fs";
import { acquireRepoLock, releaseRepoLock } from "./repo_lock.js";
import { getMachineId } from "./machine_id.js";
import { createSecretsStore } from "../security/secrets_manager.js";

const [mode, dir, startAt, idx] = process.argv.slice(2) as [string, string, string, string];
const report = (o: unknown): void => {
  writeSync(1, JSON.stringify(o) + "\n");
};
while (Date.now() < Number(startAt)) {
  /* spin until the shared start time */
}

if (mode === "lock") {
  try {
    acquireRepoLock(dir);
    report({ idx, result: "WON" });
    // Hold it while the others try, then let go.
    setTimeout(() => {
      releaseRepoLock(dir);
      process.exit(0);
    }, 1500);
  } catch (err) {
    report({ idx, result: "LOST", message: (err as Error).message });
    process.exit(0);
  }
} else if (mode === "machine") {
  report({ idx, id: getMachineId(dir) });
} else if (mode === "key") {
  // Own store file per process, shared master key: the only shared thing is the key.
  const store = createSecretsStore(dir, `s${idx}.enc.json`);
  store.setSecret("k", `value-${idx}`);
  report({ idx, ok: store.getSecret("k") === `value-${idx}` });
}
