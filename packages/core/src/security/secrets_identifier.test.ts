// src/security/secrets_identifier.test.ts
//
// Measured on the Purix repository: two model ids in llm/providers.ts were flagged as high-entropy secrets (a digit and entropy above 4.0).
// A name made of lowercase words is an identifier, not a token. Real tokens still block.
import { describe, it } from "node:test";
import { expect } from "expect";
import { scanForSecrets } from "./secrets";

const scan = (content: string) => scanForSecrets([{ path: "src/a.ts", content }]);

describe("high-entropy rule does not flag identifiers", () => {
  for (const id of [
    "accounts/fireworks/models/llama-v3p1-8b-instruct",
    "accounts/fireworks/models/llama-v3p1-70b-instruct",
    "meta-llama/llama-3-1-70b-instruct-turbo",
    "packages/core/src/verify/anchor_match-v2-final",
  ]) {
    it(`not flagged: ${id}`, () => {
      expect(scan(`const m = "${id}";`)).toEqual([]);
    });
  }
  for (const tok of [
    "q8Xk2Lm9Zp4Rt7Vb3Nc6Yd1Hf5Gj0Sa", // mixed case
    "9f3k2jd8s7a1x0q4w6e5r2t8y3u1i9o0", // lowercase, digits, no separators
    "9f3k-2jd8-s7a1-x0q4-w6e5-r2t8-y3u1", // separators between short digit chunks
  ]) {
    it(`still flagged: ${tok}`, () => {
      expect(scan(`const k = "${tok}";`).length).toBeGreaterThan(0);
    });
  }
});
