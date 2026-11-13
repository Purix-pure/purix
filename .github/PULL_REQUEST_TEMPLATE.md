## What this changes and why

<!-- One or two sentences. Link the issue if there is one. -->

## How it was checked

<!-- Say what you ran and what you did not. "Not run" is a fine answer. -->

- [ ] `pnpm run boundary-check`
- [ ] `pnpm run artifact-check`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run test`

## Checklist

- [ ] A user-visible change has an entry in `docs/compliance/CHANGELOG.md` under "Unreleased".
- [ ] A change to what is sent off the machine or stored on it is reflected in `PRIVACY.md`.
- [ ] A new environment variable is listed in `docs/ENVIRONMENT.md` (`pnpm run env-docs-check`).
- [ ] No edit to a sentence in `README.md` that is mapped in `docs/claims.json` without re-mapping it (`node scripts/check-claims.mjs`).
- [ ] No secrets, tokens or private code in the diff, tests or logs.

<!-- Security issues: do not describe an unfixed vulnerability here. See SECURITY.md. -->
