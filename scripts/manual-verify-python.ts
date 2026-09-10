import { resolve } from "node:path";
import { pythonPack } from "../packages/core/src/language/providers/python.pack";
import { pythonProvider } from "../packages/core/src/language/providers/python";

const baseDir = resolve(process.argv[2] ?? "");
if (!process.argv[2]) {
  console.error("usage: node --import tsx scripts/manual-verify-python.ts <baseDir>");
  process.exit(1);
}

const main = async () => {
  console.log("--- install (venv + pyright, pytest, ruff, pip-audit) ---");
  console.log(await pythonPack.install(baseDir));

  console.log("--- runTests ---");
  console.log(pythonProvider.runTests("manual", [], baseDir));

  console.log("--- checkIdiom ---");
  console.log(pythonProvider.checkIdiom([], baseDir));

  console.log("--- auditDependencies ---");
  console.log(await pythonProvider.auditDependencies(baseDir));
};

main();
