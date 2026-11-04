import { connect, type Socket } from "node:net";

/**
 * A small line-oriented client for protocol tests. It reads CRLF-delimited
 * lines and can consume a multi-line reply.
 */
export class TestLineClient {
  private buffer = "";
  private readonly lines: string[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;

  private constructor(private readonly socket: Socket) {
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      this.buffer += chunk;
      this.flush();
    });
    socket.on("close", () => {
      this.closed = true;
      this.flush();
    });
    socket.on("error", () => {
      this.closed = true;
      this.flush();
    });
  }

  static connect(port: number, host = "127.0.0.1"): Promise<TestLineClient> {
    return new Promise((resolve, reject) => {
      const socket = connect({ host, port });
      socket.once("error", reject);
      socket.once("connect", () => resolve(new TestLineClient(socket)));
    });
  }

  static connectPath(path: string): Promise<TestLineClient> {
    return new Promise((resolve, reject) => {
      const socket = connect(path);
      socket.once("error", reject);
      socket.once("connect", () => resolve(new TestLineClient(socket)));
    });
  }

  private flush(): void {
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      this.lines.push(this.buffer.slice(0, newline).replace(/\r$/, ""));
      this.buffer = this.buffer.slice(newline + 1);
      newline = this.buffer.indexOf("\n");
    }
    while (this.waiters.length > 0 && (this.lines.length > 0 || this.closed)) {
      this.waiters.shift()!();
    }
  }

  readLine(): Promise<string> {
    return new Promise((resolve, reject) => {
      const check = (): void => {
        const line = this.lines.shift();
        if (line !== undefined) {
          resolve(line);
          return;
        }
        if (this.closed) {
          reject(new Error("connection closed"));
          return;
        }
        this.waiters.push(check);
      };
      check();
    });
  }

  /** Read one reply, consuming `NNN-` continuation lines, and return them. */
  async readReply(): Promise<string[]> {
    const reply: string[] = [];
    let line = await this.readLine();
    reply.push(line);
    while (line.length > 3 && line[3] === "-") {
      line = await this.readLine();
      reply.push(line);
    }
    return reply;
  }

  /** The numeric status code of a reply's last line. */
  static status(reply: string[]): number {
    return Number.parseInt(reply[reply.length - 1]!.slice(0, 3), 10);
  }

  write(data: string): void {
    this.socket.write(data);
  }

  end(): void {
    this.socket.end();
  }
}
