# Release checklist for a software package like Purix

What a public release of a developer tool needs, and where Purix 0.4.0-beta.0 stands on each item as of 2026-11-11.

Status key: **Done** (already in the repository), **Added** (written in the 2026-11-11 pass), **You** (needs a decision, a name, an account or a click from the owner), **Machine** (needs a real run on a real system), **Later** (not needed for a beta).

## 1. Legal and ownership

| Item | Status | Notes |
|---|---|---|
| Open-source licence file | Done | Apache 2.0 in `LICENSE`; now also in each package. |
| NOTICE file with correct owner | **You** | **[11-13]** The garbled "(formerly Purix)" line is fixed and the link now points at the GitHub repository. The copyright line reads "Purix contributors" because there is no legal entity yet (decided 2026-11-13). Change it when one exists, then copy `NOTICE` into each package. |
| NOTICE shipped in each package | Added | **[11-13]** `NOTICE` is in each package and listed in each `files`; `release-check` requires it in the tarball and equal to the root copy. If `NOTICE` changes, run `for p in core mcp-server cli; do cp NOTICE packages/$p/NOTICE; done`. |
| Third-party licence check | **Machine** | Run a licence scan on production dependencies (for example `pnpm licenses list --prod`). Not run. |
| Trademark and name clearance | **You** | Check "Purix" against registered marks and the npm and GitHub names before wide announcement. |
| Terms for the hosted service | **You** | Not in this repository; needed before anyone pays or signs in at scale. |

## 2. Versioning and packaging

| Item | Status | Notes |
|---|---|---|
| One version across all packages | Done | `0.4.0-beta.0` in every `package.json`, the root `server.json`, and the lockfile ranges. |
| Prerelease published under a `beta` tag | Done (in CI) | `publish.yml` derives the tag from the version. |
| `latest` tag decided | **You** | Points at `0.3.0-beta.0` today. See `RELEASING.md` step 4. |
| Per-package README, LICENSE, metadata | Added | |
| Tarball contents checked | **Machine** | `release-check` checks it after a build. `npm pack --dry-run` already shows the right files before the build. |
| Engines and Node policy | Added | `docs/NODE_SUPPORT_POLICY.md`. |
| Only runnable listing in the MCP registry | Done | Publish the root `server.json`. `packages/mcp-server/server.json` was removed on 2026-11-11 (D-h): `@purix/mcp-server` has no `bin`, so its listing could not be started. |

## 3. Security

| Item | Status | Notes |
|---|---|---|
| Vulnerability reporting policy | Added | `SECURITY.md`, private reporting link. |
| Private reporting enabled on GitHub | **You** | Repository Settings, Security, "Private vulnerability reporting". The links in `SECURITY.md` do nothing until it is on. |
| Known limitations written down | Added | In `SECURITY.md` and `BETA_SCOPE.md`. |
| Dependency vulnerability audit | **Machine** | `pnpm audit --prod --audit-level high` (part of `release-check`). Not run. |
| Dependabot | Done | `.github/dependabot.yml`. |
| Code-owner review on sensitive code | **You** | **[11-13]** `.github/CODEOWNERS` now names `@purix-pure` on every rule (check that GitHub accepts it: an owner must be a user or a team). Still to do: branch protection with "Require review from Code Owners". |
| Secrets scan of the repository and history | **Machine** | Run a scanner (gitleaks or similar) before the repository goes public. Not run. |
| Branch protection on `main` | **You** | Require the `validate` job, no force-push. |
| Signed or provenance-backed releases | **You** | Needs trusted publishing turned on in npm. |

## 4. Privacy

| Item | Status | Notes |
|---|---|---|
| Privacy policy | Added | `PRIVACY.md`. |
| Telemetry off by default and documented | Done | `purix telemetry`; no upload in this version. |
| Hosted-service data handling | **You** | Account data lives in the closed API; needs its own policy and a deletion route. |
| Legal review | **You** | Especially for the hosted-service part. |

## 5. Documentation

| Item | Status | Notes |
|---|---|---|
| README with install, quick start, limits | Done, updated | |
| Scope and honest limits | Done | `BETA_SCOPE.md`, `docs/WHAT_PURIX_CHECKS.md`. |
| Environment variables list | Done | `docs/ENVIRONMENT.md`, enforced by a script. |
| Changelog | Added | Root `CHANGELOG.md` points to `docs/compliance/CHANGELOG.md`. |
| Release notes | Added | `docs/RELEASE_NOTES_0.4.0-beta.0.md`, ready to paste into a GitHub release. |
| Contributing guide | Done | `CONTRIBUTING.md`, `SETUP.md`. |
| Per-agent client support table | **Machine** | `docs/CLIENT_SUPPORT.md` was generated at an unpublished version; regenerate. |
| Stale documents reviewed | **You** | `docs/TESTING_ARCHITECTURE_REPORT_2026-09-07.md`. |

## 6. Community and support

| Item | Status | Notes |
|---|---|---|
| Code of conduct | Added | `CODE_OF_CONDUCT.md`. |
| Support document | Added | `SUPPORT.md`. |
| Issue templates | Done | Bug and feature templates; blank issues disabled. |
| Pull request template | Added | `.github/PULL_REQUEST_TEMPLATE.md`. |
| GitHub Discussions enabled | **You** | Issue config and docs link to it; it must be switched on. |
| Repository description, topics, social image | **You** | Set in the GitHub repository settings. |

## 7. Quality gates

| Item | Status | Notes |
|---|---|---|
| Full test suite, typecheck, lint | **Machine** | Not run in this pass. |
| `release-check full --tag v0.4.0-beta.0` | **Machine** | About 6 minutes. Every step must be PASS. |
| Coverage gate (90%) | **Machine** | `pnpm run coverage`. |
| Language conformance suite | **Machine** | |
| Hook, lock, bypass and connect flows | **Machine** | `ci-hook-flow`, `ci-lock-flow`, `ci-bypass-flow`, `connect-harness`. The last two scripts were missing from `package.json` and were added. |
| Claims gate and checks page | Done | Run in this pass; both pass. |
| Windows and macOS runs | **Machine** | Experimental until run. |
| Real model and real coding agent runs | **Machine** | One OpenCode run on file; Claude Code and Codex next. |
| Real sandbox (bubblewrap) run | **Machine** | |
| Clean-machine install from the registry | **Machine** | `npx @purix/cli@beta --help` on Linux, macOS, Windows. |

## 8. Distribution

| Item | Status | Notes |
|---|---|---|
| CI publish workflow with gates | Done, fixed | Missing scripts added. |
| Trusted publishing on the three npm packages | **You** | |
| GitHub release with notes | **You** | Create from tag `v0.4.0-beta.0`; paste the release notes file. |
| MCP registry entry | **You** | `mcp-publisher publish` from the repository root. |
| Container image | Later | `Dockerfile` and `docker-compose.yml` exist; image tag updated. Not published anywhere. |
| SBOM attached to the release | **Machine** | Not produced by any script yet. |

## 9. Launch and after

| Item | Status | Notes |
|---|---|---|
| Rollback plan | Done | `npm deprecate` and republish; written in `RELEASING.md`. Not rehearsed. |
| Who watches issues and security reports | **You** | Name a person and a rhythm; the docs promise no response time. |
| Announcement wording matches the evidence | **You** | Keep "reported, not settled" until real-agent runs are on file. |
| Feedback and bug triage routine | **You** | |
| Post-release items | Later | F03-03 package-exists check, D-a git anchor in `purix check`, free-tier limit. |

Open blockers and judgement calls are in [RELEASE_READINESS_0.4.0-beta.0.md](./RELEASE_READINESS_0.4.0-beta.0.md).
