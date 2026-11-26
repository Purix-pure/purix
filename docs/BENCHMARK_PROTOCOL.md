# Benchmark protocol: Purix against a plain agent

Decision (2026-11-24): a **separate script**, `scripts/benchmark-analyze.ts`, not a `purix` command. A command would sit in the product and invite a number on a dashboard before there is a sound basis for one. The script analyses a file a person collected; it reads no project record and makes no network call.

## Design

- **Paired.** Each task is done twice with the same agent and model: once plain, once with Purix. Order is randomised per task. The pair is the unit of analysis.
- **Tasks fixed in advance.** Write the acceptance tests before any run and keep them hidden from the agent. Record task selection so it cannot be tuned afterwards.
- **Measures** (each reported on its own): acceptance tests passed (yes/no), cost in USD (estimated), time in seconds, human interruptions, defects found by a later independent review.
- **Enough pairs.** Fewer than 10 usable pairs for a measure reads "not enough pairs", with no figure.
- **Missing is not zero.** A pair missing a value is left out of that measure only; the count of pairs used is printed.

## Statistics

Yes/no measures: counts of both pass, both fail and only-one-passes, with an exact sign test on the discordant pairs. Numbers: the median of the paired differences (Purix minus plain) with a 95% bootstrap interval, plus how many pairs went each way. The bootstrap uses a fixed seed so the same file gives the same interval.

## Not done, on purpose

No single score. No ranking of agents or models. No dollar value for bugs prevented. No claim beyond the tasks chosen: they are not a sample of all work.

## Running the paired runs

```
node --import tsx scripts/benchmark-run.ts plan.json runs.json [--dry-run]
node --import tsx scripts/benchmark-analyze.ts runs.json
```

Separate the arguments with spaces only (in PowerShell a comma makes `runs.json, --dry-run` one argument). `--dry-run` needs only the plan file and prints the order drawn for each task (a coin per task from `seed`, written into `runs.json`) and runs nothing. The plan names one shell command for the plain arm and one for the Purix arm (the same agent and model; only Purix differs), and for each task a template folder, a prompt file, an acceptance command and a folder of hidden acceptance tests. Each arm works in a fresh copy of the template in a temp folder. The hidden tests are copied in only after the agent has finished, then the acceptance command runs: exit code 0 is "accepted". The agent can write `.purix-bench-result.json` (`{"costUsd":n,"interruptions":n}`) in its folder; what it does not write is recorded as not recorded, never as zero. `reviewDefects` is not measured by the runner; add it after an independent review.

What the runner does not do: it does not sandbox the agent (the command runs on this machine with this person's credentials), it does not choose tasks, and its own tests use a made-up agent, so they check the harness and produce no benchmark data. Until a person runs it with a real agent over enough tasks, there is no measured saving.

## Use

```
node --import tsx scripts/benchmark-analyze.ts runs.json [--json]
```

`runs.json`: `{"schema":1,"pairs":[{"task":"t1","plain":{"accepted":true,"costUsd":0.4,"seconds":300,"interruptions":2,"reviewDefects":1},"purix":{...}}]}`. Any field may be left out.

Until real paired runs exist, the dashboard keeps reading "Saving against a plain agent: not measured".
