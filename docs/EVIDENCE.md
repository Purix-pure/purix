# `purix evidence`

Evidence a reviewer can check without trusting Purix and without reading the session.

## Commands

All three read the store and never write it. They call no model and no network.

| Command | What it does |
|---|---|
| `purix evidence export [--out file]` | The audit chain plus a per-component summary, as JSON (`purix.evidence/1`). Contains audit record payloads: read it before you share it. |
| `purix evidence report [--out file]` | A Markdown report for a pull request: result, what was verified, what was not, chain head. |
| `purix evidence trailer [--message-file file]` | Git trailer lines. With `--message-file` they are written into that commit message (replacing older Purix trailers). Refuses when the chain is not intact. |

Trailers:

```
Purix-Evidence: sha256:<chain head hash>
Purix-Records: <number of chain records>
Purix-Verified: pass | skipped | fail | not-applicable
Purix-Not-Tested: <n> file(s)        (only when files compiled but nothing exercised them)
```

A commit hook that adds them: `purix evidence trailer --message-file "$1"` in `.git/hooks/commit-msg`.

## Checking without Purix

`packages/cli/verifier/purix-evidence-verify.mjs` imports only Node built-ins and shares no code with Purix. Copy it anywhere.

```
node purix-evidence-verify.mjs bundle.json --commit HEAD --require-anchor
node purix-evidence-verify.mjs bundle.json --expect-head <64 hex characters>
```

| Output | Exit | Meaning |
|---|---|---|
| `VERIFIED` | 0 | The chain is intact and contains the committed head, so nothing before that point was altered or removed afterwards. |
| `CONSISTENT, NOT ANCHORED` | 0 (1 with `--require-anchor`) | The chain is internally consistent, but its newest records could have been cut off, or the whole chain rebuilt. Not a pass. |
| `FAILED` | 1 | A record was altered, removed, or the committed head is not in the chain. |
| (message only) | 2 | Could not run: unreadable bundle, bad option, commit without a trailer, git missing. |

## What this does not show

- That the tests were meaningful, or that the code is correct.
- Who wrote a given line. (Agent Trace attribution is a later stage.)
- The per-component table in the bundle is not covered by the hashes. Only the chain is.
- Someone who can rewrite the whole local store can rebuild the whole chain. The head hash in a pushed commit is what makes that visible. A hash chain cannot show that its newest records were cut off without such an external anchor.

## Fixed findings and their limits

These are fixes made after the security review. Each is backed by a test in the repository, none has been re-run by a second person yet, and each states what it does not cover.

A cloned repository could supply Purix's tool records and tool binaries from its own .purix/tools folder, and a record's binary path could point outside its tool folder. Tool state now lives in the user's folder, keyed per project, and unsafe binary paths are refused. The project's own node_modules tools (tsc, eslint, the test runner) are still used first and run isolated, so this covers Purix's own tools only. Tested on Linux only.

The notification webhook was signed with a literal default secret when none was configured, so anyone could forge the signature. With no secret set, nothing is sent. The secret is still a shared key; this does not authenticate the receiver.

A diff hunk that is not at its stated line is applied only where its old side matches in exactly one place in the whole file; there is no fixed distance limit. A repeated block anywhere makes a shifted hunk fail instead of guess. A replay of 150 recent commits each from express, click and execa (1,933 modified files, headers shifted up to 300 lines) applied 0 hunks wrongly and refused 4 per shifted size, all of them repeated or too-small blocks; the full 450-commit corpus is still not rebuilt.

A diff may delete files of the component it is ingested against: the deleted file is removed from the verification copy, the writer re-checks that it still holds what was verified before removing it, the journal marks it deleted so a crash can be recovered either way, and the change always needs a person's confirmation. It has been exercised with stand-in language providers and a real store; no real agent has sent one.

A blank context line whose leading space was stripped is read as a blank context line while the hunk header still expects lines, and a diff cut off in the middle of a hunk is refused instead of applied as a shorter hunk. A hunk that has to be moved away from its stated line needs at least 3 old-side lines, not all blank. Only the last hunk of a diff is held to its header's line counts, since a cut-off can only be short at the end; a header that miscounts earlier in the diff is recounted from the lines that are there. The replay corpus was not rebuilt, so the share of real diffs this refuses is unmeasured.

## Oct 15 fixes, now listed

A custom model-provider block that arrives with a project is refused and nothing is sent until the person accepts it, and an accepted endpoint is not accepted for a different key variable or address. The trust record lives in the person's own folder; a trust list inside the project does not count. This covers the provider block only, not what a model returns.

The verification copy leaves out .env and .git, and secrets, config and the manifest. This is a copy-scope rule; a file the project's own tests read from outside the copy is not covered.

A corrupt state file, such as a provider config, is set aside as a copy before it is replaced, and the quarantine step never throws for a missing file. This keeps the evidence of what was there; it does not repair the file.

Each audit append writes a receipt holding the newest head hash. Cutting the end off the chain is caught when the receipt is ahead of the chain; a receipt that is behind is fine, because a later append can race it. A chain with no receipt yet (an older install) reads as valid and says so.

Tools that Purix runs through its sandbox run with the project read-only and the network off, with one scratch folder writable that is not the project. This is checked on Linux only.

## Protected patterns and the outbound scrub

A project's dof-patterns.json adds to the built-in protected paths and never replaces them, and an empty list is refused and the built-in paths are used. The files that define the floor, dof-patterns.json, purix.config.json and the policy file, are always held as well. This decides which files always need a person; it does not cover a file that is not registered to a component.

An unquoted password in an env-file or shell style line, such as DB_PASSWORD=value or export PGPASSWORD=value, is redacted before text goes to a model provider when the value mixes letters and digits. Code that only mentions a password, such as a function call or a member access, is left alone so edits still match the file. A password made only of letters, or only of digits, is not caught, and neither is any format the list does not know.

## Added in the Nov 6 session

purix check fails when the audit head receipt is ahead of the audit chain, and an emptied chain with governed components is no longer reported as nothing to verify. Someone who can edit both the store and the receipt can still remove records without being seen here; the git anchor is the second line.

PURIX_MCP_AUTO_APPROVE=1 is ignored while PURIX_STRICT_ISOLATION is on: the normal prompt or pending approval runs and the refusal is recorded. Outside strict isolation the escape hatch works as before and is recorded as auto-approved.

A hunk is moved away from the line its header gives only when its old side has at least three non-blank lines, or sits flush against the start or end of the file. The number three is a pick from how git treats context, not a measured value.
