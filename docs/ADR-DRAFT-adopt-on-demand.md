# ADR (number to be assigned): Adopt-on-demand for brownfield targeting

Status: Proposed. Needs founder ratification. This is a one-way-door change to which manifest states are reachable, so it should be on record before release.

## Context
`purix index` records every TypeScript and Python file in one aggregate row, `purix-codebase-index`. The target resolver only returns components that own their files, and it skips that row on purpose. So after indexing, no existing file could be targeted by `modify` or `change`, even by exact path. Purix only worked on code it had created itself.

## Decision
Add `purix adopt <file-or-symbol>` (CLI) and `purix_adopt` (MCP, behind the same gated confirmation as other manifest mutations). It registers one indexed file, plus its sibling test file if one exists and is unowned, as a normal component at v1 with status `pending`, an `adopt` history entry, and a real baseline hash. `purix change` offers this inline when the intent names an indexed but unowned file. `purix modify purix-codebase-index` is refused with a pointer to `adopt`.

## Consequences
- The manifest grows only for files someone is about to change. It does not get one component per indexed file.
- An adopted component counts toward the tier's component limit like any other.
- Adoption edits no source and bypasses no gate. The change that follows still goes through verify, gate, commit and audit.
- The aggregate index row is left as is, because the resolver already ignores it for ownership.
- The audit trail gets a new event kind, `component_adopted`.
- Reversible by deleting the component with `purix delete`.
