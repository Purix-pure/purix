---
description: Run the Purix release checks (fast or full) and explain the result in plain words
---
Run the Purix release check for me. Mode: $ARGUMENTS (use "fast" if I gave nothing; "full" means the finalization check).

Do exactly this:

1. Run `node scripts/release-check.mjs $ARGUMENTS` from the repo root. Do not edit any source files, do not run `npm publish` or `pnpm publish`, do not create git tags, and do not delete anything outside `.release-check/`.
2. Read `.release-check/report.md`.
3. Answer in short, plain sentences, no jargon: first the verdict in one line, then a list of what failed (one line each: what broke and why it matters), then what still needs a human (the NOT CHECKED items).
4. Never say "passed" or "finalized" for anything marked FAIL or NOT CHECKED. If a step could not run, say it could not run.
5. If something failed, propose the smallest fix for each failure and ask me before changing any file.