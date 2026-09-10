# Contributing to Purix

Thanks for taking a look. This document covers the practical stuff: how to
get set up, what CI actually checks, and the conventions this codebase
already follows that a PR is expected to follow too.

## Setup

See [SETUP.md](./SETUP.md) for the full local development walkthrough. The
short version:

```bash
npm install
npm run boundary-check
npm run typecheck
npm run test
```

Node >= 22.13.0 and npm >= 10.0.0 (npm ships with Node — no separate install
needed).

## Before opening a PR

Run the same four checks CI runs on every PR:

```bash
npm run boundary-check   # packages/core must never import from packages/cli or packages/api
npm run artifact-check   # no leftover toolchain/build artifacts committed outside .purix-tmp/
npm run typecheck        # tsc --noEmit across all three packages
npm run test             # the full test suite — 386 tests as of this writing
```

All four have to pass before a PR can merge — `.github/workflows/ci.yml` enforces
this. Running them locally first saves a round trip.

## Conventions this codebase already enforces — please match them

- **Real integration over mocks, where it matters.** Several test files
  (`config_hot_reload.test.ts`, `scheduler.test.ts`, `budget_worktree.test.ts`)
  deliberately spawn real, separate OS processes instead of mocking
  `child_process` — the whole point of those tests is proving behavior that
  only shows up across genuinely separate processes (crash recovery, file
  locking, hot config reload). If you're touching that kind of code, keep
  that discipline; don't "simplify" it into an in-process mock.
- **The core/cli/api boundary is a hard rule, not a style preference.**
  `packages/core` must never import from `packages/cli` or `packages/api`.
  `npm run boundary-check` enforces this by scanning for both
  package-specifier imports and relative-path escapes. If your change needs
  core to know something cli-specific, that's a sign the abstraction belongs
  in core instead, not that the check should be loosened.
- **`noUncheckedIndexedAccess` is on, deliberately.** Array indexing types as
  `T | undefined`, always. Don't reach for `as T`, `!`, or `// @ts-ignore` to
  make an error go away — narrow it for real (a destructure + explicit
  `if (!x) throw`, or an explicit length/bounds check). This flag exists to
  catch a real class of bug; suppressing it locally defeats the point.
- **TypeScript and Python only, for now.** See [BETA_SCOPE.md](./BETA_SCOPE.md)
  for why Rust/Go/Ruby support was removed rather than just gated off, and
  what re-adding a language actually involves.
- **Test-support helpers over duplicated inline logic.** If you find yourself
  copy-pasting the same "find a real local binary" or similar setup logic
  into a third test file, it probably belongs in
  `packages/core/src/test-support/` instead — see
  `real_node_modules.ts` for the existing pattern (and the npm-vs-pnpm
  hoisting bug it exists to avoid repeating).

## Filing issues

Bug reports are most useful with: the exact command you ran, the full error
output (not a paraphrase), and your Node/npm versions (`node -v && npm -v`).
For anything involving the sandboxed verification step, whether the target
project itself uses npm, yarn, pnpm, or bun also matters — several past bugs
in this codebase were specific to one package manager's `node_modules`
layout.

## Security issues

Please don't open a public issue for a security vulnerability. See
[SECURITY.md](./SECURITY.md) for how to report one privately.

## License

By contributing, you agree your contributions are licensed under this
repository's [Apache 2.0 license](./LICENSE).
