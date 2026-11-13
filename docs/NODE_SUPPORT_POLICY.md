# Node.js support policy

What Purix declares, what CI runs, and what is not covered. This file describes the repository as it is; it does not promise a schedule.

## What is declared

All three packages and the repository root declare `"node": "^22.13.0 || >=24.0.0"` in `engines`. That means Node 22.13.0 or later on the 22 line, and Node 24 and up. Node 23 is not supported (it is an odd-numbered, non-LTS line). Node 22.12 and earlier, and Node 20 and earlier, are not supported.

`engines` is advisory by default: npm prints a warning and installs anyway unless the user has set `engine-strict`. The README says to check `node -v` before installing for that reason.

## What CI runs

`.github/workflows/ci.yml` runs the `validate` job on three Node versions:

| Leg | Why |
|---|---|
| `22.13.0` | The exact declared floor. Floor-only bugs are invisible on newer Node (a TAP-output bug at 22.13.0 was found this way). |
| `24` | An LTS line. It is written as `24`, not `lts/*`, because `lts/*` moved to 26 in October 2026 and would silently have dropped 24 from the matrix. |
| `latest` | Node's newest release. This is the only leg that runs Node 26 and later, so a breaking change in a new release shows up here before users hit it. There is no pinned Node 26 leg. |

`publish.yml` builds and publishes on Node 24.

## What is not covered

- Windows and macOS run in CI as `os-smoke` jobs that do not block a release. See [BETA_SCOPE.md](../BETA_SCOPE.md).
- Odd-numbered Node lines other than `latest` at the time CI runs are not tested.
- Node versions outside `engines` are not tested, and a bug that only appears there will not be fixed.

## Changing the floor

Raising or dropping a Node line is a change to `engines` in all four `package.json` files, to the `matrix.node` list in `ci.yml`, to the README and `SETUP.md`, and to this file, and it goes in the [changelog](./compliance/CHANGELOG.md) under "Changed". Until 1.0 it can happen in any `0.x` release.
