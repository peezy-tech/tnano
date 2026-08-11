import type * as NodeStream from "node:stream";

export type CliInput = NodeStream.Readable & { readonly isTTY?: boolean };
export type CliOutput = NodeStream.Writable & { readonly isTTY?: boolean };

export interface CliIo {
  input: CliInput;
  output: CliOutput;
  error: CliOutput;
}

export async function readAll(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let value = "";
  for await (const chunk of input) {
    value += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
  }
  return value + decoder.decode();
}

export function writeLine(output: Pick<NodeStream.Writable, "write">, value = ""): void {
  output.write(`${value}\n`);
}
