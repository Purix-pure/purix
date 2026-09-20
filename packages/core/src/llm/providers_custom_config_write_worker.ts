// packages/core/src/llm/providers_custom_config_write_worker.ts
//
// Standin for "a separate `purix provider-set custom ...` invocation, or
// another process entirely, rewriting provider-config.json's custom block
// out from under a long-lived process" — see the "getProvider — custom
// provider hot reload across processes" test in providers.test.ts.
import { writeSync } from "node:fs";
import { persistCustomProvider } from "./providers.js";

const baseDir = process.argv[2];
const baseUrl = process.argv[3];
const modelLow = process.argv[4];

if (!baseDir || !baseUrl || !modelLow) {
  // LIFECYCLE FIX (parity with budget_race_worker.ts): synchronous write
  // ahead of process.exit() — see that file's comment for why.
  writeSync(2, "usage: providers_custom_config_write_worker.ts <baseDir> <baseUrl> <modelLow>\n");
  process.exit(1);
}

process.chdir(baseDir);
persistCustomProvider({
  baseUrl,
  keyEnvVar: "CUSTOM_API_KEY",
  modelLow,
  modelHigh: "custom-high",
  label: "My Custom Provider",
});
