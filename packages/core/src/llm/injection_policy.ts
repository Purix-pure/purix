// src/llm/injection_policy.ts
//
// F03-08 (research 03, task 5.1): what a tripwire hit does to a change. The phrase list is a tripwire, not a boundary (it caught
// 7 of 18 probes and flagged 3 of 5 legitimate texts), so a hit must change how much scrutiny the change gets and must never be a
// reason the change cannot go on. Before this, the MCP server answered every hit with a refusal. A component that merely CONTAINED a
// flagged phrase (a security document quoting it, the detector's own test) could then never be changed over MCP at all, and
// no person was ever asked.
//
// The rule, shared so both MCP paths use the same words:
//   - a hit forces a human to approve the finished result, whatever the classifier's confidence was;
//   - it never lowers a decision (an abort stays an abort);
//   - where nobody would be asked (PURIX_MCP_AUTO_APPROVE=1 approves everything unasked), the old refusal stays: a hit with no
//     person in the loop is exactly the case the tripwire exists for.

export interface InjectionSighting {
  /** Where the text was seen, in words a person can act on: "the instruction", "billing.ts", "the ingested diff (a.ts)". */
  where: string;
  hits: string[];
}

interface DecisionLike {
  action: "auto_commit" | "human_confirm" | "abort";
  reason: string;
}

const SHOWN_HITS = 3;

/** One line naming every place a phrase was seen and the first few phrases, for the approval text and the audit event. */
export function describeSightings(sightings: InjectionSighting[]): string {
  return sightings
    .map((s) => {
      const shown = s.hits.slice(0, SHOWN_HITS).map((h) => `"${h}"`).join("; ");
      const more = s.hits.length > SHOWN_HITS ? ` and ${s.hits.length - SHOWN_HITS} more` : "";
      return `${s.where}: ${shown}${more}`;
    })
    .join(" | ");
}

/** The sightings with no hits dropped. Empty means nothing was seen. */
export function onlySeen(sightings: InjectionSighting[]): InjectionSighting[] {
  return sightings.filter((s) => s.hits.length > 0);
}

/**
 * Raises a TrustGate decision to "a person must approve" when the tripwire fired. An abort is left alone (it is already the
 * strongest answer). The reason names what was seen, so the person reading the approval request sees it first.
 */
export function holdForInjection<T extends DecisionLike>(decision: T, sightings: InjectionSighting[]): T {
  const seen = onlySeen(sightings);
  if (seen.length === 0 || decision.action === "abort") return decision;
  const text = describeSightings(seen);
  const lead = `instruction-like text was found (${text}); this is a tripwire and can be a false alarm, so a person must read the change and approve it`;
  const reason = decision.action === "human_confirm" ? `${lead}; also: ${decision.reason}` : lead;
  return { ...decision, action: "human_confirm", reason };
}

/** What the MCP server does when the tripwire fired and nobody would be asked. */
export function refusalWhenNobodyIsAsked(sightings: InjectionSighting[], cliEquivalent: string): string {
  return (
    `Refused: instruction-like text was found (${describeSightings(onlySeen(sightings))}). ` +
    `PURIX_MCP_AUTO_APPROVE=1 approves every gated action without asking anyone, so there is nobody to read it, and this server refuses rather than guess. ` +
    `Run ${cliEquivalent} yourself, or start the server without PURIX_MCP_AUTO_APPROVE so a person is asked.`
  );
}
