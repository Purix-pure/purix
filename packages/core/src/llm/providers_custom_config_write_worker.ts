// packages/core/src/llm/providers_custom_config_write_worker.ts
//
// Standin for "a separate `purix provider-set custom ...` invocation, or
// another process entirely, rewriting provider-config.json's custom block
// out from under a long-lived process" — see the "getProvider — custom
// provider hot reload across processes" test in providers.test.ts.
import { persistCustomProvider } from "./providers.js";

const baseDir = process.argv[2];
const baseUrl = process.argv[3];
const modelLow = process.argv[4];

if (!baseDir || !baseUrl || !modelLow) {
  console.error("usage: providers_custom_config_write_worker.ts <baseDir> <baseUrl> <modelLow>");
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
