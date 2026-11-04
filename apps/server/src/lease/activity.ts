/**
 * Which actions update `last_user_activity_at`.
 *
 * This is server policy: the server applies the set when recording activity,
 * and clients only ever consume the resulting timestamp. Authenticated
 * outbound mail and explicit renewals or enablement count as user activity.
 * Editing a label, purpose, or policy, disabling an alias, and viewing or
 * copying an alias do not.
 */
export const lastUserActivityActions = [
  "outbound_submission",
  "renew",
  "extend",
  "set_expiry",
  "remove_expiry",
  "recover",
  "enable",
] as const;

/** An action that updates `last_user_activity_at`. */
export type LastUserActivityAction = (typeof lastUserActivityActions)[number];

/** An alias action that does not update `last_user_activity_at`. */
export const nonUserActivityActions = [
  "disable",
  "edit_label",
  "edit_purpose",
  "edit_policy",
  "view",
  "copy",
] as const;

/** An alias action that does not update `last_user_activity_at`. */
export type NonUserActivityAction = (typeof nonUserActivityActions)[number];

/** Any alias action that may update `last_user_activity_at`. */
export type AliasAction = LastUserActivityAction | NonUserActivityAction;

const lastUserActivityActionSet: ReadonlySet<string> = new Set(lastUserActivityActions);

/** Whether an action updates `last_user_activity_at`. */
export function updatesLastUserActivity(action: AliasAction): action is LastUserActivityAction {
  return lastUserActivityActionSet.has(action);
}

/**
 * The `last_user_activity_at` value after an action. Actions in the user
 * activity set set it to `now`; every other action leaves it unchanged.
 */
export function nextLastUserActivityAt(
  current: number | null,
  action: AliasAction,
  now: number,
): number | null {
  return updatesLastUserActivity(action) ? now : current;
}
