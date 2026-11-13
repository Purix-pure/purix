// packages/core/src/licensing/entitlement_signature_interop.test.ts
//
// Golden vector: a document signed by the SERVER's own signing code
// (packages/api/src/auth/entitlement_signing.ts in the private repo, run with a
// throwaway Ed25519 key on 2026-10-09) must verify here, and the same bytes
// must be refused when expired, rolled back or edited. If either side changes
// the wire format, this test (and the matching private-repo check) breaks.
//
// The key below is a throwaway used for this vector only. It is not, and must
// never be added to, TRUSTED_ENTITLEMENT_KEYS.
import { describe, test } from "node:test";
import { expect } from "expect";
import { checkSignedEntitlements } from "./entitlement_signature";

const KID = "interop-kid-1";
const RAW_PUBLIC_KEY = "oWJ0tHDeoSK9rpp7fA5SiWfWSnV7E8NJGig-c-ha60c";
const IAT = 1790000000;
const TOKEN =
  "eyJhbGciOiJFZERTQSIsImtpZCI6ImludGVyb3Ata2lkLTEifQ.eyJzY2hlbWEiOjEsInN1YiI6InVzZXJfaW50ZXJvcCIsInRpZXIiOiJwcm8iLCJmbGFncyI6eyJjb21wb25lbnRMaW1pdCI6bnVsbCwiYXVkaXRFeHBvcnQiOnRydWUsIndlYmhvb2tzIjp0cnVlfSwidmVyIjozLCJpYXQiOjE3OTAwMDAwMDAsImV4cCI6MTc5MDAwMzYwMH0.uAsoiNvYvOtEpAr-Z-bqL1Z-s51ncwVmJSaMnk3L51vZEtH4YYwB3xOzElGFRHgRuLfWeUplETHm2ntDIGpZDg";
const keys = { [KID]: RAW_PUBLIC_KEY };
const at = (secondsAfterIssue: number) => new Date((IAT + secondsAfterIssue) * 1000);

describe("entitlement document signed by the server verifies in the client", () => {
  test("verifies and returns the server's claims", () => {
    const r = checkSignedEntitlements({ signed: TOKEN }, { keys, now: at(10), highestVersionSeen: 2 });
    expect(r.status).toBe("verified");
    if (r.status === "verified") {
      expect(r.claims).toEqual({
        schema: 1,
        sub: "user_interop",
        tier: "pro",
        flags: { componentLimit: null, auditExport: true, webhooks: true },
        ver: 3,
        iat: IAT,
        exp: IAT + 3600,
      });
    }
  });

  test("is rejected after its one-hour lifetime", () => {
    expect(checkSignedEntitlements({ signed: TOKEN }, { keys, now: at(4000) })).toEqual({ status: "rejected", reason: "expired" });
  });

  test("is rejected as a rollback when a newer version was already seen", () => {
    const r = checkSignedEntitlements({ signed: TOKEN }, { keys, now: at(10), highestVersionSeen: 9 });
    expect(r.status).toBe("rejected");
  });

  test("an edited payload fails the signature", () => {
    const [h, , s] = TOKEN.split(".");
    const edited = Buffer.from(JSON.stringify({ schema: 1, sub: "user_interop", tier: "enterprise", flags: {}, ver: 3, iat: IAT, exp: IAT + 3600 })).toString("base64url");
    expect(checkSignedEntitlements({ signed: `${h}.${edited}.${s}` }, { keys, now: at(10) })).toEqual({ status: "rejected", reason: "bad signature" });
  });
});
