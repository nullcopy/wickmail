import { describe, expect, it } from "vitest";
import {
  applyManualAction,
  evaluateOutboundSubmission,
  recover,
  recoverAndEnable,
  recoverAndRenew,
  type LeaseFields,
} from "../src/lease/actions.js";
import { lastUsedAt } from "../src/lease/lastUsed.js";
import { DAY_MS, NOW } from "./helpers.js";

const LEASE_SECONDS = 3600;

function lease(overrides: Partial<LeaseFields> = {}): LeaseFields {
  return {
    expiresAt: NOW + DAY_MS,
    disabledAt: null,
    leaseDurationSeconds: LEASE_SECONDS,
    renewOnOutbound: true,
    ...overrides,
  };
}

describe("evaluateOutboundSubmission", () => {
  it("active + renew_on_outbound renews to now + lease_duration", () => {
    const decision = evaluateOutboundSubmission(lease(), NOW);
    expect(decision).toMatchObject({ accepted: true, state: "active" });
    expect(decision.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("active + no renew leaves expires_at unchanged", () => {
    const expiresAt = NOW + DAY_MS;
    const decision = evaluateOutboundSubmission(lease({ renewOnOutbound: false }), NOW);
    expect(decision).toMatchObject({ accepted: true, state: "active", expiresAt });
  });

  it("expired + renew_on_outbound reactivates to now + lease_duration", () => {
    const decision = evaluateOutboundSubmission(lease({ expiresAt: NOW - 1 }), NOW);
    expect(decision).toMatchObject({ accepted: true, state: "expired" });
    expect(decision.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("expired + no renew rejects the submission", () => {
    const decision = evaluateOutboundSubmission(
      lease({ expiresAt: NOW - 1, renewOnOutbound: false }),
      NOW,
    );
    expect(decision.accepted).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  it("disabled rejects the submission regardless of renew policy", () => {
    for (const renewOnOutbound of [true, false]) {
      const decision = evaluateOutboundSubmission(
        lease({ disabledAt: NOW - 10, renewOnOutbound }),
        NOW,
      );
      expect(decision).toMatchObject({ accepted: false, state: "disabled" });
    }
  });

  it("an alias with no expiry ignores outbound renewal", () => {
    const decision = evaluateOutboundSubmission(lease({ expiresAt: null }), NOW);
    expect(decision).toMatchObject({ accepted: true, state: "active", expiresAt: null });
  });
});

describe("applyManualAction", () => {
  it("renew uses the supplied duration", () => {
    const outcome = applyManualAction(lease(), { type: "renew", durationSeconds: 60 }, NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.expiresAt).toBe(NOW + 60 * 1000);
    expect(outcome.updatesUserActivity).toBe(true);
  });

  it("renew falls back to lease_duration", () => {
    const outcome = applyManualAction(lease(), { type: "renew" }, NOW);
    expect(outcome.fields.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("renew applies to an expired but enabled alias", () => {
    const outcome = applyManualAction(lease({ expiresAt: NOW - 1 }), { type: "renew" }, NOW);
    expect(outcome.applied).toBe(true);
  });

  it("renew is rejected for a disabled alias", () => {
    const outcome = applyManualAction(lease({ disabledAt: NOW }), { type: "renew" }, NOW);
    expect(outcome.applied).toBe(false);
  });

  it("extend adds to the later of now and the current expiry", () => {
    const expiresAt = NOW + DAY_MS;
    const outcome = applyManualAction(lease({ expiresAt }), { type: "extend" }, NOW);
    expect(outcome.fields.expiresAt).toBe(expiresAt + LEASE_SECONDS * 1000);

    const past = applyManualAction(lease({ expiresAt: NOW - DAY_MS }), { type: "extend" }, NOW);
    expect(past.fields.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("extend requires a non-null expiry", () => {
    const outcome = applyManualAction(lease({ expiresAt: null }), { type: "extend" }, NOW);
    expect(outcome.applied).toBe(false);
  });

  it("extend is rejected for a disabled alias", () => {
    const outcome = applyManualAction(lease({ disabledAt: NOW }), { type: "extend" }, NOW);
    expect(outcome.applied).toBe(false);
  });

  it("set_expiry sets an absolute expiry and leaves lease_duration unchanged", () => {
    const outcome = applyManualAction(lease(), { type: "set_expiry", expiresAt: NOW + 1234 }, NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.expiresAt).toBe(NOW + 1234);
    expect(outcome.fields.leaseDurationSeconds).toBe(LEASE_SECONDS);
  });

  it("set_expiry is rejected for a disabled alias", () => {
    const outcome = applyManualAction(
      lease({ disabledAt: NOW }),
      { type: "set_expiry", expiresAt: NOW + 1 },
      NOW,
    );
    expect(outcome.applied).toBe(false);
  });

  it("remove_expiry clears the expiry and leaves lease_duration unchanged", () => {
    const outcome = applyManualAction(lease(), { type: "remove_expiry" }, NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.expiresAt).toBeNull();
    expect(outcome.fields.leaseDurationSeconds).toBe(LEASE_SECONDS);
  });

  it("remove_expiry is rejected for a disabled alias", () => {
    const outcome = applyManualAction(lease({ disabledAt: NOW }), { type: "remove_expiry" }, NOW);
    expect(outcome.applied).toBe(false);
  });

  it("disable applies in any state and leaves the lease unchanged", () => {
    for (const fields of [
      lease(),
      lease({ expiresAt: NOW - 1 }),
      lease({ disabledAt: NOW - 50 }),
    ]) {
      const outcome = applyManualAction(fields, { type: "disable" }, NOW);
      expect(outcome.applied).toBe(true);
      expect(outcome.fields.disabledAt).toBe(NOW);
      expect(outcome.fields.expiresAt).toBe(fields.expiresAt);
      expect(outcome.updatesUserActivity).toBe(false);
    }
  });

  it("enable clears disabled_at and starts a new lease", () => {
    const outcome = applyManualAction(lease({ disabledAt: NOW - 10 }), { type: "enable" }, NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.disabledAt).toBeNull();
    expect(outcome.fields.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("enable honours a supplied expiry", () => {
    const outcome = applyManualAction(
      lease({ disabledAt: NOW - 10 }),
      { type: "enable", expiresAt: NOW + 999 },
      NOW,
    );
    expect(outcome.fields.expiresAt).toBe(NOW + 999);
  });

  it("enable is rejected when the alias is not disabled", () => {
    const outcome = applyManualAction(lease(), { type: "enable" }, NOW);
    expect(outcome.applied).toBe(false);
  });
});

describe("recovery actions", () => {
  it("recover leaves the lease unchanged and counts as user activity", () => {
    const fields = lease();
    const outcome = recover(fields);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields).toEqual(fields);
    expect(outcome.updatesUserActivity).toBe(true);
  });

  it("recover and renew applies renew for an enabled alias", () => {
    const outcome = recoverAndRenew(lease({ expiresAt: NOW - 1 }), NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.expiresAt).toBe(NOW + LEASE_SECONDS * 1000);
  });

  it("recover and renew is rejected for a disabled alias", () => {
    const outcome = recoverAndRenew(lease({ disabledAt: NOW }), NOW);
    expect(outcome.applied).toBe(false);
  });

  it("recover and enable applies enable for a disabled alias", () => {
    const outcome = recoverAndEnable(lease({ disabledAt: NOW - 1 }), NOW);
    expect(outcome.applied).toBe(true);
    expect(outcome.fields.disabledAt).toBeNull();
  });

  it("recover and enable is rejected for an enabled alias", () => {
    const outcome = recoverAndEnable(lease(), NOW);
    expect(outcome.applied).toBe(false);
  });
});

describe("absolute expiry and later renewals", () => {
  it("an absolute expiry is renewed later using lease_duration", () => {
    const set = applyManualAction(lease(), { type: "set_expiry", expiresAt: NOW + DAY_MS }, NOW);
    const renewed = applyManualAction(set.fields, { type: "renew" }, NOW + 1000);
    expect(renewed.fields.expiresAt).toBe(NOW + 1000 + LEASE_SECONDS * 1000);
  });

  it("outbound renewal stays inert after the expiry is removed", () => {
    const removed = applyManualAction(lease(), { type: "remove_expiry" }, NOW);
    const decision = evaluateOutboundSubmission(removed.fields, NOW + 5000);
    expect(decision.expiresAt).toBeNull();
  });
});

describe("lastUsedAt", () => {
  it("uses creation time when neither timestamp is set", () => {
    expect(lastUsedAt({ lastInboundAt: null, lastUserActivityAt: null, createdAt: NOW })).toBe(NOW);
  });

  it("uses inbound activity when it is the only timestamp", () => {
    expect(lastUsedAt({ lastInboundAt: NOW + 5, lastUserActivityAt: null, createdAt: NOW })).toBe(
      NOW + 5,
    );
  });

  it("uses user activity when it is the only timestamp", () => {
    expect(lastUsedAt({ lastInboundAt: null, lastUserActivityAt: NOW + 7, createdAt: NOW })).toBe(
      NOW + 7,
    );
  });

  it("uses the later of inbound and user activity", () => {
    expect(
      lastUsedAt({ lastInboundAt: NOW + 5, lastUserActivityAt: NOW + 7, createdAt: NOW }),
    ).toBe(NOW + 7);
    expect(
      lastUsedAt({ lastInboundAt: NOW + 9, lastUserActivityAt: NOW + 7, createdAt: NOW }),
    ).toBe(NOW + 9);
  });
});
