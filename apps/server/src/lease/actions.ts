import type { AliasAction } from "./activity.js";
import { updatesLastUserActivity } from "./activity.js";
import { secondsToMs } from "../time.js";
import { effectiveState } from "./state.js";

/** The lease-relevant fields of an alias. */
export interface LeaseFields {
  expiresAt: number | null;
  disabledAt: number | null;
  leaseDurationSeconds: number;
  renewOnOutbound: boolean;
}

/** The result of evaluating an outbound submission. */
export interface OutboundDecision {
  /** Whether the submission is accepted. */
  accepted: boolean;
  /** Why a submission was rejected, or null when accepted. */
  reason: string | null;
  /** The effective state at submission time. */
  state: ReturnType<typeof effectiveState>;
  /** The resulting absolute expiry; unchanged when the lease did not renew. */
  expiresAt: number | null;
}

/**
 * Evaluate an authenticated outbound submission against the outbound truth
 * table.
 *
 * An alias with no expiry ignores outbound renewal: `lease_duration` is
 * retained but unused until an expiry is set.
 */
export function evaluateOutboundSubmission(fields: LeaseFields, now: number): OutboundDecision {
  const state = effectiveState(fields, now);

  if (state === "disabled") {
    return {
      accepted: false,
      reason: "alias is disabled",
      state,
      expiresAt: fields.expiresAt,
    };
  }

  // No expiry: renewal policy is inert until an expiry is set.
  if (fields.expiresAt === null) {
    return { accepted: true, reason: null, state, expiresAt: null };
  }

  if (state === "expired" && !fields.renewOnOutbound) {
    return {
      accepted: false,
      reason: "alias is expired and does not renew on outbound",
      state,
      expiresAt: fields.expiresAt,
    };
  }

  if (fields.renewOnOutbound) {
    return {
      accepted: true,
      reason: null,
      state,
      expiresAt: now + secondsToMs(fields.leaseDurationSeconds),
    };
  }

  return { accepted: true, reason: null, state, expiresAt: fields.expiresAt };
}

/** A manual lease action from the management API. */
export type ManualAction =
  | { type: "renew"; durationSeconds?: number }
  | { type: "extend"; durationSeconds?: number }
  | { type: "set_expiry"; expiresAt: number }
  | { type: "remove_expiry" }
  | { type: "disable" }
  | { type: "enable"; expiresAt?: number };

/** The result of applying a manual action. */
export interface ManualActionOutcome {
  /** Whether the action applied. */
  applied: boolean;
  /** Why the action was rejected, or null when applied. */
  reason: string | null;
  /** Whether the action updates `last_user_activity_at`. */
  updatesUserActivity: boolean;
  /** The resulting lease fields. */
  fields: LeaseFields;
}

function accepted(fields: LeaseFields, action: AliasAction): ManualActionOutcome {
  return {
    applied: true,
    reason: null,
    updatesUserActivity: updatesLastUserActivity(action),
    fields,
  };
}

function rejected(fields: LeaseFields, action: AliasAction, reason: string): ManualActionOutcome {
  return {
    applied: false,
    reason,
    updatesUserActivity: updatesLastUserActivity(action),
    fields,
  };
}

/**
 * Apply a manual lease action against the manual action truth table.
 *
 * `renew`, `extend`, `set_expiry`, and `remove_expiry` require an enabled
 * alias. `extend` also requires a non-null expiry. `disable` applies in any
 * state. `enable` requires a disabled alias.
 */
export function applyManualAction(
  fields: LeaseFields,
  action: ManualAction,
  now: number,
): ManualActionOutcome {
  const enabled = fields.disabledAt === null;

  switch (action.type) {
    case "renew": {
      if (!enabled) return rejected(fields, "renew", "alias is disabled");
      const durationSeconds = action.durationSeconds ?? fields.leaseDurationSeconds;
      return accepted({ ...fields, expiresAt: now + secondsToMs(durationSeconds) }, "renew");
    }
    case "extend": {
      if (!enabled) return rejected(fields, "extend", "alias is disabled");
      if (fields.expiresAt === null) {
        return rejected(fields, "extend", "alias has no expiry to extend");
      }
      const durationSeconds = action.durationSeconds ?? fields.leaseDurationSeconds;
      return accepted(
        {
          ...fields,
          expiresAt: Math.max(now, fields.expiresAt) + secondsToMs(durationSeconds),
        },
        "extend",
      );
    }
    case "set_expiry": {
      if (!enabled) return rejected(fields, "set_expiry", "alias is disabled");
      return accepted({ ...fields, expiresAt: action.expiresAt }, "set_expiry");
    }
    case "remove_expiry": {
      if (!enabled) return rejected(fields, "remove_expiry", "alias is disabled");
      return accepted({ ...fields, expiresAt: null }, "remove_expiry");
    }
    case "disable": {
      return accepted({ ...fields, disabledAt: now }, "disable");
    }
    case "enable": {
      if (enabled) return rejected(fields, "enable", "alias is not disabled");
      return accepted(
        {
          ...fields,
          disabledAt: null,
          expiresAt: action.expiresAt ?? now + secondsToMs(fields.leaseDurationSeconds),
        },
        "enable",
      );
    }
  }
}

/** Move a quarantined message to the inbox; the lease is unchanged. */
export function recover(fields: LeaseFields): ManualActionOutcome {
  return accepted(fields, "recover");
}

/**
 * Recover a quarantined message and renew the alias. Requires an enabled
 * alias, like `renew`.
 */
export function recoverAndRenew(
  fields: LeaseFields,
  now: number,
  durationSeconds?: number,
): ManualActionOutcome {
  const action: ManualAction =
    durationSeconds === undefined ? { type: "renew" } : { type: "renew", durationSeconds };
  return applyManualAction(fields, action, now);
}

/**
 * Recover a quarantined message and enable the alias. Requires a disabled
 * alias, like `enable`.
 */
export function recoverAndEnable(
  fields: LeaseFields,
  now: number,
  expiresAt?: number,
): ManualActionOutcome {
  const action: ManualAction =
    expiresAt === undefined ? { type: "enable" } : { type: "enable", expiresAt };
  return applyManualAction(fields, action, now);
}
