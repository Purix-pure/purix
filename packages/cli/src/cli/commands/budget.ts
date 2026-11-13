// src/cli/commands/budget.ts
//
// A10c-1 (research 15 finding 9): the model spend ceiling was a lifetime total per repository, and once it was reached every
// model call was refused for good, with a message that offered only an environment variable. `purix budget` shows the total
// and starts a new budget. A reset needs a reason and is recorded with the old total.
import type { Command } from "commander";

export function registerBudgetCommands(program: Command) {
  const cmd = program.command("budget").description("Show this repository's model spend against its ceiling, or start a new budget");

  const show = async () => {
    const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
    if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
    const { getBudgetSnapshot } = await import("@purix/core/llm/budget");
    const s = getBudgetSnapshot();
    if (!s) { console.log("No spend has been recorded for this repository yet."); return; }
    console.log(`Estimated spend: $${s.totalSpentUsd.toFixed(4)} of a $${s.ceiling.toFixed(2)} ceiling, for this repository.`);
    if (s.totalSpentUsd >= s.ceiling) {
      console.log('The ceiling is reached, so model calls are refused. Start a new budget with: purix budget reset --reason "<why>"');
    }
  };
  cmd.action(show);
  cmd.command("show").description("Show estimated spend against the ceiling").action(show);

  cmd
    .command("reset")
    .description("Start a new budget: set this repository's estimated spend back to zero (recorded with your reason)")
    .requiredOption("--reason <why>", "why the budget is being reset; recorded with the old total")
    .action(async (options: { reason: string }) => {
      const { storeExists, NO_STATE_MESSAGE } = await import("@purix/core/manifest/store");
      if (!storeExists()) { console.log(NO_STATE_MESSAGE); return; }
      try {
        const { resetBudget, getBudgetSnapshot } = await import("@purix/core/llm/budget");
        const { previousTotalUsd } = resetBudget(options.reason);
        const ceiling = getBudgetSnapshot()?.ceiling;
        console.log(`Budget reset. Cleared $${previousTotalUsd.toFixed(4)} of estimated spend${ceiling === undefined ? "" : `; the ceiling is $${ceiling.toFixed(2)}`}. The reset is recorded.`);
      } catch (err) {
        console.error(`Could not reset the budget: ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    });
}
