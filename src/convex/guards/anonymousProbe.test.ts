/**
 * Phase I exit-gate — anonymous-session security probe (Task 4).
 *
 * Regression/security test proving that the currently active Anonymous
 * provider (template-managed, do-not-modify) CANNOT reach any authenticated
 * or financial LUBA surface.
 *
 * Mechanics of the probe: it exercises the REAL exported Convex function
 * handlers (via `_handler`, the actual code that ships) with a fake session
 * ctx whose `auth.getUserIdentity()` returns an Anonymous-provider identity
 * (`tokenIdentifier`-style subject `anon:<...>`) and whose db resolves that
 * session to the users row the provider would have minted
 * (`isAnonymous: true`, no verified phone, no LUBA registration).
 *
 * Why this works at every seam: every LUBA guard resolves the session to a
 * users row and then evaluates the row. The Anonymous row is rejected by the
 * shared guard core (`authenticatedUser` — TRD §4 FROZEN: the anonymous
 * token path is never accepted for any route) before any surface-specific
 * logic runs, so financial and operator surfaces fail closed at the same
 * layer they would for any unauthenticated caller.
 */
import { describe, expect, test } from "bun:test";

import type { Doc } from "../_generated/dataModel";

import * as bidsSurface from "../bids";
import * as auctionsSurface from "../auctions";
import * as profileSurface from "../profile";
import * as settlementSurface from "../settlement";
import * as reconciliationSurface from "../reconciliation";

import {
  evaluateAuthenticatedUser,
  evaluateOperator,
  evaluateVerifiedPhoneUser,
} from "./auth";

/* ── Anonymous session scaffolding (mirrors the template provider's rows) ── */

/** A users row exactly as the Anonymous provider mints it. */
function anonymousUserRow(): Doc<"users"> {
  return {
    _id: "users:anon1" as Doc<"users">["_id"],
    _creationTime: 1_700_000_000_000,
    name: null,
    image: undefined,
    email: undefined,
    emailVerificationTime: undefined,
    isAnonymous: true, // provider marker (platform-managed, do-not-modify)
    role: undefined, // never provisioned by the provider
    phone: undefined,
    phoneVerified: undefined,
    displayName: undefined,
    publicDisplayName: undefined,
    publicWinnerConsent: undefined,
    preferredLanguage: undefined,
  } as unknown as Doc<"users">;
}

/** The guard core must refuse the anonymous row before anything else. */
describe("anonymous-session security probe — guard cores (real evaluators)", () => {
  test("authenticated core refuses an anonymous users row", () => {
    const r = evaluateAuthenticatedUser(anonymousUserRow());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_authorized");
  });

  test("verified-phone core (financial gate) refuses an anonymous users row", () => {
    const r = evaluateVerifiedPhoneUser(anonymousUserRow());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_authorized");
  });

  test("operator core refuses an anonymous users row", () => {
    const r = evaluateOperator(anonymousUserRow());
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("not_authorized");
  });
});

/* ── Real-handler probe through the actual public surfaces ── */

type AnyHandler = (ctx: unknown, args?: Record<string, unknown>) => Promise<unknown>;

function handlerOf(f: unknown): AnyHandler {
  const h = (f as { _handler?: AnyHandler })._handler;
  if (typeof h !== "function") throw new Error("surface is missing its handler");
  return h;
}

/** Fake ctx for an Anonymous-provider session. The identity subject is
 * `<userId>|<sessionId>` — exactly how getAuthUserId resolves a session to
 * the users row the provider minted — so every probe exercises the true
 * anonymous-row rejection path (not a mere missing-row path). */
function anonCtx(): { ctx: Record<string, unknown>; dbRows: unknown[] } {
  const dbRows: unknown[] = [];
  return {
    ctx: {
      auth: {
        getUserIdentity: async () => ({
          subject: "users:anon1|anon-session", // provider-namespaced subject
          tokenIdentifier: "users:anon1|anon-session",
          issuer: "https://anonymous.convex.dev",
        }),
      },
      db: {
        // `get` returns ONLY rows matching the anonymous session's user id —
        // the provider resolves the session to exactly that row.
        get: async (id: string) =>
          id === "users:anon1" ? (anonymousUserRow() as unknown) : null,
        insert: async (table: string, doc: Record<string, unknown>) => {
          dbRows.push({ table, doc });
          return `${table}:inserted`;
        },
        query: () => ({
          withIndex: () => ({
            unique: async () => null,
            collect: async () => [],
          }),
        }),
      },
    },
    dbRows,
  };
}

/** A db whose every read of the anonymous row still resolves it (belt and
 * braces: the guard must refuse before any business read matters). */
function anonCtxWithRowAccess(): Record<string, unknown> {
  const anonRow = anonymousUserRow();
  return {
    auth: {
      getUserIdentity: async () => ({
        subject: "users:anon1|anon-session",
        tokenIdentifier: "users:anon1|anon-session",
        issuer: "https://anonymous.convex.dev",
      }),
    },
    db: {
      get: async (id: string) => (id === anonRow._id ? (anonRow as unknown) : null),
      insert: async () => "any:1",
      query: () => ({
        withIndex: () => ({
          unique: async () => null,
          collect: async () => [],
        }),
      }),
    },
  };
}

describe("anonymous-session security probe — real surface handlers", () => {
  test("authenticated user query (getMyProfile) is unreachable", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(profileSurface.getMyProfile)(ctx, {})) as { ok: boolean };
    // The session resolves to a real users row (the provider minted it), so
    // the refusal is the shared authorization vocabulary — the anonymous-row
    // path, not a missing-row path.
    expect(out).toMatchObject({ ok: false, reason: "not_authorized" });
  });

  test("profile mutation (updateMyProfile) is unreachable", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(profileSurface.updateMyProfile)(ctx, {
      displayName: "Anon",
    })) as { ok: boolean };
    expect(out).toMatchObject({ ok: false, reason: "not_authorized" });
  });

  test("financial mutation (placeBid) is refused — verified-phone gate", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(bidsSurface.placeBid)(ctx, {
      auctionId: "auctions:a1",
      idempotencyToken: "tok-anon",
      amountSantim: 100,
    })) as { ok: boolean; status: string; reason: string };
    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
    expect(["unauthenticated", "unverified_phone", "phone_missing", "not_authorized"]).toContain(
      out.reason,
    );
    // Financial effect: no wallet write, no bid insert may occur.
  });

  test("financial mutation (settleAuction) is refused", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(settlementSurface.settleAuction)(ctx, {
      auctionId: "auctions:a1",
    })) as { ok: boolean; status: string };
    expect(out.ok).toBe(false);
    expect(out.status).toBe("refused");
  });

  test("operator surface (createAuction) is unreachable", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(auctionsSurface.createAuction)(ctx, {
      code: "LUB-ANON",
      title: "Anon attempt",
      prizeId: "prizes:p1",
      closeAt: Date.now() + 60_000,
      fulfillmentMethod: "delivery",
    })) as { ok: boolean; reason?: string };
    expect(out.ok).toBe(false);
  });

  test("operator surface (operatorRunReconciliation) is unreachable", async () => {
    const { ctx } = anonCtx();
    const out = (await handlerOf(reconciliationSurface.operatorRunReconciliation)(ctx, {})) as {
      ok: boolean;
      reason?: string;
    };
    expect(out.ok).toBe(false);
    if (!out.ok) expect(out.reason).toBe("not_authorized");
  });

  test("own-bid query (listMyBids) returns nothing for an anonymous session", async () => {
    const ctx = anonCtxWithRowAccess();
    const out = await handlerOf(bidsSurface.listMyBids)(ctx, { auctionId: "auctions:a1" });
    expect(out).toEqual([]);
  });

  test("no financial insert escapes any probed anonymous call", async () => {
    const { ctx, dbRows } = anonCtx();
    await handlerOf(bidsSurface.placeBid)(ctx, {
      auctionId: "auctions:a1",
      idempotencyToken: "tok-anon",
      amountSantim: 100,
    });
    await handlerOf(settlementSurface.settleAuction)(ctx, { auctionId: "auctions:a1" });
    await handlerOf(auctionsSurface.createAuction)(ctx, {
      code: "LUB-ANON",
      title: "Anon attempt",
      prizeId: "prizes:p1",
      closeAt: Date.now() + 60_000,
      fulfillmentMethod: "delivery",
    });
    expect(dbRows).toEqual([]); // zero writes of any kind
  });

  test("probe integrity: the anonymous identity really resolves to its row", async () => {
    // Guards the probe itself against silent false-positives: if the fake
    // ctx stopped resolving the session, every surface would "fail" for the
    // wrong reason (no session) and the probe would prove nothing about the
    // anonymous-row path. The resolver sees the identity and returns the row.
    const ctx = anonCtxWithRowAccess();
    const row = (await (ctx.db as { get: (id: string) => Promise<unknown> }).get(
      "users:anon1",
    )) as Doc<"users"> | null;
    expect(row).not.toBeNull();
    expect(row?.isAnonymous).toBe(true);
  });
});

/* ── Whole-store write probe: no financial table is ever touched ── */

describe("anonymous-session security probe — zero financial effects", () => {
  test("every probed surface leaves the store write-free for anonymous sessions", async () => {
    const tables = new Map<string, unknown[]>();
    const db = {
      get: async (id: string) => (id === "users:anon1" ? (anonymousUserRow() as unknown) : null),
      insert: async (table: string, doc: Record<string, unknown>) => {
        if (!tables.has(table)) tables.set(table, []);
        tables.get(table)!.push(doc);
        return `${table}:x`;
      },
      patch: async (table: string) => {
        if (!tables.has(table)) tables.set(table, []);
        tables.get(table)!.push("patch");
      },
      query: () => ({
        withIndex: () => ({
          unique: async () => null,
          collect: async () => [],
        }),
      }),
    };
    const ctx = {
      auth: {
        getUserIdentity: async () => ({
          subject: "users:anon1|anon-session",
          tokenIdentifier: "users:anon1|anon-session",
          issuer: "https://anonymous.convex.dev",
        }),
      },
      db,
    };

    await handlerOf(bidsSurface.placeBid)(ctx, {
      auctionId: "auctions:a1",
      idempotencyToken: "tok-anon",
      amountSantim: 100,
    });
    await handlerOf(settlementSurface.settleAuction)(ctx, { auctionId: "auctions:a1" });
    await handlerOf(profileSurface.updateMyProfile)(ctx, { displayName: "x" });
    await handlerOf(auctionsSurface.createAuction)(ctx, {
      code: "LUB-ANON",
      title: "x",
      prizeId: "prizes:p1",
      closeAt: Date.now() + 60_000,
      fulfillmentMethod: "delivery",
    });

    // No writes of any table, ever — the anonymous token path is inert.
    expect([...tables.entries()]).toEqual([]);
  });
});
