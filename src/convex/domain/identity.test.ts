import { describe, expect, test } from "bun:test";

import type { Doc, Id } from "../_generated/dataModel";

import {
  decideProvision,
  lubaIdentityDefaults,
  projectSelfProfile,
  publicWinnerName,
  validateProfilePatch,
  type ProfilePatchInput,
} from "./identity";

/* ── Test doubles ── */

const USER_ID = "users:u1" as Id<"users">;

function fakeUser(overrides: Record<string, unknown> = {}): Doc<"users"> {
  const base: Record<string, unknown> = {
    _id: USER_ID,
    _creationTime: 0,
    name: null,
    image: undefined,
    email: undefined,
    emailVerificationTime: undefined,
    isAnonymous: false,
    role: "user",
    phone: "+251911234567",
    phoneVerified: false,
    displayName: undefined,
    publicDisplayName: undefined,
    publicWinnerConsent: false,
    preferredLanguage: "en",
  };
  return { ...base, ...overrides } as unknown as Doc<"users">;
}

describe("identity registration defaults", () => {
  test("defaults implement every FROZEN identity rule", () => {
    const defaults = lubaIdentityDefaults("+251911234567");
    expect(defaults.phone).toBe("+251911234567");
    expect(defaults.phoneVerified).toBe(false);
    expect(defaults.publicWinnerConsent).toBe(false);
    expect(defaults.preferredLanguage).toBe("en");
    expect(defaults.role).toBe("user");
    expect(defaults.displayName).toBeUndefined();
    expect(defaults.publicDisplayName).toBeUndefined();
  });
});

describe("new-user vs existing-user boundary", () => {
  test("no existing user → new identity with defaults", () => {
    const decision = decideProvision("+251911234567", []);
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.outcome === "new") {
      expect(decision.defaults.phone).toBe("+251911234567");
      expect(decision.defaults.role).toBe("user");
    } else {
      throw new Error("expected new");
    }
  });

  test("exactly one existing user → existing identity reused", () => {
    const decision = decideProvision("+251911234567", [fakeUser()]);
    expect(decision.ok).toBe(true);
    if (decision.ok && decision.outcome === "existing") {
      expect(decision.userId).toBe(USER_ID);
    } else {
      throw new Error("expected existing");
    }
  });

  test("duplicate rows for one phone → phone_taken invariant failure (never merged)", () => {
    const decision = decideProvision("+251911234567", [fakeUser(), fakeUser({ _id: "users:u2" as Id<"users"> })]);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("phone_taken");
  });

  test("non-canonical phone input → invalid_phone", () => {
    const decision = decideProvision("+12025550123", []);
    expect(decision.ok).toBe(false);
    if (!decision.ok) expect(decision.reason).toBe("invalid_phone");
  });
});

describe("profile patch validation", () => {
  test("displayName update, trim, and clearing", () => {
    const current = fakeUser();
    const set = validateProfilePatch(current, { displayName: "  Abebe  " });
    expect(set.ok).toBe(true);
    if (set.ok) expect(set.patch.displayName).toBe("Abebe");

    const clear = validateProfilePatch(fakeUser({ displayName: "Abebe" }), { displayName: null });
    expect(clear.ok).toBe(true);
    if (clear.ok) expect(clear.patch.displayName).toBeUndefined();
  });

  test("invalid display names rejected", () => {
    expect(validateProfilePatch(fakeUser(), { displayName: "" }).ok).toBe(false);
    expect(validateProfilePatch(fakeUser(), { displayName: "x".repeat(41) }).ok).toBe(false);
    expect(validateProfilePatch(fakeUser(), { displayName: 42 }).ok).toBe(false);
    expect(
      validateProfilePatch(fakeUser(), { publicDisplayName: "x".repeat(41) }).ok,
    ).toBe(false);
  });

  test("consent accepts only booleans", () => {
    const grant = validateProfilePatch(fakeUser(), { publicWinnerConsent: true });
    expect(grant.ok).toBe(true);
    if (grant.ok) expect(grant.patch.publicWinnerConsent).toBe(true);

    expect(validateProfilePatch(fakeUser(), { publicWinnerConsent: "yes" }).ok).toBe(false);
  });

  test("language accepts only en/am", () => {
    const am = validateProfilePatch(fakeUser(), { preferredLanguage: "am" });
    expect(am.ok).toBe(true);
    if (am.ok) expect(am.patch.preferredLanguage).toBe("am");
    expect(validateProfilePatch(fakeUser(), { preferredLanguage: "fr" }).ok).toBe(false);
  });

  test("empty patch rejected", () => {
    expect(validateProfilePatch(fakeUser(), {}).ok).toBe(false);
  });

  test("no-op patch rejected (every write is a real change)", () => {
    const current = fakeUser({ displayName: "Abe", publicWinnerConsent: true, preferredLanguage: "am" });
    expect(validateProfilePatch(current, { displayName: "Abe" }).ok).toBe(false);
    expect(validateProfilePatch(current, { publicWinnerConsent: true }).ok).toBe(false);
    expect(validateProfilePatch(current, { preferredLanguage: "am" }).ok).toBe(false);
    const clearing = validateProfilePatch(fakeUser({ displayName: undefined }), {
      displayName: null,
    });
    expect(clearing.ok).toBe(false); // clearing an already-absent name is a no-op
  });

  test("immutable identity fields are absent from any patch shape", () => {
    const result = validateProfilePatch(fakeUser(), {
      displayName: "Abe",
    } as ProfilePatchInput & Record<string, unknown>);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const keys = Object.keys(result.patch);
      expect(keys).not.toContain("phone");
      expect(keys).not.toContain("phoneVerified");
      expect(keys).not.toContain("role");
    }
  });
});

describe("self projection boundaries", () => {
  test("exposes owner display fields and masked phone only", () => {
    const profile = projectSelfProfile(
      fakeUser({
        phone: "+251911234567",
        phoneVerified: true,
        displayName: "Abebe",
        publicWinnerConsent: true,
        preferredLanguage: "am",
      }),
    );
    expect(profile.phoneMasked).toBe("+251••••••567");
    expect(profile.phoneVerified).toBe(true);
    expect(profile.publicWinnerConsent).toBe(true);
    expect(profile.preferredLanguage).toBe("am");
    expect(profile.role).toBe("user");
    const keys = Object.keys(profile);
    expect(keys).not.toContain("phone");
    expect(keys).not.toContain("_creationTime");
    expect(keys).not.toContain("tokenIdentifier");
  });

  test("defaults hold when fields are absent", () => {
    const profile = projectSelfProfile(fakeUser({ phone: undefined }));
    expect(profile.phoneMasked).toBe("•••••");
    expect(profile.phoneVerified).toBe(false);
    expect(profile.publicWinnerConsent).toBe(false);
    expect(profile.preferredLanguage).toBe("en");
    expect(profile.role).toBe("user");
  });
});

describe("publicWinnerName consent rules (Q12)", () => {
  test("consent + non-empty name → published", () => {
    expect(
      publicWinnerName(fakeUser({ publicDisplayName: "Abebe K.", publicWinnerConsent: true })),
    ).toBe("Abebe K.");
  });

  test("no consent → never published, even with a name", () => {
    expect(publicWinnerName(fakeUser({ publicDisplayName: "Abebe K." }))).toBeNull();
  });

  test("consent without a name → nothing published", () => {
    expect(publicWinnerName(fakeUser({ publicWinnerConsent: true }))).toBeNull();
    expect(publicWinnerName(fakeUser({ publicWinnerConsent: true, publicDisplayName: "" }))).toBeNull();
  });

  test("absent user row → null", () => {
    expect(publicWinnerName(null)).toBeNull();
  });
});
