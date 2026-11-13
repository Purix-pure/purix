# Release readiness: 0.4.0-beta.0

Written 2026-11-11 from reading the repository and the npm registry. **Nothing was built or tested for this list**: no `pnpm install`, build, test run, `release-check` or CI flow was run. The only things run were the claims gate (`node scripts/check-claims.mjs`, also with `CI=1` so broken links fail), the checks-page staleness check, a script that compares versions across every `package.json`, `server.json` and the lockfile, and `npm pack --dry-run` in each package.

## Done in this pass

- **Versions.** All three packages, the root `package.json`, both `server.json` files and the `workspace:^` ranges (also in `pnpm-lock.yaml`) read `0.4.0-beta.0`. They already did; the only stale version strings were the `docker-compose.yml` image tags (`0.2.0-beta.0`), now fixed. Other JSON files (golden files, fixtures, manifests, claims, tsconfig) carry no Purix version, and `mutation.json` is a report, so none were changed.
- **Privacy policy** `PRIVACY.md` (new), written from the code: network egress, what is stored and where, secret redaction limits, telemetry (off by default, no upload in this version), how to delete.
- **Security policy** `SECURITY.md` rewritten (and its copy in `docs/compliance/`): supported versions, scope, documented limitations, how to verify a release. It makes no response-time promise.
- **README**: release status, privacy, support links. No existing sentence was edited, so the claims register still matches (149 rows, baseline unchanged).
- **Changelog** `docs/compliance/CHANGELOG.md`: the 0.4.0-beta.0 entry now says what changed, including the "`purix check` reports more than before" note that `docs/DECISIONS-2026-11-08.md` asks for.
- **Package files.** A `README.md` and `LICENSE` in each package (release-check requires a LICENSE in every tarball and there was none), plus `homepage`, `bugs` and `publishConfig` in each `package.json`.
- **Release pipeline bugs.** `publish.yml` runs `pnpm run ci-bypass-flow` and `pnpm run connect-harness`; neither script existed in `package.json`, so a tag push would have failed there. Both added. `@purix/cli` had a `build:bundled` script pointing at a file that does not exist; removed.
- **Missing docs.** `docs/NODE_SUPPORT_POLICY.md` was referenced by `SETUP.md` and `ci.yml` and did not exist; written. `SETUP.md`'s coverage command was out of date; replaced with `pnpm run coverage`.
- **`docs/RELEASING.md`** rewritten where it was wrong (see the next section).

## What the registry shows (this changes the plan)

`@purix/cli`, `@purix/core` and `@purix/mcp-server` are already on npm: `0.1.0`, `0.2.0-beta.0` and `0.3.0-beta.0` (published September 2026). `latest` points at `0.3.0-beta.0`. There is no `beta` tag. `RELEASING.md` assumed a first publish; it no longer does. Trusted publishing can be turned on now, and a pushed `v0.4.0-beta.0` tag can publish from CI with provenance.

## Blockers: only you can close these

1. **`NOTICE` has a placeholder and a garbled line.** It reads `Copyright 2026 [Your Legal Entity Name]` and `Purix (formerly Purix)`, and links `https://purix.org` while the code's API address is `api.purix.dev`. I need the legal name and the right domain. `NOTICE` is not shipped in the tarballs yet; once it is correct, copy it into each package next to `LICENSE` (Apache 2.0 section 4(d)).
2. **CODEOWNERS** (`.github/CODEOWNERS`) still has every pattern commented out because it needs a GitHub handle. It protects the hook, sandbox, gate and security code.
3. **Decide what npm `latest` should be.** After a `--tag beta` publish it stays on `0.3.0-beta.0`, which lacks all of this release's fixes. Move it, or leave it on purpose. Step 4 of `RELEASING.md`.
4. **Turn on trusted publishing** for the three packages (npm package settings), then push the tag. I could not check from here that `github.com/purix-pure/purix` exists and is public (the request returned 403 through the proxy); provenance and the MCP registry name `io.github.purix-pure/purix` both depend on it.
5. **Read `PRIVACY.md` and `SECURITY.md` as the person who answers for them.** The privacy policy covers the client in this repository. The hosted API's own data handling (account email, devices, savings records, retention, who runs it) is not in this repository, so the policy says to contact you for deletion. It names GitHub Discussions and the private advisory flow as the only contact channels. If there is a legal entity, an email address, or terms for the hosted service, they belong in it, and a lawyer should look at the hosted-service part.
6. **`docs/client-runs.json`** has `"version": "<the version text>"` in the one real OpenCode run. That is a placeholder recorded as data. Replace it with the real OpenCode version.

## Should be done before you announce

- **Run the gates.** `node scripts/release-check.mjs full --tag v0.4.0-beta.0` (about 6 minutes), then the clean-machine install on Linux, macOS and Windows PowerShell. Every step must be PASS; the script lists nine items it can never check itself (other operating systems, real sandbox, real model, real agent, SBOM, rollback rehearsal, provenance after publish, stale documents).
- **Regenerate `docs/CLIENT_SUPPORT.md`.** It is generated and records a harness run at `0.3.0-beta.1`, a version that was never published: `pnpm run build && node scripts/connect-harness.mjs --table docs/CLIENT_SUPPORT.md`.
- **MCP registry listing.** Two `server.json` files exist. I recommend publishing the root one (it lists `@purix/cli`, which is what users run); `@purix/mcp-server` has no `bin`, so its listing cannot be started. `RELEASING.md` now says so. Decided 2026-11-11 (D-h): the root listing is the one, and `packages/mcp-server/server.json` is deleted.
- **Founder ratification of C1**: the secret patterns that used to only redact now also block a write (`docs/DECISIONS-2026-11-08.md`). The changelog states it; nobody has signed it off.
- **Real-agent runs.** One run is on file (OpenCode, Windows). Claude Code and Codex are the next planned runs; the README wording stays "reported, not settled" until then.
- **Free-tier limit.** The client enforces 25 tracked components and there is no way to lift it. `BETA_SCOPE.md` calls it a rough edge. Decide whether that is acceptable for a public beta.
- **Stale document.** `release-check` lists `docs/TESTING_ARCHITECTURE_REPORT_2026-09-07.md` as needing a manual review. I did not review it.
- **Internal documents in a public repository.** `PURIX-33-LIVE-REPORT.md`, `docs/research/`, `docs/DECISIONS-*`, `docs/PLAN-V4-*` and the ADR drafts are visible to anyone who can read the repo. They are not in the npm tarballs. Decide whether that is intended.

## Not blocking, and not done

- Post-release items in `docs/DECISIONS-2026-11-08.md`: D-a (git anchor in `purix check`) cannot be built as worded, F03-03 (does a new package exist) needs a registry lookup.
- Root `package.json` has `"main": "index.js"`, an empty `author` and empty `keywords`. It is `private`, so none of this is published.
- `docs/compliance/` keeps two copies of some files (`SECURITY.md`, `CONTRIBUTING.md`, ISO and EU AI Act folders). They can drift; `SECURITY.md` was synced in this pass. **[11-12]** The five pairs that are byte-copies (scope, lifecycle controls, data and dependency governance, technical documentation, post-market monitoring) are now checked by `scripts/check-claims.mjs` (check 7); the top-level data-and-dependency copy had drifted and was resynced. `SECURITY.md` and `CONTRIBUTING.md` differ on purpose (relative links) and are not checked.
