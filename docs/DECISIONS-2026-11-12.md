# Decisions of 2026-11-12 (D-q, D-r, D-s, F03-08)

Written after checking research 03 in this repository and the OSV documentation. Each decision is final for the beta and names what would reopen it.

## D-q: network lookup of added dependencies. DECIDED: build it, opt-in, default off.
- What research 03 (3.1, 3.4) asks: look up only the (name, version) pairs a change adds; say "not checked" when no source answers.
- What the OSV documentation says (checked 2026-11-12): `POST https://api.osv.dev/v1/querybatch` with `{queries:[{package:{name,ecosystem},version}]}`; results come back in input order and hold only `id` and `modified`; replies are paginated with `next_page_token`; up to 1000 queries per batch; no key. Malicious-package records carry `MAL-` ids.
- Why opt-in: the lookup sends package names off the machine; ADR-009 keeps the network out of the gate; it has never run against the real services (this workspace cannot reach them). Why not "never": without it a change that adds a vulnerable or invented package reads as "not checked" forever.
- How: `PURIX_DEP_LOOKUP=osv|registry|all`. New egress purpose `dependency-lookup` in `platform/net.ts` (8 s timeout). The caller awaits `prefetchDependencyLookup` in `resolveVerification`; the synchronous gate reads the cache. Anything that fails is "not checked".
- Privacy rules built in: only names and exact versions leave; a name that resolves to a private registry (`registry=` or `@scope:registry=` in `.npmrc`) is never sent to OSV; a registry URL in the repository that is not https or points at a loopback, private or link-local address is not used (a cloned repository must not make Purix call internal services).
- Reopen after: one real-machine run. Then decide whether `registry` becomes default-on (it carries the same names the install sends anyway).

## D-r: should a known advisory block? DECIDED: no, with one exception.
- An ordinary advisory (GHSA, CVE) is reported (Medium) and never blocks: there is no severity rule and no override path designed for it yet.
- A malicious-package record (`MAL-` id) blocks (High). There is no good reason to add a package that is itself malware, and the existing audited override lifts it. Not verified: whether OSV omits withdrawn records from `querybatch`, so a withdrawn record could cause a false block.
- A name the registry does not have, and a name first published under 7 days ago, are reported (Medium), not blocked.

## D-s: Go, Rust, Ruby, PHP, HTML, Makefile. DECIDED: keep reading them with the JavaScript rules and keep listing them as weaker.
- Research 03 (1.2) wants unknown types reported as "not scanned", never silently skipped. The current behaviour reads them and lists them as weaker, which meets that. Skipping them would let a renamed file bypass the scan. No code change.

## F03-08: what a tripwire hit does over MCP. DECIDED: raise scrutiny, do not refuse.
- Research 03 (5.1): the phrase list caught 7 of 18 attacks and flagged 3 of 5 legitimate texts, so it is a tripwire. Before, `purix_modify` and `purix_ingest` refused any component that merely contained a flagged phrase and asked nobody.
- Now: the change is built, the trust decision is raised to "a person must approve" with the phrase and file named, and an `injection_flag` event is written. With `PURIX_MCP_AUTO_APPROVE=1` nobody would be asked, so the refusal stays there (fail closed).
- Not done: tuning the phrase list.
