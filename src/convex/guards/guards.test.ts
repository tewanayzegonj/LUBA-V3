import { describe, expect, test } from "bun:test";

import {
  evaluateAuthenticatedUser,
  evaluateOperator,
  evaluateOwnership,
  evaluateOwnerOrOperator,
  evaluateVerifiedPhoneUser,
} from "./auth";
import {
  checkIdempotencyKey,
  classifyReplay,
  commitIdempotencyKey,
  deriveIdempotencyKey,
  decodeOutcome,
  encodeOutcome,
  fingerprintRequest,
} from "./idempotency";
import {
  evaluateAuditEvent,
  sanitizeAuditMeta,
} from "./audit";
import {
  isProhibitedField,
  ProhibitedFieldError,
  projectPublic,
  projectSettledResult,
} from "./projections";
import type { Doc, Id } from "../_generated/dataModel";

/* ── Test doubles ── */

function fakeUser(overrides: Record<string, unknown> = {}): Doc<"users"> {
  const base: Record<string, unknown> = {
    _id: "users:caller",
    _creationTime: 0,
    name: null,
    image: undefined,
    email: undefined,
    emailVerificationTime: undefined,
    isAnonymous: false,
    role: "user",
    phone: undefined,
    phoneVerified: undefined,
    displayName: undefined,
    publicDisplayName: undefined,
    publicWinnerConsent: undefined,
    preferredLanguage: "en",
  };
  return { ...base, ...overrides } as unknown as Doc<"users">;
}

const CALLER = "users:caller" as Id<"users">;
const OTHER = "users:other" as Id<"users">;

describe("auth guards", () => {
  test("unauthenticated rejection (null user row)", () => {
    expect(evaluateAuthenticatedUser(null).ok).toBe(false);
    expect(evaluateVerifiedPhoneUser(null).ok).toBe(false);
    expect(evaluateOperator(null).ok).toBe(false);
  });

  test("authenticated user passes; identity is returned", () => {
    const result = evaluateAuthenticatedUser(fakeUser());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.userId).toBe(CALLER);
  });

  test("unverified-phone rejection is fail-closed", () => {
    expect(evaluateVerifiedPhoneUser(fakeUser()).ok).toBe(false);
    expect(
      evaluateVerifiedPhoneUser(fakeUser({ phone: "+251911223344", phoneVerified: false })).ok,
    ).toBe(false);
    expect(
      evaluateVerifiedPhoneUser(fakeUser({ phone: "+251911223344", phoneVerified: null })).ok,
    ).toBe(false);
    expect(
      evaluateVerifiedPhoneUser(fakeUser({ phone: null, phoneVerified: true })).ok,
    ).toBe(false);
  });

  test("verified phone passes", () => {
    const result = evaluateVerifiedPhoneUser(
      fakeUser({ phone: "+251911223344", phoneVerified: true }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.userId).toBe(CALLER);
  });

  test("operator check: regular user rejected, operator accepted", () => {
    expect(evaluateOperator(fakeUser({ role: "user" })).ok).toBe(false);
    expect(evaluateOperator(fakeUser({ role: undefined })).ok).toBe(false);
    const operator = evaluateOperator(fakeUser({ role: "operator" }));
    expect(operator.ok).toBe(true);
    if (operator.ok) expect(operator.value.userId).toBe(CALLER);
  });

  test("ownership: exact match only", () => {
    expect(evaluateOwnership(CALLER, CALLER).ok).toBe(true);
    expect(evaluateOwnership(CALLER, OTHER).ok).toBe(false);
  });

  test("owner-or-operator: owner passes, operator passes, stranger fails", () => {
    expect(evaluateOwnerOrOperator(CALLER, CALLER, false).ok).toBe(true);
    expect(evaluateOwnerOrOperator(OTHER, CALLER, true).ok).toBe(true);
    expect(evaluateOwnerOrOperator(OTHER, CALLER, false).ok).toBe(false);
  });
});

/* ───────────────────────── */

describe("idempotency foundation", () => {
  test("key derivation binds op + user + token", () => {
    const key = deriveIdempotencyKey({ op: "bid", userId: CALLER, clientToken: "tok-1" });
    expect(key).toBe(`luba:idem:bid:${CALLER}:tok-1`);
    // Different user ⇒ different key: cross-user replay is impossible.
    const otherKey = deriveIdempotencyKey({ op: "bid", userId: OTHER, clientToken: "tok-1" });
    expect(otherKey).not.toBe(key);
    // System keys are distinct.
    expect(deriveIdempotencyKey({ op: "settlement", userId: null, clientToken: "a1" })).toBe(
      `luba:idem:settlement:system:a1`,
    );
  });

  test("key derivation rejects programmer errors", () => {
    expect(() =>
      deriveIdempotencyKey({ op: "nonsense" as never, userId: CALLER, clientToken: "t" }),
    ).toThrow();
    expect(() =>
      deriveIdempotencyKey({ op: "bid", userId: CALLER, clientToken: "" }),
    ).toThrow();
  });

  test("request fingerprint is deterministic and change-sensitive", () => {
    const a = { auctionId: "a1", amountSantim: 500 };
    const b = { amountSantim: 500, auctionId: "a1" }; // key order must not matter
    expect(fingerprintRequest(a)).toBe(fingerprintRequest(b));
    expect(fingerprintRequest({ ...a, amountSantim: 501 })).not.toBe(fingerprintRequest(a));
    expect(fingerprintRequest({ ...a, clientNonce: "x" })).not.toBe(fingerprintRequest(a));
  });

  test("outcome envelope round-trips", () => {
    const fp = fingerprintRequest({ x: 1 });
    const encoded = encodeOutcome(fp, "ACCEPTED");
    const decoded = decodeOutcome(encoded);
    expect(decoded).toEqual({ fp, outcome: "ACCEPTED" });
    expect(decodeOutcome("not-json")).toBe(null);
  });

  test("replay classification", () => {
    expect(classifyReplay("fp1", "fp1")).toBe("match");
    expect(classifyReplay("fp1", "fp2")).toBe("conflict");
  });

  test("first use → new, same fingerprint → replay, changed fingerprint → conflict", async () => {
    type IdemDoc = {
      _id: string;
      key: string;
      op: string;
      refType: string;
      refId: string;
      outcome: string;
      createdAt: number;
    };
    const store: IdemDoc[] = [];
    const db = {
      query: (table: string) => {
        expect(table).toBe("idempotencyRecords");
        return {
          withIndex: (_name: string, fn: (q: { eq: (f: string, v: string) => unknown }) => unknown) => {
            // Capture the key value the guard filters on.
            let capturedKey: string | undefined;
            fn({ eq: (_f: string, v: string) => { capturedKey = v; return { v }; } });
            return {
              unique: async () => store.find((d) => d.key === capturedKey) ?? null,
            };
          },
        };
      },
      insert: async (table: string, doc: IdemDoc) => {
        expect(table).toBe("idempotencyRecords");
        const id = `idem:${store.length}`;
        store.push({ ...doc, _id: id });
        return id;
      },
    };

    const key = deriveIdempotencyKey({ op: "bid", userId: CALLER, clientToken: "tok-9" });
    const fp = fingerprintRequest({ auctionId: "a1", amountSantim: 250 });

    const first = await checkIdempotencyKey({ db }, { key, fingerprint: fp });
    expect(first.status).toBe("new");

    await commitIdempotencyKey(
      { db },
      { key, op: "bid", userId: CALLER, fingerprint: fp, refType: "bids", refId: "bids:1", outcome: "ACCEPTED" },
    );

    const replay = await checkIdempotencyKey({ db }, { key, fingerprint: fp });
    expect(replay.status).toBe("replay");
    if (replay.status === "replay") {
      expect(replay.outcome).toBe("ACCEPTED");
      expect(replay.refType).toBe("bids");
    }

    const changed = await checkIdempotencyKey({ db }, {
      key,
      fingerprint: fingerprintRequest({ auctionId: "a1", amountSantim: 999 }),
    });
    expect(changed.status).toBe("conflict");
  });
});

describe("audit foundation", () => {
  test("sanitizeAuditMeta strips forbidden keys recursively", () => {
    const dirty = {
      auctionCode: "LUB-0001",
      otp: "123456",
      token: "bearer-xyz",
      authorization: "Bearer secret",
      nested: {
        receiptUrl: "https://provider/receipt/123",
        reason: "insufficient_funds",
        deeper: { password: "hunter2", count: 2 },
      },
    };
    const clean = sanitizeAuditMeta(dirty);
    expect(clean).toBeDefined();
    const json = JSON.stringify(clean);
    expect(json).not.toContain("123456");
    expect(json).not.toContain("bearer-xyz");
    expect(json).not.toContain("Bearer secret");
    expect(json).not.toContain("provider/receipt");
    expect(json).not.toContain("hunter2");
    expect(
      clean?.nested !== undefined && typeof clean.nested === "object" && "reason" in (clean.nested as object),
    ).toBe(true);
  });

  test("sanitizeAuditMeta keeps safe scalars, caps strings, rejects non-object shapes", () => {
    const clean = sanitizeAuditMeta({ extensionCount: 2, reason: "anti_snipe", note: "x".repeat(500) });
    expect(clean?.extensionCount).toBe(2);
    expect((clean?.note as string).length).toBeLessThanOrEqual(200);
    expect(sanitizeAuditMeta(["not", "an", "object"])).toBeUndefined();
    expect(sanitizeAuditMeta("scalar")).toBeUndefined();
    expect(sanitizeAuditMeta(undefined)).toBeUndefined();
  });

  test("evaluateAuditEvent enforces closed action vocabulary", () => {
    const base = {
      actorId: CALLER,
      actorRole: "user" as const,
      action: "bid.accepted",
      entityType: "bids",
      entityId: "bids:1",
    };
    expect(evaluateAuditEvent(base).ok).toBe(true);
    const bad = evaluateAuditEvent({ ...base, action: "made.up.action" });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_action");
  });

  test("evaluateAuditEvent enforces actor attribution rules", () => {
    expect(
      evaluateAuditEvent({
        actorId: null,
        actorRole: "system",
        action: "auction.closed",
        entityType: "auctions",
        entityId: "auctions:1",
      }).ok,
    ).toBe(true);
    const bad = evaluateAuditEvent({
      actorId: null,
      actorRole: "user",
      action: "bid.accepted",
      entityType: "bids",
      entityId: "bids:1",
    });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toBe("invalid_actor");
  });

  test("evaluateAuditEvent validates financial amounts as positive integer santims", () => {
    const base = {
      actorId: CALLER,
      actorRole: "user" as const,
      action: "deposit.confirmed",
      entityType: "paymentEvents",
      entityId: "pe:1",
    };
    expect(evaluateAuditEvent({ ...base, amountSantim: 12500 }).ok).toBe(true);
    const fractional = evaluateAuditEvent({ ...base, amountSantim: 10.5 });
    expect(fractional.ok).toBe(false);
    if (!fractional.ok) expect(fractional.reason).toBe("invalid_amount");
    const negative = evaluateAuditEvent({ ...base, amountSantim: -1 });
    expect(negative.ok).toBe(false);
  });
});

describe("projection boundaries", () => {
  test("prohibited-field registry covers the required categories", () => {
    for (const field of [
      "availableSantim",
      "ledgerEntryId",
      "provenanceLotIds",
      "idempotencyKey",
      "actorId",
      "actorRole",
      "meta",
      "provider",
      "providerRef",
      "userId",
      "bidderId",
      "winnerId",
      "deliveryAddress",
      "winningBidId",
      "bidDistribution",
      "lowestUniqueSantim",
    ]) {
      expect(isProhibitedField(field)).toBe(true);
    }
  });

  test("projectPublic is whitelist-only", () => {
    const source = {
      code: "LUB-0001",
      title: "Auction",
      status: "OPEN",
      availableSantim: 999999,
      actorRole: "operator",
      phone: "+251911223344",
    };
    const projected = projectPublic(source, ["code", "title", "status"]);
    expect(Object.keys(projected).sort()).toEqual(["code", "status", "title"]);
  });

  test("projectPublic throws when the whitelist itself names a prohibited field", () => {
    expect(() => projectPublic({ phone: "x", name: "y" }, ["phone"])).toThrow(ProhibitedFieldError);
    expect(() => projectPublic({ meta: {} }, ["meta"])).toThrow(ProhibitedFieldError);
    expect(() => projectPublic({ bidDistribution: [] }, ["bidDistribution"])).toThrow(ProhibitedFieldError);
  });

  test("projectPublic omits undefined fields entirely", () => {
    const projected = projectPublic({ code: "LUB-2", description: undefined }, ["code", "description"]);
    expect("description" in projected).toBe(false);
  });

  test("settled result: winner name only with consent + name (winning never implies consent)", () => {
    const base = {
      result: "WINNER" as const,
      winningAmountSantim: 12500,
      closeTime: 1700000000000,
      finalAcceptedBidCount: 42,
      prizeSummary: { title: "Prize", images: ["img-1", "img-2"] },
    };
    const consented = projectSettledResult({ ...base, winnerDisplayName: "Abe", winnerPublicConsent: true });
    expect(consented.winnerDisplayName).toBe("Abe");
    expect(consented.winningAmountSantim).toBe(12500);
    expect(consented.prize.image).toBe("img-1");

    const anonymous = projectSettledResult({ ...base, winnerDisplayName: "Abe", winnerPublicConsent: false });
    expect(anonymous.winnerDisplayName).toBe(null);

    const consentWithoutName = projectSettledResult({ ...base, winnerDisplayName: "", winnerPublicConsent: true });
    expect(consentWithoutName.winnerDisplayName).toBe(null);
  });

  test("settled result: NO_WINNER exposes no winning amount and no winner name", () => {
    const result = projectSettledResult({
      result: "NO_WINNER",
      winningAmountSantim: null,
      closeTime: 1700000000000,
      finalAcceptedBidCount: 7,
      prizeSummary: { title: "Prize", images: null },
      winnerDisplayName: "Abe",
      winnerPublicConsent: true,
    });
    expect(result.result).toBe("NO_WINNER");
    expect(result.winningAmountSantim).toBeUndefined();
    expect(result.winnerDisplayName).toBe(null);
    expect(result.prize.image).toBe(null);
  });

  test("settled result projection carries no prohibited fields", () => {
    const result = projectSettledResult({
      result: "WINNER",
      winningAmountSantim: 500,
      closeTime: 1,
      finalAcceptedBidCount: 1,
      prizeSummary: { title: "P" },
      winnerDisplayName: null,
      winnerPublicConsent: false,
    });
    for (const key of Object.keys(result)) {
      expect(isProhibitedField(key)).toBe(false);
    }
  });
});
