# Privacy

**Applies to:** the Purix software in this repository (`@purix/core`, `@purix/mcp-server`, `@purix/cli`), version `0.4.0-beta.x`.
**Last updated:** 2026-11-11.

Purix runs on your own machine. This document says what the software sends off that machine, what it keeps on it, and how you control both. It was written from the code, and where the code leaves a gap it says so. If the code and this document disagree, the code is right and the document is a bug: please [open an issue](https://github.com/purix-pure/purix/issues).

## In short

- Everything in this repository runs without a Purix account. No sign-in is needed to check, verify or change code.
- Purix's own code makes network requests to only three kinds of place, all through one file (`packages/core/src/platform/net.ts`): **the model provider you choose**, **a webhook URL if you set one**, and **the Purix API if you run `purix login`**.
- The text of the files Purix is working on goes to your model provider. That is the main thing that leaves your machine. It does not go to Purix.
- `purix check` makes no network request at all.
- Usage-data sharing is **off by default**, and upload is **not part of this version**: nothing is sent whether it is on or off.
- This repository contains no advertising code and no analytics upload. The only usage record is the local ledger described under [Usage data](#usage-data-telemetry).

## What leaves your machine

| Where | When | What is sent | What is not sent |
|---|---|---|---|
| **The model provider you choose** (Anthropic, OpenAI, Gemini, or a custom OpenAI-compatible address) | Whenever Purix calls a model: classify, modify, create, repair, escalate | A prompt built from your request, the text of the files being changed, test or compiler output, a small slice of the project's own `AGENTS.md`, `CLAUDE.md` or `GEMINI.md` if one exists, and, when Purix escalates a failure, text from neighbouring components. Your provider API key, in the request header. | Files unrelated to the change. Purix does not send the whole repository. |
| **A webhook** | Only if you set `PURIX_WEBHOOK_URL` and a signing secret, when a change is waiting for confirmation | A short JSON notice: the kind of checkpoint, the component id, and a message. It is signed with your secret. With no secret configured, nothing is sent. | Code, diffs. |
| **The Purix API** (`https://api.purix.dev` unless you set `PURIX_API_URL`) | Only after you run `purix login` | Your email address and the one-time code you type; a random machine id and your computer's host name, so the server can list and revoke the device; session and refresh tokens; requests for your plan's entitlements; and savings records (see below). | Source code, file names, prompts, replies, git remotes. |
| **The package registry and OSV database** | Only when you run `purix audit` | Whatever your package manager (and `pip-audit` for Python) sends for an audit. Purix runs those programs; it does not control their requests. | |
| **Download hosts for tools** | Only when you approve `purix tools install <tool>` | A download of a pinned tool, checked against a recorded hash. | |

**Savings records** (only when signed in): the machine id, a random per-install project alias (not derived from your repository's name, path or git remote), and for each model call a sequence number, a timestamp, the call type and the dollar amount saved.

**Use a local model and the first row stays on your machine.** A custom provider address on `localhost`, a private network or a single-label host (for example Ollama or LM Studio) is allowed over plain `http`. Purix refuses plain `http` to a public host, because the request would carry your key and prompt unencrypted.

### Secrets in prompts

Purix scans a proposed change for secrets before it verifies it, and redacts known secret formats from every prompt before it is sent to the provider, and from every reply it receives, including the files of the component being changed. **The scanner recognises only some secret formats.** A secret in an unknown format, or one that is split or encoded, is sent as it is. Keep real credentials out of files you ask Purix to work on, and read your provider's own data policy: what the provider does with a prompt is governed by that provider, not by Purix.

### Coding agents you connect

When a coding agent is connected through MCP, what Purix returns to it (including repository text in results) goes to that agent and to whatever model provider the agent uses. Purix does not control that. Results that can include repository text end with a note that the text is data, not instructions.

## What Purix stores on your machine

Nothing below is uploaded by Purix.

| Where | What |
|---|---|
| `<project>/.purix/` | Configuration, the provider choice, an encrypted store of secrets you save with `purix secret-set`, a notes log (`memory/log.jsonl`), locks, and the component list. Disposable files (language toolchains, caches) are under `.purix/tmp/`. |
| `<project>/.git/purix-state/` | The manifest database (components, classifications, confirmations, verification results, the audit trail), the model-call log, and the budget ledger. Because it sits inside `.git`, `clone` and `push` do not carry it. |
| `~/.purix/` | Your session (if you signed in), the machine id, usage counts, the telemetry choice, diagnostic logs, and installed tools (`~/.purix/tools/`). |
| Your system's temporary folder | A short-lived copy of your project that a change is verified in, deleted after each run. It leaves out `.git`, `.env*`, `node_modules` and the secrets and state files under `.purix`. |

Things worth knowing about these files:

- **The model-call log stores no prompt or reply text.** It records sizes, tier, timing, cost, a status, and the one-word operation label the model chose. A test checks this with a marker string.
- **The audit trail records decisions and results**, such as classifications, who confirmed a change and what was verified. It is not a copy of your prompts.
- **The notes log can end up in your repository.** `.purix/memory/log.jsonl` is in the working tree, so it can be committed, and its notes are placed into later prompts. Known secret formats are removed from a note before it is written. Do not put anything private in a note you would not commit.
- **Saved secrets are encrypted at rest, but the key sits next to the file.** The master key is created beside the encrypted store with owner-only permissions. That stops an accidental commit or a casual read; it does not protect against someone who can read your user folder. The OS keychain is the usual answer and is not used yet. Purix keeps these files out of version control and out of the verification copy.
- **Diagnostic logs** in `~/.purix/logs/` hold error messages, stack traces (which can contain file paths) and the Purix version. They stay on your machine and files older than 7 days are deleted.
- **Hook payload logging is off by default.** If you set `PURIX_HOOK_PAYLOAD_LOG` to a file path, hook calls and answers are appended to that file. That is for recording real-agent test runs.

## Usage data (telemetry)

- **Sharing is off by default.** You turn it on only with `purix telemetry enable`. `DO_NOT_TRACK` and a CI environment turn it off regardless.
- **Upload is not part of this version.** `purix telemetry status` says so. Turning telemetry on does not send anything in `0.4.0-beta.0`.
- **A local ledger is always kept** in `~/.purix/usage-ledger.jsonl` for `purix stats`, for up to 90 days. Each row has only a UTC day (no time of day), an event name, a short code from a closed pattern (a command name, an exit word, a duration bucket, a gate or tool decision, an error code) and a count. It has no free-text field, so a path, a prompt or source code cannot be written to it.
- **See exactly what would be shared:** `purix telemetry show` prints the payload. It contains a random install id (not linked to your email or account), the client version, your operating system name, and the aggregated ledger rows.
- **Reset or erase:** `purix telemetry reset` makes a new install id. `purix telemetry forget` turns telemetry off, deletes the ledger and resets the id.

If a later version adds upload, this document will change first and the release notes will say so.

## Your choices and how to delete your data

| You want to | Do this |
|---|---|
| Keep prompts on your machine | Use a local model server as a custom provider. |
| Stop all contact with the Purix API | Do not run `purix login`, or run `purix logout`. |
| Remove the stored session | `purix logout`. |
| Remove usage counts and the install id | `purix telemetry forget`. |
| Remove a project's Purix data | Delete `<project>/.purix/` and `<project>/.git/purix-state/`. Export anything you need first; the audit trail lives there. |
| Remove all machine-wide data | Delete `~/.purix/`. |
| Remove tools Purix installed | `purix tools remove <tool>`, or delete `~/.purix/tools/`. |

Data held by the Purix API about an account (your email, devices, plan, savings records) is held by the hosted service, which is a separate closed-source system and is not part of this repository. To ask what it holds or to have it deleted, [contact us](#contact) and say which email address you signed in with.

## Children

Purix is a developer tool and is not directed at children.

## Changes to this document

Changes are made in this repository and visible in its history. A change to what the software sends or stores is listed in the [changelog](./docs/compliance/CHANGELOG.md).

## Contact

- Questions about this document: [GitHub Discussions](https://github.com/purix-pure/purix/discussions).
- A privacy problem you would rather not post publicly, such as data that should not have left a machine: use the private reporting flow described in [SECURITY.md](./SECURITY.md).
