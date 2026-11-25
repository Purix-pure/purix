# Pull-request receipts

Decision (2026-11-24): a pull request carries **the commit trailer plus a redacted receipt**. The evidence bundle is handed over on request, not attached by default.

## Why

The record lives in the project's git folder, which `clone` and `push` do not carry, so a reviewer cannot read it. Three options were weighed:

| Option | Reviewer gets | Cost |
| --- | --- | --- |
| Trailer only | The chain head, nothing to read | Nothing to check against without the author |
| Trailer + redacted receipt (chosen) | The receipt lines and the chain head, with project, component, agent and file names replaced by aliases | The author pastes it; a reviewer cannot recompute the numbers |
| Bundle in the PR | Everything, verifiable with the standalone verifier | Commits file paths, prompts' metadata and cost to a repository others can read; hard to take back |

The bundle holds more than most people expect to publish, and a pull request is hard to scrub afterwards. So it goes to a named reviewer on request.

## How

1. Commit with the trailer: `purix evidence trailer` prints the `Purix-Evidence` line.
2. Paste the receipt: `purix receipt --redact` (or `--last 3`, `--out receipt.md`). It is read-only.
3. If a reviewer asks to check the chain: `purix evidence export`, send the bundle to that person, and they run the standalone verifier.

## What a receipt does and does not say

A pass means the checks named in it passed. It does not mean the code is correct or safe; costs are estimates; it covers only changes made through Purix. The chain head in the receipt and in the trailer should match; if the author's record was changed after the trailer was written, they will not.
