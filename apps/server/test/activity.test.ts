import { describe, expect, it } from "vitest";
import {
  nextLastUserActivityAt,
  updatesLastUserActivity,
  type AliasAction,
} from "../src/lease/activity.js";
import { NOW } from "./helpers.js";

const UPDATING: AliasAction[] = [
  "outbound_submission",
  "renew",
  "extend",
  "set_expiry",
  "remove_expiry",
  "recover",
  "enable",
];

const NOT_UPDATING: AliasAction[] = [
  "disable",
  "edit_label",
  "edit_purpose",
  "edit_policy",
  "view",
  "copy",
];

describe("updatesLastUserActivity", () => {
  it("covers exactly the specified action set", () => {
    for (const action of UPDATING) {
      expect(updatesLastUserActivity(action), action).toBe(true);
    }
    for (const action of NOT_UPDATING) {
      expect(updatesLastUserActivity(action), action).toBe(false);
    }
  });
});

describe("nextLastUserActivityAt", () => {
  it("sets the timestamp for user activity actions", () => {
    for (const action of UPDATING) {
      expect(nextLastUserActivityAt(NOW - 500, action, NOW), action).toBe(NOW);
    }
  });

  it("leaves the timestamp unchanged for other actions", () => {
    for (const action of NOT_UPDATING) {
      expect(nextLastUserActivityAt(NOW - 500, action, NOW), action).toBe(NOW - 500);
      expect(nextLastUserActivityAt(null, action, NOW), action).toBeNull();
    }
  });
});
