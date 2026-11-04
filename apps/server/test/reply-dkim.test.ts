import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { getHeader } from "../src/mail/headers.js";
import {
  canonicalizeBodyRelaxed,
  createDkimSigner,
  dmarcAligned,
  signMessage,
  verifyDkimSignature,
} from "../src/reply/dkim.js";
import { composeReply } from "../src/reply/outbound.js";
import { NOW } from "./helpers.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const PUBLIC_PEM = publicKey.export({ type: "spki", format: "pem" }).toString();
const OTHER_PUBLIC_PEM = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .publicKey.export({ type: "spki", format: "pem" })
  .toString();

const MESSAGE = composeReply({
  identity: {
    kind: "alias",
    aliasId: "018f0d9c-0000-7000-8000-00000000000a",
    address: "green.farm@example.com",
  },
  to: "sender@example.net",
  subject: "Your order",
  originalMessageId: "<orig@example.net>",
  body: "Thanks for your order.",
  now: NOW,
  messageId: "<reply@example.com>",
});

describe("signMessage", () => {
  it("signs with the alias domain key and verifies", () => {
    const signed = signMessage(MESSAGE, {
      domain: "example.com",
      selector: "wickmail",
      privateKey: PRIVATE_PEM,
      now: NOW,
    });

    const signature = getHeader(signed, "DKIM-Signature");
    expect(signature).toContain("v=1");
    expect(signature).toContain("a=rsa-sha256");
    expect(signature).toContain("c=relaxed/relaxed");
    expect(signature).toContain("d=example.com");
    expect(signature).toContain("s=wickmail");
    expect(signature).toContain("h=from:");
    expect(signature).toContain("bh=");
    expect(signature).toMatch(/b=[A-Za-z0-9+/=]+/);

    const verified = verifyDkimSignature(signed, PUBLIC_PEM);
    expect(verified).toEqual({
      valid: true,
      domain: "example.com",
      selector: "wickmail",
      reason: null,
    });
  });

  it("is DMARC-aligned because the signing domain is the From domain", () => {
    const signed = signMessage(MESSAGE, {
      domain: "example.com",
      selector: "wickmail",
      privateKey: PRIVATE_PEM,
      now: NOW,
    });
    const verified = verifyDkimSignature(signed, PUBLIC_PEM);
    expect(dmarcAligned("example.com", verified.domain!)).toBe(true);
    expect(dmarcAligned("example.com", "other.example")).toBe(false);
  });

  it("fails verification when the body is tampered with", () => {
    const signed = signMessage(MESSAGE, {
      domain: "example.com",
      selector: "wickmail",
      privateKey: PRIVATE_PEM,
      now: NOW,
    });
    const tampered = signed.replace("Thanks for your order.", "Something else.");
    expect(verifyDkimSignature(tampered, PUBLIC_PEM).valid).toBe(false);
  });

  it("fails verification with the wrong key", () => {
    const signed = signMessage(MESSAGE, {
      domain: "example.com",
      selector: "wickmail",
      privateKey: PRIVATE_PEM,
      now: NOW,
    });
    expect(verifyDkimSignature(signed, OTHER_PUBLIC_PEM).valid).toBe(false);
  });

  it("builds a signer bound to a key and selector", () => {
    const signer = createDkimSigner({ selector: "wickmail", privateKey: PRIVATE_PEM });
    const signed = signer(MESSAGE, { domain: "example.com", now: NOW });
    expect(verifyDkimSignature(signed, PUBLIC_PEM).valid).toBe(true);
  });
});

describe("canonicalizeBodyRelaxed", () => {
  it("collapses whitespace, strips trailing blank lines, and ends with CRLF", () => {
    expect(canonicalizeBodyRelaxed("a  b \r\n\r\n\r\n")).toBe("a b\r\n");
    expect(canonicalizeBodyRelaxed("")).toBe("");
  });
});
