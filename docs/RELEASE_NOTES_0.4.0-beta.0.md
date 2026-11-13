# Purix 0.4.0-beta.0

A beta for TypeScript, JavaScript and Python, run on your own machine. Requires Node.js 22.13 or later (or 24+).

```bash
npm install -g @purix/cli@beta
purix --help
```

Results are reported, not settled. Windows, macOS and Cursor are experimental, and one real coding agent run is on file (OpenCode, Windows). Read [BETA_SCOPE.md](https://github.com/purix-pure/purix/blob/main/BETA_SCOPE.md) for what Purix checks and what it does not.

## Read before upgrading

**`purix check` reports more than before.**
- After an MCP diff-ingest, files left untested stay listed as "not tested" in `purix check`, the evidence bundle and `purix status`. Before, they could disappear and read as tested.
- A write by an agent to a file no component governs is allowed and named in `purix check` ("Edits made outside Purix", outcome `skipped`). With `--strict`, `purix check` exits 1 until the file is adopted.

**`purix index` no longer verifies each file.** It lists files and records symbols as `pending` (`verification: "not_run"`).

**Secret patterns now block.** The secret formats that used to be redacted from prompts also block a write that contains one, and more formats are recognised.

## What is new

- Privacy policy ([PRIVACY.md](https://github.com/purix-pure/purix/blob/main/PRIVACY.md)) and a rewritten security policy ([SECURITY.md](https://github.com/purix-pure/purix/blob/main/SECURITY.md)).
- Shell scripts have their own security-gate rules; advisories and the files the code rules did not read are shown by `purix check`.
- Flaky-failure baseline compare for TypeScript in the sandbox path.
- A README and LICENSE in each npm package.

Full list: [changelog](https://github.com/purix-pure/purix/blob/main/docs/compliance/CHANGELOG.md).

## Known limits

- Tested on Linux with stubbed models. Not run with a real model, bubblewrap, Windows or macOS.
- Hooks are a tripwire, not a security boundary. Isolation is described for TypeScript on Linux with bubblewrap only.
- The free tier limit of 25 tracked components is enforced and cannot yet be lifted.
- `purix audit` can report nothing for pnpm projects that have known advisories.

## Feedback

Bugs: [Issues](https://github.com/purix-pure/purix/issues). Questions: [Discussions](https://github.com/purix-pure/purix/discussions). Security: [private report](https://github.com/purix-pure/purix/security/advisories/new).
