import { describe, expect, it } from "vitest";
import {
  addHeaders,
  getHeader,
  getHeaderValues,
  isWickmailHeader,
  parseMessage,
  stripWickmailHeaders,
} from "../src/mail/headers.js";

const MESSAGE = [
  "Received: from remote (remote.example [203.0.113.1])",
  "From: sender@example.net",
  "To: green.farm@example.com",
  "Subject: Hello",
  "",
  "Body line one",
  "Body line two",
].join("\r\n");

describe("parseMessage", () => {
  it("splits headers and body and unfolds continuation lines", () => {
    const parsed = parseMessage(
      ["X-Long: first", "  second", "From: a@b.example", "", "body"].join("\r\n"),
    );
    expect(parsed.headers.find((header) => header.name === "X-Long")?.value).toBe("first second");
    expect(parsed.body).toBe("body");
  });

  it("treats a message without a blank line as headers only", () => {
    const parsed = parseMessage("From: a@b.example");
    expect(parsed.headers).toHaveLength(1);
    expect(parsed.body).toBe("");
  });
});

describe("stripWickmailHeaders", () => {
  it("removes every X-Wickmail-* header case-insensitively and keeps the body", () => {
    const spoofed = [
      "X-Wickmail-Route: Inbox",
      "x-wickmail-alias-id: 11111111-1111-4111-8111-111111111111",
      "X-WICKMAIL-MESSAGE-ID: spoofed",
      "From: sender@example.net",
      "Subject: Hello",
      "",
      "Body",
    ].join("\r\n");

    const { raw, removed } = stripWickmailHeaders(spoofed);
    expect(removed).toHaveLength(3);
    expect(getHeader(raw, "X-Wickmail-Route")).toBeUndefined();
    expect(getHeader(raw, "X-Wickmail-Message-ID")).toBeUndefined();
    expect(getHeader(raw, "From")).toBe("sender@example.net");
    expect(raw.endsWith("Body")).toBe(true);
  });

  it("leaves unrelated X- headers untouched", () => {
    const { raw } = stripWickmailHeaders(["X-Spam-Flag: NO", "", "body"].join("\r\n"));
    expect(getHeader(raw, "X-Spam-Flag")).toBe("NO");
  });

  it("recognizes the reserved namespace", () => {
    expect(isWickmailHeader("X-Wickmail-Route")).toBe(true);
    expect(isWickmailHeader("x-wickmail-message-id")).toBe(true);
    expect(isWickmailHeader("X-Spam-Flag")).toBe(false);
  });
});

describe("addHeaders", () => {
  it("prepends trusted headers to a stripped message", () => {
    const { raw: stripped } = stripWickmailHeaders(MESSAGE);
    const withHeaders = addHeaders(stripped, [
      { name: "X-Wickmail-Message-ID", value: "abc" },
      { name: "X-Wickmail-Route", value: "Inbox" },
    ]);
    expect(getHeader(withHeaders, "X-Wickmail-Message-ID")).toBe("abc");
    expect(getHeader(withHeaders, "X-Wickmail-Route")).toBe("Inbox");
    expect(getHeaderValues(withHeaders, "To")).toEqual(["green.farm@example.com"]);
    expect(withHeaders.endsWith("Body line two")).toBe(true);
    // Trusted headers appear before the original headers.
    expect(withHeaders.indexOf("X-Wickmail-Route")).toBeLessThan(withHeaders.indexOf("Received:"));
  });

  it("normalizes bare LF input to CRLF", () => {
    const { raw } = stripWickmailHeaders("From: a@b.example\nSubject: x\n\nbody\n");
    expect(raw).toBe("From: a@b.example\r\nSubject: x\r\n\r\nbody\r\n");
  });
});
