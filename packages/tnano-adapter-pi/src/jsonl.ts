const DEFAULT_MAX_RECORD_BYTES = 4 * 1024 * 1024;

/**
 * Pi RPC is LF-delimited JSON, not JavaScript's broader notion of lines.
 * U+2028 and U+2029 are valid inside JSON strings and must remain untouched.
 */
export class StrictLfJsonlDecoder {
  readonly #decoder = new TextDecoder("utf-8", { fatal: true });
  readonly #maxRecordBytes: number;
  #buffer = "";

  constructor(maxRecordBytes = DEFAULT_MAX_RECORD_BYTES) {
    if (!Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
      throw new RangeError("maxRecordBytes must be a positive safe integer");
    }
    this.#maxRecordBytes = maxRecordBytes;
  }

  push(chunk: Uint8Array | string): unknown[] {
    this.#buffer +=
      typeof chunk === "string" ? chunk : this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  finish(): unknown[] {
    this.#buffer += this.#decoder.decode();
    return this.#drain(true);
  }

  #drain(atEnd: boolean): unknown[] {
    const records: unknown[] = [];
    let newline = this.#buffer.indexOf("\n");
    while (newline !== -1) {
      let line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#assertRecordSize(line);
      records.push(parseJsonRecord(line));
      newline = this.#buffer.indexOf("\n");
    }

    if (Buffer.byteLength(this.#buffer, "utf8") > this.#maxRecordBytes) {
      throw new PiRpcProtocolError(
        `Pi RPC record exceeded ${this.#maxRecordBytes} bytes without an LF delimiter`,
      );
    }
    if (atEnd && this.#buffer.length > 0) {
      let line = this.#buffer;
      this.#buffer = "";
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.#assertRecordSize(line);
      records.push(parseJsonRecord(line));
    }
    return records;
  }

  #assertRecordSize(line: string): void {
    if (Buffer.byteLength(line, "utf8") > this.#maxRecordBytes) {
      throw new PiRpcProtocolError(`Pi RPC record exceeded ${this.#maxRecordBytes} bytes`);
    }
  }
}

function parseJsonRecord(line: string): unknown {
  if (line.length === 0) {
    throw new PiRpcProtocolError("Pi RPC emitted an empty JSONL record");
  }
  try {
    return JSON.parse(line) as unknown;
  } catch (cause) {
    throw new PiRpcProtocolError("Pi RPC emitted invalid JSON", { cause });
  }
}

export function serializeJsonRecord(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new PiRpcProtocolError("Pi RPC command is not JSON serializable");
  }
  return `${serialized}\n`;
}

export class PiRpcProtocolError extends Error {
  override readonly name = "PiRpcProtocolError";
}
