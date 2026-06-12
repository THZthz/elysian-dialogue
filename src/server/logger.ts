import EventEmitter from "node:events";

export interface LogEntry {
  level: "info" | "error" | "warn";
  message: string;
  timestamp: number;
}

export class Logger {
  private buffer: LogEntry[] = [];
  private maxBuffer: number;
  private emitter = new EventEmitter();
  private stdout: NodeJS.WriteStream;
  private stderr: NodeJS.WriteStream;

  constructor(maxBuffer = 2000) {
    this.maxBuffer = maxBuffer;
    this.stdout = process.stdout;
    this.stderr = process.stderr;
  }

  info(...args: unknown[]): void {
    this.write({
      level: "info",
      message: args.map(String).join(" "),
      timestamp: Date.now(),
    });
  }

  error(...args: unknown[]): void {
    this.write({
      level: "error",
      message: args.map(String).join(" "),
      timestamp: Date.now(),
    });
  }

  warn(...args: unknown[]): void {
    this.write({
      level: "warn",
      message: args.map(String).join(" "),
      timestamp: Date.now(),
    });
  }

  getBuffer(): LogEntry[] {
    return [...this.buffer];
  }

  subscribe(fn: (entry: LogEntry) => void): () => void {
    this.emitter.on("entry", fn);
    return () => this.emitter.off("entry", fn);
  }

  private write(entry: LogEntry): void {
    this.buffer.push(entry);
    if (this.buffer.length > this.maxBuffer) {
      this.buffer = this.buffer.slice(-this.maxBuffer);
    }
    this.emitter.emit("entry", entry);

    const dest = entry.level === "info" ? this.stdout : this.stderr;
    dest.write(entry.message + "\n");
  }
}

export const logger = new Logger();
