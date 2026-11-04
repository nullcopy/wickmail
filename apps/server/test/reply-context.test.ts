import { afterEach, describe, expect, it } from "vitest";
import type { SqliteDatabase } from "../src/db/database.js";
import { FakeMailStore } from "../src/mailstore/fake.js";
import { getReplyContext } from "../src/reply/context.js";
import { recordInboundAcceptance } from "../src/provenance/repository.js";
import { createTestDatabase, NOW } from "./helpers.js";
import { createTestAlias } from "./mail-helpers.js";

let db: SqliteDatabase;

afterEach(() => {
  db?.close();
});

const MESSAGE_ID = "018f0d9c-0000-7000-8000-0000000000ff";
const PRIMARY = "me@example.com";

function accept(store: FakeMailStore, raw: string, aliasIds: string[]): void {
  recordInboundAcceptance(db, {
    messageId: MESSAGE_ID,
    aliasIds,
    primaryReceived: false,
    envelopeRecipients: ["green.farm@example.com"],
    createdAt: NOW,
  });
  store.put("Inbox", MESSAGE_ID, raw, NOW);
}

describe("getReplyContext", () => {
  it("returns the sender, subject, sanitized text, and trusted provenance", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    const raw = [
      "Return-Path: <sender@example.net>",
      "From: Sender Name <sender@example.net>",
      "To: green.farm@example.com",
      "Subject: Your order",
      "Message-ID: <orig-1@example.net>",
      "",
      "Thanks for your order.",
    ].join("\r\n");
    accept(store, raw, [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });

    expect(context).toBeDefined();
    expect(context!.sender).toBe("sender@example.net");
    expect(context!.subject).toBe("Your order");
    expect(context!.text).toBe("Thanks for your order.");
    expect(context!.originalMessageId).toBe("<orig-1@example.net>");
    expect(context!.provenance.aliasIds).toEqual([alias.id]);
    expect(context!.identity.selected).toEqual({
      kind: "alias",
      aliasId: alias.id,
      address: "green.farm@example.com",
    });
  });

  it("is scoped to messages with trusted provenance", async () => {
    db = createTestDatabase();
    createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    store.put("Inbox", "unknown", "From: a@b.example\r\n\r\nbody", NOW);

    expect(
      await getReplyContext({
        db,
        mailStore: store,
        messageId: "unknown",
        primaryAddress: PRIMARY,
      }),
    ).toBeUndefined();
    expect(
      await getReplyContext({
        db,
        mailStore: store,
        messageId: "missing",
        primaryAddress: PRIMARY,
      }),
    ).toBeUndefined();
  });

  it("returns undefined when the message body is not in the mail store", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    recordInboundAcceptance(db, {
      messageId: MESSAGE_ID,
      aliasIds: [alias.id],
      primaryReceived: false,
      envelopeRecipients: ["green.farm@example.com"],
      createdAt: NOW,
    });

    expect(
      await getReplyContext({
        db,
        mailStore: store,
        messageId: MESSAGE_ID,
        primaryAddress: PRIMARY,
      }),
    ).toBeUndefined();
  });

  it("sanitizes header injection out of the subject and sender", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    const raw = [
      "From: sender@example.net",
      "Subject: Hello\r\nBcc: leak@example.org",
      "",
      "body",
    ].join("\r\n");
    accept(store, raw, [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });
    expect(context!.subject).not.toContain("\r");
    expect(context!.subject).not.toContain("\n");
    expect(context!.subject).toContain("Hello");
  });

  it("reduces an HTML body to text", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    const raw = [
      "From: sender@example.net",
      "Subject: Rich",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>Hello <b>there</b></p><script>alert(1)</script><br>Bye",
    ].join("\r\n");
    accept(store, raw, [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });
    expect(context!.text).toBe("Hello there\n\nBye");
    expect(context!.text).not.toContain("<");
  });

  it("decodes quoted-printable bodies", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    const raw = [
      "From: sender@example.net",
      "Subject: Encoded",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: quoted-printable",
      "",
      "caf=C3=A9 and more",
    ].join("\r\n");
    accept(store, raw, [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });
    expect(context!.text).toBe("café and more");
  });

  it("prefers the text/plain part of a multipart message", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    const raw = [
      "From: sender@example.net",
      "Subject: Multi",
      'Content-Type: multipart/alternative; boundary="bnd"',
      "",
      "--bnd",
      "Content-Type: text/plain; charset=utf-8",
      "",
      "plain body",
      "--bnd",
      "Content-Type: text/html; charset=utf-8",
      "",
      "<p>html body</p>",
      "--bnd--",
    ].join("\r\n");
    accept(store, raw, [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });
    expect(context!.text).toBe("plain body");
  });

  it("exposes only the reply-context fields", async () => {
    db = createTestDatabase();
    const alias = createTestAlias(db, { address: "green.farm@example.com", expiresAt: null });
    const store = new FakeMailStore();
    accept(store, "From: sender@example.net\r\nSubject: Hi\r\n\r\nbody", [alias.id]);

    const context = await getReplyContext({
      db,
      mailStore: store,
      messageId: MESSAGE_ID,
      primaryAddress: PRIMARY,
    });
    expect(Object.keys(context!).sort()).toEqual(
      [
        "identity",
        "messageId",
        "originalMessageId",
        "provenance",
        "sender",
        "subject",
        "text",
      ].sort(),
    );
  });
});
