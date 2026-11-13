# IDEA-090 new-project flow: checklist against the code (2026-10-15)

Status is what is in the tree, checked by reading code and running tests on Linux. "Not built" means no code exists; it is not a failing test.

| # | IDEA-090 line | Status | Evidence |
|---|---|---|---|
| 1 | Detect language from markers; one found = use and say so; none = ask; no silent default | Built, tested | `greenfield_preflight.test.ts`: "uses the language set in config", "follows the one language the folder already has, and says so", "does not guess in an empty folder...", "asks at a terminal, saves the answer", "when two languages are present, asks between those two only" |
| 2 | Picker lists only supported languages / refuses tier-locked ones | Built, tested | same file: "marks a language the tier cannot use, and refuses it without saving" |
| 3 | Tool check before any model call; read-only; ask once; installs go through the broker | Built, tested | same file, group "the type checker" (4 tests) and "provider first" |
| 4 | Plan prerequisites (e.g. @types/node) reported before approval and before anything is written | Built, tested | same file, group "plan prerequisites" |
| 5 | Approver bootstrap announced before the approval prompt | Built (message in `lifecycle.ts`), **no test of the wording** | not mapped |
| 6 | Bare `purix` prints "Start here" | Built, tested | `first_run.test.ts`, `cli.integration.test.ts` ("Start here:" present on bare run, absent on `--version`) |
| 7 | `connect` with nothing detected lists agents | Built, tested | `connect.empty_folder.test.ts` |
| 8 | MCP path returns structured "language needed" / "tools missing" instead of prompting | **Not found** in `mcp-server/src` (searched for both phrases) | open |
| 9 | Plan file `.purix/plan.md`, approval = sha256 in the audit chain, nothing scaffolded before approval | **Not built.** IDEA-090 says the format "becomes Type 1" and asks the founder to ratify first | needs your yes |
| 10 | Slug naming and filler stripped from intents (`build-website-me-which`) | **Not fixed.** The component id comes from the model's plan (`plan.component_id`); I found no code that cleans it. `mentions.ts` has a filler list for name matching only | needs a design decision: validate/normalise the id after the plan, or constrain it in the prompt |
| 11 | Scope narrowing stated in the plan | Not built (depends on 9) | open |
| 12 | Version-range rule for tools; global copy only on exact pin | Not built; ADR-060 amendment not written | open |
| 13 | Does TypeScript 7 break the gates? | Not researched in code | open |

I did not build 8-12 because 9 and 12 change a stored format and an ADR you have not ratified, and 8 and 10 depend on that design. The nearest safe next step is line 10 (normalise the id and refuse empty or sentence-like ids), plus a test for line 5.
