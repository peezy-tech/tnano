import { CliError, EXIT_CODES } from "./errors.ts";

const DEFAULT_MAX_LINE_LENGTH = 1024 * 1024;

/**
 * Splits exclusively on ASCII LF. CR, Unicode line separators, and chunk
 * boundaries are data; callers decide whether the resulting JSON is valid.
 */
export async function* splitLfDelimited(
  input: AsyncIterable<Uint8Array | string>,
  maximumLineLength = DEFAULT_MAX_LINE_LENGTH,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      if (newline > maximumLineLength) {
        throw new CliError(
          "protocol_error",
          `RPC record exceeds ${maximumLineLength} characters`,
          EXIT_CODES.protocol,
        );
      }
      yield buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
    if (buffer.length > maximumLineLength) {
      throw new CliError(
        "protocol_error",
        `RPC record exceeds ${maximumLineLength} characters`,
        EXIT_CODES.protocol,
      );
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    throw new CliError(
      "protocol_error",
      "RPC input ended with an unterminated JSON record",
      EXIT_CODES.protocol,
    );
  }
}

export function parseJsonRecord(line: string): unknown {
  if (line.length === 0) {
    throw new CliError("protocol_error", "RPC records may not be empty", EXIT_CODES.protocol);
  }
  try {
    return JSON.parse(line) as unknown;
  } catch (error) {
    throw new CliError("protocol_error", "Invalid JSON RPC record", EXIT_CODES.protocol, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export interface WritableText {
  write(chunk: string): unknown;
}

export function writeJsonLine(output: WritableText, value: unknown): void {
  output.write(`${JSON.stringify(value)}\n`);
}
