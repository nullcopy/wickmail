import { createServer, type Server, type Socket } from "node:net";
import { canonicalizeAddress, splitCanonicalAddress } from "../alias/canonical.js";
import { parsePathAddress } from "../mail/envelope.js";
import type { LmtpDeliveryInput, LmtpDeliveryResult } from "./proxy.js";

/** The proxy the LMTP server hands accepted messages to. */
export interface LmtpMessageSink {
  deliver(input: LmtpDeliveryInput): Promise<LmtpDeliveryResult>;
}

/** Options for the LMTP server. */
export interface LmtpServerOptions {
  /** The message sink, usually a {@link MailProxy}. */
  proxy: LmtpMessageSink;
  /** The hostname advertised in the greeting. Defaults to `wickmail`. */
  hostname?: string;
  /** Domains this server accepts recipients for. */
  localDomains: readonly string[];
  /** The maximum message size in bytes. Defaults to 25 MiB. */
  maxMessageBytes?: number;
  /** The time source. Defaults to `Date.now`. */
  now?: () => number;
}

const DEFAULT_MAX_MESSAGE_BYTES = 25 * 1024 * 1024;

/**
 * A minimal LMTP server built on `net`.
 *
 * It accepts `LHLO`, `MAIL FROM`, `RCPT TO`, `DATA`, `RSET`, `NOOP`, and
 * `QUIT`. Recipients outside the local domains are rejected at `RCPT`; alias
 * policy is evaluated by the proxy at delivery and never produces a permanent
 * rejection.
 */
export function createLmtpServer(options: LmtpServerOptions): Server {
  const hostname = options.hostname ?? "wickmail";
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const localDomains = new Set(options.localDomains.map((domain) => domain.trim().toLowerCase()));

  return createServer((socket: Socket) => {
    socket.setEncoding("utf8");
    socket.write(`220 ${hostname} LMTP ready\r\n`);
    const session = new LmtpSession(options, socket, { hostname, maxMessageBytes, localDomains });
    socket.on("data", (chunk: string) => {
      session.push(chunk);
    });
    socket.on("error", () => {
      socket.destroy();
    });
  });
}

interface SessionConfig {
  hostname: string;
  maxMessageBytes: number;
  localDomains: ReadonlySet<string>;
}

class LmtpSession {
  private buffer = "";
  private readonly queue: string[] = [];
  private draining = false;
  private inData = false;
  private readonly dataLines: string[] = [];
  private dataBytes = 0;
  private oversized = false;
  private mailFrom: string | null = null;
  private readonly rcptTo: string[] = [];

  constructor(
    private readonly options: LmtpServerOptions,
    private readonly socket: Socket,
    private readonly config: SessionConfig,
  ) {}

  push(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (line.endsWith("\r")) {
        line = line.slice(0, -1);
      }
      this.queue.push(line);
      newline = this.buffer.indexOf("\n");
    }
    void this.drain();
  }

  private async drain(): Promise<void> {
    if (this.draining) {
      return;
    }
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        await this.handleLine(this.queue.shift()!);
      }
    } finally {
      this.draining = false;
    }
  }

  private write(line: string): void {
    if (!this.socket.destroyed) {
      this.socket.write(`${line}\r\n`);
    }
  }

  private async handleLine(line: string): Promise<void> {
    if (this.inData) {
      await this.handleDataLine(line);
      return;
    }
    await this.handleCommand(line);
  }

  private async handleCommand(line: string): Promise<void> {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      this.write("500 5.5.2 Error: bad syntax");
      return;
    }
    const space = trimmed.indexOf(" ");
    const command = (space === -1 ? trimmed : trimmed.slice(0, space)).toUpperCase();
    const argument = space === -1 ? "" : trimmed.slice(space + 1).trim();

    switch (command) {
      case "LHLO":
        this.handleLhlo(argument);
        return;
      case "MAIL":
        this.handleMail(argument);
        return;
      case "RCPT":
        this.handleRcpt(argument);
        return;
      case "DATA":
        this.handleData();
        return;
      case "RSET":
        this.reset();
        this.write("250 2.0.0 Ok");
        return;
      case "NOOP":
        this.write("250 2.0.0 Ok");
        return;
      case "QUIT":
        this.write("221 2.0.0 Bye");
        this.socket.end();
        return;
      default:
        this.write("502 5.5.2 Error: command not implemented");
    }
  }

  private handleLhlo(argument: string): void {
    if (argument.length === 0) {
      this.write("501 5.5.4 Syntax: LHLO hostname");
      return;
    }
    this.write(`250-${this.config.hostname}`);
    this.write("250-8BITMIME");
    this.write("250-ENHANCEDSTATUSCODES");
    this.write("250-PIPELINING");
    this.write(`250 SIZE ${this.config.maxMessageBytes}`);
  }

  private handleMail(argument: string): void {
    const match = argument.match(/^FROM:\s*(.*)$/i);
    if (match === null) {
      this.write("501 5.5.4 Syntax: MAIL FROM:<address>");
      return;
    }
    const path = match[1] ?? "";
    if (path.length > 0 && !path.startsWith("<")) {
      this.write("501 5.5.4 Syntax: MAIL FROM:<address>");
      return;
    }
    this.mailFrom = parsePathAddress(path);
    this.write("250 2.1.0 Ok");
  }

  private handleRcpt(argument: string): void {
    if (this.mailFrom === null) {
      this.write("503 5.5.1 Error: need MAIL command");
      return;
    }
    const match = argument.match(/^TO:\s*(.*)$/i);
    if (match === null) {
      this.write("501 5.5.4 Syntax: RCPT TO:<address>");
      return;
    }
    const address = parsePathAddress(match[1] ?? "");
    let domain: string | undefined;
    try {
      domain = splitCanonicalAddress(canonicalizeAddress(address)).domain;
    } catch {
      domain = undefined;
    }
    if (domain === undefined || !this.config.localDomains.has(domain)) {
      this.write("550 5.1.1 Relay access denied");
      return;
    }
    this.rcptTo.push(address);
    this.write("250 2.1.5 Ok");
  }

  private handleData(): void {
    if (this.mailFrom === null || this.rcptTo.length === 0) {
      this.write("503 5.5.1 Error: need RCPT command");
      return;
    }
    this.inData = true;
    this.dataLines.length = 0;
    this.dataBytes = 0;
    this.oversized = false;
    this.write("354 End data with <CR><LF>.<CR><LF>");
  }

  private async handleDataLine(line: string): Promise<void> {
    if (line === ".") {
      await this.finishData();
      return;
    }
    const unstuffed = line.startsWith(".") ? line.slice(1) : line;
    this.dataBytes += Buffer.byteLength(unstuffed, "utf8") + 2;
    if (this.dataBytes > this.config.maxMessageBytes) {
      this.oversized = true;
      return;
    }
    this.dataLines.push(unstuffed);
  }

  private async finishData(): Promise<void> {
    this.inData = false;
    const mailFrom = this.mailFrom ?? "";
    const rcptTo = [...this.rcptTo];
    const data = this.dataLines.join("\r\n");

    if (this.oversized) {
      this.reset();
      this.write("552 5.3.4 Error: message size exceeds fixed limit");
      return;
    }

    let result: LmtpDeliveryResult;
    try {
      result = await this.options.proxy.deliver({
        mailFrom,
        rcptTo,
        data,
        receivedAt: (this.options.now ?? Date.now)(),
      });
    } catch (error) {
      result = {
        status: "tempfail",
        reason: error instanceof Error ? error.message : String(error),
      };
    }
    this.reset();

    for (let index = 0; index < rcptTo.length; index += 1) {
      if (result.status === "accepted") {
        this.write(`250 2.0.0 Ok: queued as ${result.messageId}`);
      } else {
        this.write(`451 4.3.0 ${result.reason}`);
      }
    }
  }

  private reset(): void {
    this.mailFrom = null;
    this.rcptTo.length = 0;
    this.dataLines.length = 0;
    this.dataBytes = 0;
    this.oversized = false;
  }
}
