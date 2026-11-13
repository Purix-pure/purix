// AI-13: the data gate for skipping "Proceed with this interpretation?". Tested on Linux against simulated payloads.
import { describe, it } from "node:test";
import { expect } from "expect";
import { interpretationPromptSkip, readCheckpointAcceptance, INTERPRETATION_SKIP_MIN_SAMPLES } from "./observability.js";
import type { EventRecord } from "./events.js";

const ev = (kind: string, approved: boolean, extra: Record<string, unknown> = {}): EventRecord =>
  ({ id: "i", timestamp: "t", kind: "confirm_response", component_id: null, operation: null, detail: { checkpoint_kind: kind, approved, ...extra } });
const many = (n: number, declined = 0) => [...Array.from({ length: n - declined }, () => ev("intent_refinement", true)), ...Array.from({ length: declined }, () => ev("intent_refinement", false))];

describe("interpretationPromptSkip", () => {
  it("never skips below the sample size, even at 100%", () => {
    const a = readCheckpointAcceptance("intent_refinement", many(INTERPRETATION_SKIP_MIN_SAMPLES - 1));
    expect(interpretationPromptSkip({ assumptions: 0, acceptance: a }).skip).toBe(false);
  });
  it("skips at 20 answers and 95%", () => {
    const a = readCheckpointAcceptance("intent_refinement", many(20, 1));
    expect(a).toEqual({ approved: 19, declined: 1 });
    expect(interpretationPromptSkip({ assumptions: 0, acceptance: a }).skip).toBe(true);
  });
  it("does not skip at 20 answers and 90%", () => {
    expect(interpretationPromptSkip({ assumptions: 0, acceptance: readCheckpointAcceptance("intent_refinement", many(20, 2)) }).skip).toBe(false);
  });
  it("never skips when there are assumptions", () => {
    expect(interpretationPromptSkip({ assumptions: 1, acceptance: { approved: 100, declined: 0 } }).skip).toBe(false);
  });
  it("counts only this checkpoint and leaves AUTO_CONFIRM answers out", () => {
    const events = [...many(10), ...Array.from({ length: 30 }, () => ev("intent_refinement", true, { auto_confirmed: true })), ...Array.from({ length: 30 }, () => ev("trust_gate", true))];
    expect(readCheckpointAcceptance("intent_refinement", events)).toEqual({ approved: 10, declined: 0 });
  });
});
