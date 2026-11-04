import { describe, expect, it } from "vitest";
import { getHeader } from "../src/mail/headers.js";
import { composeReply, enforceOutboundIdentity } from "../src/reply/outbound.js";
import { NOW } from "./helpers.js";

const ALIAS = "green.farm@example.com";
const PRIMARY = "me@example.com";
const IDENTITY = {
  kind: "alias",
  aliasId: "018f0d9c-0000-7000-8000-00000000000a",
  address: ALIAS,
} as const;

function compose(overrides: Partial<Parameters<typeof composeReply>[0]> = {}): string {
  return composeReply({
    identity: IDENTITY,
    to: "sender@example.net",
    subject: "Your order",
    originalMessageId: "<orig@example.net>",
    body: "Thanks!",
    now: NOW,
    messageId: "<reply@example.com>",
    ...overrides,
  });
}

describe("composeReply", () => {
  it("sets the sole From mailbox to the alias and omits Reply-To", () => {
    const raw = compose();
    expect(getHeader(raw, "From")).toBe(ALIAS);
    expect(getHeader(raw, "Reply-To")).toBeUndefined();
    expect(getHeader(raw, "To")).toBe("sender@example.net");
    expect(getHeader(raw, "Subject")).toBe("Re: Your order");
    expect(getHeader(raw, "In-Reply-To")).toBe("<orig@example.net>");
  });

  it("appends quoted history per line", () => {
    const raw = compose({ quotedText: "line one\nline two" });
    expect(raw.endsWith("> line one\r\n> line two")).toBe(true);
  });
});

describe("enforceOutboundIdentity", () => {
  it("accepts a composed reply and strips inbound-only headers", () => {
    const raw = composeReply({
      identity: IDENTITY,
      to: "sender@example.net",
      subject: "Hi",
      body: "body",
      now: NOW,
      messageId: "<reply@example.com>",
    });
    const withInbound = [
      "X-Wickmail-Message-ID: spoofed",
      "Delivered-To: me@example.com",
      "X-Envelope-To: me@example.com",
      "Received: from somewhere by me@example.com",
      "X-Custom: me@example.com",
      raw,
    ].join("\r\n");

    const result = enforceOutboundIdentity(withInbound, {
      senderAddress: ALIAS,
      envelopeSender: ALIAS,
      primaryAddresses: [PRIMARY],
    });

    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(result.raw).not.toContain("spoofed");
    expect(getHeader(result.raw, "Delivered-To")).toBeUndefined();
    expect(getHeader(result.raw, "X-Envelope-To")).toBeUndefined();
    expect(getHeader(result.raw, "Received")).toBeUndefined();
    expect(getHeader(result.raw, "X-Custom")).toBeUndefined();
    expect(getHeader(result.raw, "From")).toBe(ALIAS);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        "X-Wickmail-Message-ID",
        "Delivered-To",
        "X-Envelope-To",
        "Received",
      ]),
    );
  });

  it("keeps a present Sender and Reply-To when they equal the alias", () => {
    const raw = [
      `From: ${ALIAS}`,
      `Sender: ${ALIAS}`,
      `Reply-To: ${ALIAS}`,
      "To: sender@example.net",
      "",
      "body",
    ].join("\r\n");

    const result = enforceOutboundIdentity(raw, { senderAddress: ALIAS });
    expect(result.accepted).toBe(true);
    if (!result.accepted) return;
    expect(getHeader(result.raw, "Sender")).toBe(ALIAS);
    expect(getHeader(result.raw, "Reply-To")).toBe(ALIAS);
  });

  it("rejects a message without exactly one From mailbox", () => {
    const raw = [`From: ${ALIAS}, other@example.net`, "To: sender@example.net", "", "body"].join(
      "\r\n",
    );
    const result = enforceOutboundIdentity(raw, { senderAddress: ALIAS });
    expect(result.accepted).toBe(false);
  });

  it("rejects multiple From header fields", () => {
    const raw = [
      `From: ${ALIAS}`,
      "From: other@example.net",
      "To: sender@example.net",
      "",
      "body",
    ].join("\r\n");
    const result = enforceOutboundIdentity(raw, { senderAddress: ALIAS });
    expect(result).toEqual({
      accepted: false,
      reason: "From must contain exactly one mailbox",
    });
  });

  it("rejects a From that is not the selected alias", () => {
    const raw = ["From: other@example.net", "To: sender@example.net", "", "body"].join("\r\n");
    const result = enforceOutboundIdentity(raw, { senderAddress: ALIAS });
    expect(result).toEqual({
      accepted: false,
      reason: "From does not match the selected identity",
    });
  });

  it("rejects a Sender that is not the selected alias", () => {
    const raw = [
      `From: ${ALIAS}`,
      "Sender: other@example.net",
      "To: sender@example.net",
      "",
      "body",
    ].join("\r\n");
    const result = enforceOutboundIdentity(raw, { senderAddress: ALIAS });
    expect(result.accepted).toBe(false);
  });

  it("rejects a Reply-To that is not the selected alias", () => {
    const raw = [
      `From: ${ALIAS}`,
      `Reply-To: ${PRIMARY}`,
      "To: sender@example.net",
      "",
      "body",
    ].join("\r\n");
    const result = enforceOutboundIdentity(raw, {
      senderAddress: ALIAS,
      primaryAddresses: [PRIMARY],
    });
    expect(result.accepted).toBe(false);
  });

  it("rejects an envelope sender that is not the selected alias", () => {
    const raw = [`From: ${ALIAS}`, "To: sender@example.net", "", "body"].join("\r\n");
    const result = enforceOutboundIdentity(raw, {
      senderAddress: ALIAS,
      envelopeSender: PRIMARY,
    });
    expect(result.accepted).toBe(false);
  });

  it("accepts an angle-bracketed envelope sender that matches", () => {
    const raw = [`From: ${ALIAS}`, "To: sender@example.net", "", "body"].join("\r\n");
    const result = enforceOutboundIdentity(raw, {
      senderAddress: ALIAS,
      envelopeSender: `<${ALIAS}>`,
    });
    expect(result.accepted).toBe(true);
  });
});
