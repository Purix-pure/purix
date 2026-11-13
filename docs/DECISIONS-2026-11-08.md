# Decisions taken on 2026-11-08 (plan v4, section 5.2 and decision 3)

Decided by Mian. Each entry says what builds on it. Nothing here changes code; the sessions named below do that.

| # | Question | Decision | Built by |
| --- | --- | --- | --- |
| D-a | Should `purix check` also run the git anchor (F08-02)? | Yes. Report "skipped, with the reason" when the anchor commit is by a different machine; fail only when it is by this machine. | F08-02 session (post-release list, 6.3) |
| D-b | How does `purix status` show the index row (F05-09)? | Not as a component. Add a separate "indexed files" line. | F05-09 session (post-release list, 6.3) |
| D-c | Should MCP diff-ingest record `not_tested` and the cut flag? | Yes. See the finding below. | C3, item 5 |
| 3 | Agent writes of unadopted files (F00-07) | Allow, but name them in the result and in `purix check`. | C5 |

## D-c: why yes (read from the code, not run)

The plan says the MCP diff-ingest event "records neither `not_tested` nor the flag". Reading the code shows it is worse than a missing record:

1. `resolveVerification` (core/src/recovery/resolve_verification.ts, line 138) already records a `verification_pass` event with `not_tested` and the cut flag, using stage `mcp_ingest`.
2. The MCP `purix_ingest` handler then records a second `verification_pass` event (mcp-server/src/server.ts, near line 1753) with no `not_tested`.
3. `purix check` (entrypoints/check.ts, `verificationSection`), the evidence bundle (evidence/evidence.ts, `latestNotTested`) and `purix status` (manifest/not_tested.ts) all read the latest pass per component, and an event without `not_tested` deletes the earlier entry.

Expected effect: after an MCP diff-ingest, the untested files vanish from `check`, the evidence bundle and `status`, so "not tested" reads as "tested". That is the failure the honesty rule exists to prevent.

Not yet run: this is a reading of the code. C3 should reproduce it first (ingest through MCP a diff that leaves a file untested, then run `purix check`), write the failing test, then fix by either adding `not_tested` and the cut flag to the second event or removing the duplicate event. Expect `purix check` to report more after the fix; say so in the release note.

## Still open from section 1 of the status document

- CODEOWNERS (D1): needs a GitHub handle. `.github/CODEOWNERS` is unchanged, with its pattern lines still commented out.
- Two `server.json` files exist (root, listing `@purix/cli`; `packages/mcp-server`, listing `@purix/mcp-server`). `docs/RELEASING.md` names only the second. Both are now at 0.4.0-beta.0. Which one is the real registry listing is undecided.

## Built since (sessions of 2026-11-08 to 2026-11-11)

- C1 (secret formats), C2 (planted-tool replays), C3 (CLI and MCP output, including D-c), C4 (security gate) and C5 (decision 3) are built and tested on Linux with stubbed models. See the F-rows in `docs/claims.json` for each fix block and what it did not cover.
- C5 (decision 3): a write to a file no component governs is allowed and named: in the hook's stderr (exit 0, stdout empty), as an `unadopted_write` event, and in `purix check` ("Edits made outside Purix", outcome `skipped`, so `--strict` exits 1 until the file is adopted). A shell command that writes a file is not named.
- C4 follow-ups: shell scripts have their own three rules; advisories and the list of files the code rules did not read are stored on the `verification_pass` event and shown by `purix check`.

## Still open

- CODEOWNERS (D1): needs a GitHub handle.
- Which `server.json` is the real registry listing.
- Founder ratification of C1: the secret patterns that used to scrub only now also block a write.
- F03-03 (a check that a new package exists) needs a registry lookup and was not built.
- Release note: `purix check` reports more than before (untested files kept after an MCP ingest; ungoverned agent-written files as skipped).
- Not run anywhere: real bwrap, a real model or agent, Windows, macOS.
