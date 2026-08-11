import type { JsonObject, JsonValue } from "@t-nano/sdk";

export type CodexNormalizedEvent =
  | {
      readonly type: "binding";
      readonly threadId: string;
      readonly raw: JsonObject;
    }
  | {
      readonly type: "turn";
      readonly state: "running" | "completed" | "failed";
      readonly raw: JsonObject;
    }
  | {
      readonly type: "activity";
      readonly activityId: string;
      readonly phase: "started" | "updated" | "completed";
      readonly item: JsonObject;
      readonly raw: JsonObject;
    }
  | {
      readonly type: "content";
      readonly text: string;
      readonly raw: JsonObject;
    }
  | {
      readonly type: "error";
      readonly message: string;
      readonly raw: JsonObject;
    }
  | {
      readonly type: "custom";
      readonly name: string;
      readonly data: JsonValue;
    };

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(object: JsonObject, field: string): string | undefined {
  const value = object[field];
  return typeof value === "string" ? value : undefined;
}

function errorMessage(record: JsonObject, fallback: string): string {
  const direct = stringField(record, "message");
  if (direct) return direct;

  const error = record.error;
  if (typeof error === "string" && error.length > 0) return error;
  if (isJsonObject(error)) {
    const nested = stringField(error, "message");
    if (nested) return nested;
  }
  return fallback;
}

export function parseCodexRecord(value: JsonValue): readonly CodexNormalizedEvent[] {
  if (!isJsonObject(value)) {
    return [{ type: "custom", name: "codex.record", data: value }];
  }

  const nativeType = stringField(value, "type");
  switch (nativeType) {
    case "thread.started": {
      const threadId = stringField(value, "thread_id");
      return threadId
        ? [{ type: "binding", threadId, raw: value }]
        : [{ type: "custom", name: "codex.thread.started.invalid", data: value }];
    }
    case "turn.started":
      return [{ type: "turn", state: "running", raw: value }];
    case "turn.completed":
      return [{ type: "turn", state: "completed", raw: value }];
    case "turn.failed":
      return [
        { type: "turn", state: "failed", raw: value },
        {
          type: "error",
          message: errorMessage(value, "Codex turn failed"),
          raw: value,
        },
      ];
    case "error":
      return [
        {
          type: "error",
          message: errorMessage(value, "Codex reported an error"),
          raw: value,
        },
      ];
    case "item.started":
    case "item.updated":
    case "item.completed": {
      const item = value.item;
      if (!isJsonObject(item)) {
        return [{ type: "custom", name: `codex.${nativeType}.invalid`, data: value }];
      }

      const phase = nativeType.slice("item.".length) as "started" | "updated" | "completed";
      const itemId = stringField(item, "id") ?? `${stringField(item, "type") ?? "item"}:unknown`;
      const events: CodexNormalizedEvent[] = [
        { type: "activity", activityId: itemId, phase, item, raw: value },
      ];

      if (
        nativeType === "item.completed" &&
        stringField(item, "type") === "agent_message" &&
        typeof item.text === "string"
      ) {
        events.push({ type: "content", text: item.text, raw: value });
      }
      return events;
    }
    default:
      return [
        {
          type: "custom",
          name: nativeType ? `codex.${nativeType}` : "codex.record",
          data: value,
        },
      ];
  }
}

export function parseJsonLine(
  line: string,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false; readonly raw: string } {
  try {
    return { ok: true, value: JSON.parse(line) as JsonValue };
  } catch {
    return { ok: false, raw: line.slice(0, 8 * 1024) };
  }
}
