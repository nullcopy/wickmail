import assert from "node:assert/strict";
import { test } from "node:test";

import { aliasPath, matchRoute } from "./router.ts";

test("matchRoute resolves known paths", () => {
  assert.deepEqual(matchRoute("/"), { name: "dashboard" });
  assert.deepEqual(matchRoute("/quarantine"), { name: "quarantine" });
  assert.deepEqual(matchRoute("/messages"), { name: "messages" });
  assert.deepEqual(matchRoute("/activity"), { name: "activity" });
  assert.deepEqual(matchRoute("/settings"), { name: "settings" });
  assert.deepEqual(matchRoute("/setup"), { name: "setup" });
  assert.deepEqual(matchRoute("/recover"), { name: "recover" });
});

test("matchRoute resolves alias detail and ignores trailing slashes", () => {
  assert.deepEqual(matchRoute("/aliases/abc"), { name: "alias", id: "abc" });
  assert.deepEqual(matchRoute("/aliases/abc/"), { name: "alias", id: "abc" });
});

test("matchRoute falls back to the dashboard for unknown paths", () => {
  assert.deepEqual(matchRoute("/nope"), { name: "dashboard" });
});

test("aliasPath encodes the id", () => {
  assert.equal(aliasPath("a b"), "/aliases/a%20b");
});
