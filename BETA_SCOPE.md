# Beta scope: supported languages

**Decision (2026-09-05):** Purix beta ships with **TypeScript and Python** support.
Rust, Go, and Ruby provider code has been removed from this release entirely — not
just gated off — to minimize the surface area of the first public/beta build.

## Why Python, not the others

The codebase already drew this line before this decision made it explicit:

- `language/registry.ts` treats TypeScript and Python as `publicProviders`, exposed
  with no flag. Rust/Go/Ruby lived in `internalProviders`, behind
  `PURIX_INTERNAL_LANGUAGES` — off by default, never shipped to end users.
- `licensing/tier.ts`'s entitlements fallback (used when the server response omits
  an explicit `allowedLanguages`) already treats Python as the natural next
  language for any paying tier (`["typescript", "python"]`), while Rust/Go/Ruby
  required deliberate inclusion in Pro's `allowedLanguages` — a separate, further
  gate.
- Python's provider went through the same toolchain-isolation bug-fixing pass as
  Go and Ruby in the late-August architecture review; Rust did not.
- Python has a real, currently-passing test suite (provider + audit tests) of
  comparable depth to what Go/Ruby had.

## What was removed

- `packages/core/src/language/providers/{go,ruby,rust}.ts` and their
  `.test.ts` / `.audit.test.ts` / `.pack.ts` files
- `packages/core/src/language/conformance/fixtures/go/`
- References in `language/registry.ts`, `language/conformance/run.ts`, and
  `licensing/tier.ts`'s `PRO.allowedLanguages`

## Re-adding a language later

`registry.ts` keeps the `internalProviders` / `internalPacks` extension points
(currently empty) specifically so this isn't a redesign later: write the
provider, register it there, gate it behind `PURIX_INTERNAL_LANGUAGES` until
it's certified for public release, then promote it to `publicProviders`/
`publicPacks` the same way Python was promoted before this document existed.
