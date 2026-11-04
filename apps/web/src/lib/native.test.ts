import assert from "node:assert/strict";
import { test } from "node:test";

import { nativeBridge, suggestLabelFromShare, type WickmailNative } from "./native.ts";

test("suggestLabelFromShare uses the hostname of a URL", () => {
  assert.equal(suggestLabelFromShare("https://www.example.com/order/123"), "example.com");
  assert.equal(suggestLabelFromShare("https://shop.example.org/cart"), "shop.example.org");
});

test("suggestLabelFromShare falls back to the first line of plain text", () => {
  assert.equal(suggestLabelFromShare("Example Store\norder 1234"), "Example Store");
  assert.equal(suggestLabelFromShare("  "), "");
});

test("suggestLabelFromShare truncates long plain text", () => {
  const label = suggestLabelFromShare("x".repeat(120));
  assert.equal(label.length, 60);
});

test("nativeBridge is absent outside the Android shell", () => {
  assert.equal(nativeBridge(), null);
});

test("nativeBridge returns the injected object when present", () => {
  const bridge = { isAvailable: true } as unknown as WickmailNative;
  (globalThis as { window?: unknown }).window = { wickmailNative: bridge };
  try {
    assert.equal(nativeBridge(), bridge);
  } finally {
    delete (globalThis as { window?: unknown }).window;
  }
});
