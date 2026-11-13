// src/cli/commands/landed.ts
//
// Tells the person when a change that has already landed could not be recorded. All the recording logic is in
// @purix/core/state/landed_change; this file only prints.
import type { LandedChange } from "@purix/core/state/landed_change";

export function warnRecordProblems(problems: string[]): void {
  for (const p of problems) console.log(`  ⚠ The change landed, but ${p}. Run "purix check" to see what is recorded.`);
}

/** For commands (create, delete) that write the manifest themselves: record the landed change and report any problem. */
export async function noteLanded(change: LandedChange): Promise<void> {
  const { recordLandedChange } = await import("@purix/core/state/landed_change");
  warnRecordProblems(recordLandedChange(change, process.cwd()).problems);
}
