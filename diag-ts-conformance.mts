// Run from the repo root on Windows AFTER the conformance suite has run once (it creates .purix\tmp\conformance\typescript):
//   pnpm exec tsx diag-ts-conformance.mts
// Shows why Purix found no test framework in the TypeScript conformance workspace on Windows (it passes on Linux).
import { resolve } from "node:path";
import { existsSync, readdirSync } from "node:fs";
import { discoverRelatedTests } from "./packages/core/src/verify/test_discovery.ts";
import { detectTestFramework } from "./packages/core/src/verify/tests.ts";

const dir = resolve(".purix", "tmp", "conformance", "typescript");
console.log("workspace:", dir, "exists:", existsSync(dir));
console.log("files:", existsSync(dir) ? readdirSync(dir).join(", ") : "(missing)");
const changed = [resolve(dir, "passing_fixture.ts")];
const d = discoverRelatedTests(changed, dir);
console.log("discovery:", JSON.stringify(d, null, 2));
console.log("framework:", detectTestFramework(dir, d.tests));
