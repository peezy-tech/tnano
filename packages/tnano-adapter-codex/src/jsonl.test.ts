import { describe, expect, it } from "vite-plus/test";

import { parseCodexRecord, parseJsonLine } from "./jsonl.ts";

describe("Codex JSONL normalization", () => {
  it("extracts the opaque native thread binding", () => {
    expect(
      parseCodexRecord({
        type: "thread.started",
        thread_id: "thread-native-1",
      }),
    ).toEqual([
      {
        type: "binding",
        threadId: "thread-native-1",
        raw: { type: "thread.started", thread_id: "thread-native-1" },
      },
    ]);
  });

  it("maps turn lifecycle records and preserves native details", () => {
    expect(parseCodexRecord({ type: "turn.started" })).toEqual([
      { type: "turn", state: "running", raw: { type: "turn.started" } },
    ]);
    expect(
      parseCodexRecord({
        type: "turn.completed",
        usage: { input_tokens: 10, output_tokens: 4 },
      }),
    ).toEqual([
      {
        type: "turn",
        state: "completed",
        raw: {
          type: "turn.completed",
          usage: { input_tokens: 10, output_tokens: 4 },
        },
      },
    ]);
  });

  it("emits activities and final assistant content without inventing deltas", () => {
    expect(
      parseCodexRecord({
        type: "item.completed",
        item: {
          id: "item-1",
          type: "agent_message",
          text: "Done.",
        },
      }),
    ).toEqual([
      {
        type: "activity",
        activityId: "item-1",
        phase: "completed",
        item: { id: "item-1", type: "agent_message", text: "Done." },
        raw: {
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: "Done." },
        },
      },
      {
        type: "content",
        text: "Done.",
        raw: {
          type: "item.completed",
          item: { id: "item-1", type: "agent_message", text: "Done." },
        },
      },
    ]);
  });

  it("keeps unknown native records visible as namespaced custom events", () => {
    const record = { type: "future.event", payload: { value: true } } as const;
    expect(parseCodexRecord(record)).toEqual([
      { type: "custom", name: "codex.future.event", data: record },
    ]);
  });

  it("reports turn failures as lifecycle and error records", () => {
    const record = { type: "turn.failed", error: { message: "resume missing" } } as const;
    expect(parseCodexRecord(record)).toEqual([
      { type: "turn", state: "failed", raw: record },
      { type: "error", message: "resume missing", raw: record },
    ]);
  });

  it("tolerates malformed lines without throwing", () => {
    expect(parseJsonLine("{not-json")).toEqual({ ok: false, raw: "{not-json" });
    expect(parseJsonLine("  ")).toEqual({ ok: false, raw: "  " });
  });
});
