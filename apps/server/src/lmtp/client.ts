import { connect, type Socket } from "node:net";

/** Options for the LMTP client. */
export interface LmtpClientOptions {
  /** TCP host; mutually exclusive with `path`. */
  host?: string;
  /** TCP port. */
  port?: number;
  /** Unix socket path; mutually exclusive with `host`/`port`. */
  path?: string;
  /** The hostname sent in `LHLO`. Defaults to `wickmail`. */
  hostname?: string;
  /** The connection timeout in milliseconds. Defaults to ten seconds. */
  timeoutMs?: number;
}

/** A message to deliver over LMTP. */
export interface LmtpClientMessage {
  mailFrom: string;
  rcptTo: string[];
  data: string;
}

/** Thrown when the downstream LMTP server returns an error reply. */
export class LmtpClientError extends Error {
  override name = "LmtpClientError";
}

/**
 * A minimal LMTP client used by the spool worker to forward to Dovecot. It
 * speaks `LHLO`, `MAIL FROM`, `RCPT TO`, and `DATA`, and requires an
 * affirmative reply for every recipient.
 */
export class LmtpClient {
  constructor(private readonly options: LmtpClientOptions) {}

  async deliver(message: LmtpClientMessage): Promise<void> {
    const socket = await this.connect();
    try {
      const reader = new ResponseReader(socket);
      await reader.expect(220);
      socket.write(`LHLO ${this.options.hostname ?? "wickmail"}\r\n`);
      await reader.expect(250);

      socket.write(`MAIL FROM:<${message.mailFrom}>\r\n`);
      await reader.expect(250);

      for (const recipient of message.rcptTo) {
        socket.write(`RCPT TO:<${recipient}>\r\n`);
        await reader.expect(250);
      }

      socket.write("DATA\r\n");
      await reader.expect(354);
      socket.write(`${dotStuff(message.data)}\r\n.\r\n`);

      for (let index = 0; index < message.rcptTo.length; index += 1) {
        await reader.expect(250);
      }

      socket.write("QUIT\r\n");
      await reader.read();
    } finally {
      socket.end();
    }
  }

  private connect(): Promise<Socket> {
    return new Promise((resolve, reject) => {
      const socket =
        this.options.path !== undefined
          ? connect(this.options.path)
          : connect({ host: this.options.host ?? "127.0.0.1", port: this.options.port ?? 24 });
      const timeoutMs = this.options.timeoutMs ?? 10_000;
      const timer = setTimeout(() => {
        socket.destroy(new LmtpClientError("LMTP connection timed out"));
      }, timeoutMs);
      socket.once("connect", () => {
        clearTimeout(timer);
        resolve(socket);
      });
      socket.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }
}

/** Escape leading dots so the message body is transmitted unchanged. */
export function dotStuff(data: string): string {
  return data
    .split("\r\n")
    .map((line) => (line.startsWith(".") ? `.${line}` : line))
    .join("\r\n");
}

class ResponseReader {
  private buffer = "";
  private readonly waiters: Array<() => void> = [];
  private lines: string[] = [];
  private closed = false;

  constructor(socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("close", () => {
      this.closed = true;
      this.flush();
    });
  }

  private flush(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.lines.push(line);
      newline = this.buffer.indexOf("\n");
    }
    while (this.waiters.length > 0 && this.lines.length > 0) {
      this.waiters.shift()!();
    }
    if (this.closed) {
      while (this.waiters.length > 0) {
        this.waiters.shift()!();
      }
    }
  }

  private nextLine(): Promise<string | undefined> {
    return new Promise((resolve) => {
      const check = (): void => {
        const line = this.lines.shift();
        if (line !== undefined) {
          resolve(line);
          return;
        }
        if (this.closed) {
          resolve(undefined);
          return;
        }
        this.waiters.push(check);
      };
      check();
    });
  }

  /** Read one reply, consuming multi-line continuations, and require a code. */
  async expect(code: number): Promise<void> {
    let line = await this.nextLine();
    if (line === undefined) {
      throw new LmtpClientError("LMTP connection closed unexpectedly");
    }
    while (line.length > 3 && line[3] === "-") {
      line = await this.nextLine();
      if (line === undefined) {
        throw new LmtpClientError("LMTP connection closed mid-reply");
      }
    }
    const actual = Number.parseInt(line.slice(0, 3), 10);
    if (actual !== code) {
      throw new LmtpClientError(`expected ${code}, got ${line}`);
    }
  }

  /** Read and discard a reply. */
  async read(): Promise<void> {
    await this.nextLine();
  }
}
