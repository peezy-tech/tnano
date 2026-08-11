import type * as NodeStream from "node:stream";

import type {
  HarnessSummary,
  ProfileSummary,
  RuntimeEvent,
  SessionSummary,
} from "./runtimePort.ts";
import { writeLine } from "./io.ts";

function field(record: unknown, ...names: string[]): unknown {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return undefined;
  const object = record as Record<string, unknown>;
  for (const name of names) {
    if (object[name] !== undefined) return object[name];
  }
  return undefined;
}

export function eventText(event: RuntimeEvent): string | undefined {
  if (event.kind !== "content.delta") return undefined;
  const text = field(event.data, "text");
  if (typeof text === "string") return text;
  const direct = field(event, "text");
  return typeof direct === "string" ? direct : undefined;
}

export function renderEvent(
  event: RuntimeEvent,
  output: NodeStream.Writable,
  error: NodeStream.Writable,
): void {
  const text = eventText(event);
  if (text !== undefined) {
    output.write(text);
    return;
  }

  if (event.kind === "error") {
    const message = field(event.data, "message") ?? field(event, "message") ?? "Harness error";
    writeLine(error, `[error] ${String(message)}`);
    return;
  }
  if (event.kind === "request.opened") {
    const requestId = field(event.data, "requestId") ?? field(event, "requestId") ?? "unknown";
    writeLine(error, `[input required: ${String(requestId)}]`);
    return;
  }
  if (event.kind === "session.state" || event.kind === "turn.state") {
    const state = field(event.data, "state") ?? field(event, "state");
    if (state === "failed" || state === "interrupted" || state === "waiting") {
      writeLine(error, `[${event.kind}: ${String(state)}]`);
    }
  }
}

export function printHarnesses(
  output: NodeStream.Writable,
  harnesses: readonly HarnessSummary[],
): void {
  if (harnesses.length === 0) {
    writeLine(output, "No harnesses registered.");
    return;
  }
  for (const harness of harnesses) {
    const capabilities = harness.capabilities?.join(",") ?? "";
    writeLine(
      output,
      [harness.id, harness.label ?? harness.id, harness.version ?? "", capabilities].join("\t"),
    );
  }
}

export function printProfiles(
  output: NodeStream.Writable,
  profiles: readonly ProfileSummary[],
): void {
  if (profiles.length === 0) {
    writeLine(output, "No profiles configured.");
    return;
  }
  for (const profile of profiles) {
    writeLine(
      output,
      [profile.id, profile.harnessId, profile.label ?? profile.id, profile.status ?? ""].join("\t"),
    );
  }
}

export function printSessions(
  output: NodeStream.Writable,
  sessions: readonly SessionSummary[],
): void {
  if (sessions.length === 0) {
    writeLine(output, "No sessions.");
    return;
  }
  for (const session of sessions) {
    writeLine(
      output,
      [session.id, session.state ?? "", session.profileId, session.model ?? "", session.cwd].join(
        "\t",
      ),
    );
  }
}

export function printJson(output: NodeStream.Writable, value: unknown): void {
  writeLine(output, JSON.stringify(value));
}

export function printPrettyJson(output: NodeStream.Writable, value: unknown): void {
  writeLine(output, JSON.stringify(value, null, 2));
}
