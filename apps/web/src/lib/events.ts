/**
 * Human-readable labels for lifecycle audit events.
 */

import type { AuditEventKind } from "@wickmail/core";

/** Labels for each lifecycle event kind. */
export const EVENT_LABELS: Record<AuditEventKind, string> = {
  created: "Created",
  renewed_by_outbound: "Renewed by outbound mail",
  manually_renewed: "Manually renewed",
  manually_extended: "Manually extended",
  expiry_set: "Expiry set",
  expiry_removed: "Expiry removed",
  expired: "Expired",
  recovered: "Message recovered",
  replied_as_alias: "Replied as alias",
  disabled: "Disabled",
  enabled: "Enabled",
};
