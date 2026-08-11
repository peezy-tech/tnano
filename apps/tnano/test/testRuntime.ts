import * as NodeStream from "node:stream";

import type { CliIo } from "../src/io.ts";
import type {
  AddProfileInput,
  EventListener,
  HarnessSummary,
  ProfileSummary,
  RuntimeEvent,
  RuntimePort,
  SendInput,
  SendResult,
  SessionSummary,
  StartSessionInput,
} from "../src/runtimePort.ts";

export function memoryIo(input = ""): CliIo & { outputText(): string; errorText(): string } {
  const output = new NodeStream.PassThrough();
  const error = new NodeStream.PassThrough();
  let stdout = "";
  let stderr = "";
  output.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  error.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });
  return {
    input: NodeStream.Readable.from([input]),
    output,
    error,
    outputText: () => stdout,
    errorText: () => stderr,
  };
}

export class TestRuntime implements RuntimePort {
  readonly harnesses: HarnessSummary[] = [
    { id: "echo", label: "Echo", capabilities: ["streaming"] },
  ];
  readonly profiles: ProfileSummary[] = [
    { id: "echo-main", harnessId: "echo", label: "Echo main", status: "ready" },
  ];
  readonly sessions: SessionSummary[] = [];
  readonly listeners = new Set<EventListener>();
  initialized = false;
  closed = false;

  async initialize(): Promise<void> {
    this.initialized = true;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }

  async listHarnesses(): Promise<readonly HarnessSummary[]> {
    return this.harnesses;
  }

  async listProfiles(): Promise<readonly ProfileSummary[]> {
    return this.profiles;
  }

  async addProfile(input: AddProfileInput): Promise<ProfileSummary> {
    const profile: ProfileSummary = {
      id: input.id,
      harnessId: input.harnessId,
      label: input.label ?? input.id,
      status: "enabled",
    };
    this.profiles.push(profile);
    return profile;
  }

  async removeProfile(id: string): Promise<void> {
    const index = this.profiles.findIndex((profile) => profile.id === id);
    if (index >= 0) this.profiles.splice(index, 1);
  }

  async probeProfile(id: string): Promise<unknown> {
    return { profileId: id, status: "ready" };
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return this.sessions;
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    if (input.resumeSessionId !== undefined) {
      const found = this.sessions.find((session) => session.id === input.resumeSessionId);
      if (found !== undefined) return found;
    }
    const session: SessionSummary = {
      id: input.sessionId ?? `session-${this.sessions.length + 1}`,
      profileId: input.profileId,
      cwd: input.cwd,
      ...(input.model === undefined ? {} : { model: input.model }),
      state: "ready",
    };
    this.sessions.push(session);
    return session;
  }

  async send(input: SendInput): Promise<SendResult> {
    this.emit({
      kind: "content.delta",
      sessionId: input.sessionId,
      data: { text: "echo: " },
    });
    this.emit({
      kind: "content.delta",
      sessionId: input.sessionId,
      data: { text: input.prompt },
    });
    this.emit({
      kind: "turn.state",
      sessionId: input.sessionId,
      data: { state: "completed" },
    });
    return { sessionId: input.sessionId, text: `echo: ${input.prompt}` };
  }

  async interrupt(sessionId: string): Promise<void> {
    this.emit({ kind: "turn.state", sessionId, data: { state: "interrupted" } });
  }

  async stop(sessionId: string): Promise<void> {
    this.emit({ kind: "session.state", sessionId, data: { state: "stopped" } });
  }

  async respond(sessionId: string, requestId: string, response: unknown): Promise<void> {
    this.emit({
      kind: "request.resolved",
      sessionId,
      data: { requestId, response },
    });
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
