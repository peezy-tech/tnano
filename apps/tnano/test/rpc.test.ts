import { describe, expect, it } from "vite-plus/test";

import { runCli } from "../src/cli.ts";
import type { SendInput, SendResult } from "../src/runtimePort.ts";
import { memoryIo, TestRuntime } from "./testRuntime.ts";

class RequestRuntime extends TestRuntime {
  #resolveResponse: (() => void) | undefined;

  override async send(input: SendInput): Promise<SendResult> {
    this.emit({
      kind: "request.opened",
      sessionId: input.sessionId,
      data: { requestId: "approval-1", request: { kind: "approval" } },
    });
    await new Promise<void>((resolve) => {
      this.#resolveResponse = resolve;
    });
    this.emit({
      kind: "content.delta",
      sessionId: input.sessionId,
      data: { text: "approved" },
    });
    return { sessionId: input.sessionId, text: "approved" };
  }

  override async respond(sessionId: string, requestId: string, response: unknown): Promise<void> {
    await super.respond(sessionId, requestId, response);
    this.#resolveResponse?.();
  }
}

class InterruptRuntime extends TestRuntime {
  #resolveInterrupt: (() => void) | undefined;

  override async send(input: SendInput): Promise<SendResult> {
    this.emit({
      kind: "turn.state",
      sessionId: input.sessionId,
      data: { state: "running" },
    });
    await new Promise<void>((resolve) => {
      this.#resolveInterrupt = resolve;
    });
    this.emit({
      kind: "turn.state",
      sessionId: input.sessionId,
      data: { state: "interrupted" },
    });
    return { sessionId: input.sessionId };
  }

  override async interrupt(sessionId: string): Promise<void> {
    await super.interrupt(sessionId);
    this.#resolveInterrupt?.();
  }
}

describe("RPC mode", () => {
  it("correlates responses and emits event notifications as strict JSONL", async () => {
    const input = [
      { id: 1, method: "initialize" },
      {
        id: 2,
        method: "session.start",
        params: { profileId: "echo-main", cwd: "/repo" },
      },
      {
        id: "send",
        method: "session.send",
        params: { sessionId: "session-1", prompt: "hello" },
      },
      { id: 4, method: "shutdown" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const io = memoryIo(`${input}\n`);

    const exitCode = await runCli(["--mode", "rpc"], io, () => new TestRuntime());

    expect(exitCode).toBe(0);
    const records = io
      .outputText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((record) => record.id === 1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
    });
    expect(records.find((record) => record.id === "send")).toMatchObject({
      jsonrpc: "2.0",
      id: "send",
    });
    expect(records.filter((record) => record.method === "event")).toHaveLength(3);
    expect(records.at(-1)).toMatchObject({ id: 4, result: { ok: true } });
    expect(io.errorText()).toBe("");
  });

  it("rejects calls made before initialize without corrupting stdout", async () => {
    const io = memoryIo(`${JSON.stringify({ id: 1, method: "profile.list" })}\n`);
    const exitCode = await runCli(["--mode", "rpc"], io, () => new TestRuntime());
    expect(exitCode).toBe(0);
    expect(JSON.parse(io.outputText())).toMatchObject({
      id: 1,
      error: { code: "conflict" },
    });
    expect(io.errorText()).toBe("");
  });

  it("accepts session.respond while session.send is awaiting input", async () => {
    const input = [
      { id: 1, method: "initialize" },
      {
        id: 2,
        method: "session.start",
        params: { profileId: "echo-main", cwd: "/repo" },
      },
      {
        id: 3,
        method: "session.send",
        params: { sessionId: "session-1", prompt: "needs approval" },
      },
      {
        id: 4,
        method: "session.send",
        params: { sessionId: "session-1", prompt: "duplicate" },
      },
      {
        id: 5,
        method: "session.respond",
        params: { sessionId: "session-1", requestId: "approval-1", response: true },
      },
      { id: 6, method: "shutdown" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const io = memoryIo(`${input}\n`);

    await expect(runCli(["--mode", "rpc"], io, () => new RequestRuntime())).resolves.toBe(0);
    const records = io
      .outputText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((record) => record.id === 3)).toMatchObject({
      result: { accepted: true, sessionId: "session-1" },
    });
    expect(records.find((record) => record.id === 4)).toMatchObject({
      error: { code: "conflict" },
    });
    expect(records.find((record) => record.id === 5)).toMatchObject({
      result: { ok: true },
    });
    expect(records.some((record) => record.method === "event")).toBe(true);
  });

  it("accepts session.interrupt while a send is active", async () => {
    const input = [
      { id: 1, method: "initialize" },
      {
        id: 2,
        method: "session.start",
        params: { profileId: "echo-main", cwd: "/repo" },
      },
      {
        id: 3,
        method: "session.send",
        params: { sessionId: "session-1", prompt: "HOLD" },
      },
      {
        id: 4,
        method: "session.interrupt",
        params: { sessionId: "session-1" },
      },
      { id: 5, method: "shutdown" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    const io = memoryIo(`${input}\n`);

    await expect(runCli(["--mode", "rpc"], io, () => new InterruptRuntime())).resolves.toBe(0);
    const records = io
      .outputText()
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.find((record) => record.id === 3)).toMatchObject({
      result: { accepted: true, sessionId: "session-1" },
    });
    expect(records.find((record) => record.id === 4)).toMatchObject({
      result: { ok: true },
    });
    expect(
      records.some(
        (record) =>
          record.method === "event" && JSON.stringify(record).includes('"state":"interrupted"'),
      ),
    ).toBe(true);
  });
});
