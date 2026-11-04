import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { dotStuff, LmtpClient } from "../src/lmtp/client.js";
import { createLmtpServer, type LmtpMessageSink } from "../src/lmtp/server.js";
import type { LmtpDeliveryInput } from "../src/lmtp/proxy.js";
import { NOW, TEST_DOMAIN } from "./helpers.js";

const servers: Array<{ close: (callback: () => void) => void }> = [];

afterEach(() => {
  while (servers.length > 0) {
    servers.pop()!.close(() => {});
  }
});

class RecordingSink implements LmtpMessageSink {
  readonly received: LmtpDeliveryInput[] = [];

  async deliver(input: LmtpDeliveryInput) {
    this.received.push(input);
    return {
      status: "accepted" as const,
      messageId: "018f0d9c-0000-7000-8000-000000000000",
      route: "Inbox" as const,
      aliasIds: [],
      primaryReceived: false,
      crossCheck: { envelope: [], visible: [], envelopeOnly: [], visibleOnly: [] },
    };
  }
}

async function startServer(sink: LmtpMessageSink): Promise<number> {
  const server = createLmtpServer({
    proxy: sink,
    hostname: "downstream.test",
    localDomains: [TEST_DOMAIN],
    now: () => NOW,
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  return (server.address() as AddressInfo).port;
}

describe("LmtpClient", () => {
  it("delivers a message to a downstream LMTP server", async () => {
    const sink = new RecordingSink();
    const port = await startServer(sink);
    const client = new LmtpClient({ host: "127.0.0.1", port, hostname: "wickmail.test" });

    await client.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com"],
      data: "From: sender@example.net\r\nSubject: Hello\r\n\r\nBody",
    });

    expect(sink.received).toHaveLength(1);
    expect(sink.received[0]!.mailFrom).toBe("sender@example.net");
    expect(sink.received[0]!.rcptTo).toEqual(["green.farm@example.com"]);
    expect(sink.received[0]!.data).toContain("Body");
  });

  it("round-trips a body that starts with a dot", async () => {
    const sink = new RecordingSink();
    const port = await startServer(sink);
    const client = new LmtpClient({ host: "127.0.0.1", port });

    const body = "From: a@b.example\r\n\r\n.leading dot\r\nnormal";
    await client.deliver({
      mailFrom: "sender@example.net",
      rcptTo: ["green.farm@example.com"],
      data: body,
    });

    expect(sink.received[0]!.data).toBe(body);
  });

  it("escapes leading dots for transmission", () => {
    expect(dotStuff("a\r\n.b\r\nc")).toBe("a\r\n..b\r\nc");
  });
});
