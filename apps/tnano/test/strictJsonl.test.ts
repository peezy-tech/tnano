import * as NodeStream from "node:stream";

import { describe, expect, it } from "vite-plus/test";

import { splitLfDelimited } from "../src/strictJsonl.ts";

async function collect(input: AsyncIterable<Uint8Array | string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of splitLfDelimited(input)) lines.push(line);
  return lines;
}

describe("splitLfDelimited", () => {
  it("splits only on LF across arbitrary chunk boundaries", async () => {
    await expect(
      collect(NodeStream.Readable.from(['{"text":"a\u2028b"}', '\n{"id":', "2}\n"])),
    ).resolves.toEqual(['{"text":"a\u2028b"}', '{"id":2}']);
  });

  it("rejects a final record without an LF terminator", async () => {
    await expect(collect(NodeStream.Readable.from(['{"id":1}']))).rejects.toThrow("unterminated");
  });
});
