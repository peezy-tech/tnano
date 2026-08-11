import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { PiRpcProtocolError, StrictLfJsonlDecoder, serializeJsonRecord } from "./jsonl.ts";

NodeTest.test("strict LF decoder preserves Unicode separators across byte boundaries", () => {
  const source = `${JSON.stringify({ text: "a\u2028b\u2029c😀" })}\r\n`;
  const bytes = new TextEncoder().encode(source);
  const decoder = new StrictLfJsonlDecoder();
  const records: unknown[] = [];

  for (const byte of bytes) records.push(...decoder.push(Uint8Array.of(byte)));
  records.push(...decoder.finish());

  NodeAssert.deepEqual(records, [{ text: "a\u2028b\u2029c😀" }]);
});

NodeTest.test("strict LF decoder handles multiple records and a final record without LF", () => {
  const decoder = new StrictLfJsonlDecoder();
  NodeAssert.deepEqual(decoder.push('{"one":1}\n{"two":2}'), [{ one: 1 }]);
  NodeAssert.deepEqual(decoder.finish(), [{ two: 2 }]);
});

NodeTest.test("strict LF decoder rejects empty, malformed, and oversized records", () => {
  NodeAssert.throws(() => new StrictLfJsonlDecoder().push("\n"), PiRpcProtocolError);
  NodeAssert.throws(() => new StrictLfJsonlDecoder().push("{nope}\n"), PiRpcProtocolError);
  NodeAssert.throws(() => new StrictLfJsonlDecoder(5).push('{"long":true}\n'), PiRpcProtocolError);
  NodeAssert.throws(() => new StrictLfJsonlDecoder(5).push("123456"), PiRpcProtocolError);
});

NodeTest.test("serializer emits exactly one LF-terminated record", () => {
  NodeAssert.equal(serializeJsonRecord({ type: "get_state" }), '{"type":"get_state"}\n');
});
