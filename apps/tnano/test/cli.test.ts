import { describe, expect, it } from "vite-plus/test";

import { runCli, type RuntimeFactoryOptions } from "../src/cli.ts";
import type { SendInput, SendResult } from "../src/runtimePort.ts";
import { memoryIo, TestRuntime } from "./testRuntime.ts";

class InteractiveRequestRuntime extends TestRuntime {
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

describe("runCli", () => {
  it("prints help without constructing a runtime", async () => {
    const io = memoryIo();
    let constructed = false;
    const exitCode = await runCli(["--help"], io, () => {
      constructed = true;
      return new TestRuntime();
    });

    expect(exitCode).toBe(0);
    expect(constructed).toBe(false);
    expect(io.outputText()).toContain("interactive");
    expect(io.outputText()).toContain("rpc");
  });

  it("forwards repeatable trusted adapters to the runtime factory in order", async () => {
    const io = memoryIo();
    let options: RuntimeFactoryOptions | undefined;
    const exitCode = await runCli(
      ["--adapter", "@example/first", "--adapter", "/opt/t-nano/second.mjs", "harnesses"],
      io,
      (received) => {
        options = received;
        return new TestRuntime();
      },
    );

    expect(exitCode).toBe(0);
    expect(options).toEqual({ adapters: ["@example/first", "/opt/t-nano/second.mjs"] });
  });

  it("keeps print-mode stdout to final assistant text", async () => {
    const io = memoryIo();
    const runtime = new TestRuntime();
    const exitCode = await runCli(
      ["--mode", "print", "--profile", "echo-main", "hello"],
      io,
      () => runtime,
    );

    expect(exitCode).toBe(0);
    expect(io.outputText()).toBe("echo: hello\n");
    expect(io.errorText()).toBe("");
    expect(runtime.closed).toBe(true);
  });

  it("emits one final JSON object in json mode", async () => {
    const io = memoryIo("hello from stdin");
    const exitCode = await runCli(
      ["--mode", "json", "--profile", "echo-main"],
      io,
      () => new TestRuntime(),
    );

    expect(exitCode).toBe(0);
    const result = JSON.parse(io.outputText()) as { ok: boolean; text: string; events: unknown[] };
    expect(result.ok).toBe(true);
    expect(result.text).toBe("echo: hello from stdin");
    expect(result.events).toHaveLength(3);
    expect(io.errorText()).toBe("");
  });

  it("routes profile management through the runtime", async () => {
    const io = memoryIo();
    const runtime = new TestRuntime();
    const exitCode = await runCli(
      [
        "profile",
        "add",
        "work",
        "--harness",
        "echo",
        "--label",
        "Work",
        "--config-json",
        '{"delay":0}',
      ],
      io,
      () => runtime,
    );

    expect(exitCode).toBe(0);
    expect(runtime.profiles).toContainEqual({
      id: "work",
      harnessId: "echo",
      label: "Work",
      status: "enabled",
    });
  });

  it("rejects profile add when the id already exists", async () => {
    const io = memoryIo();
    const runtime = new TestRuntime();
    const original = [...runtime.profiles];
    const exitCode = await runCli(
      ["profile", "add", "echo-main", "--harness", "echo", "--label", "Replacement"],
      io,
      () => runtime,
    );

    expect(exitCode).toBe(3);
    expect(io.outputText()).toBe("");
    expect(io.errorText()).toContain("Profile already exists: echo-main");
    expect(runtime.profiles).toEqual(original);
  });

  it("uses the interactive line REPL by default", async () => {
    const io = memoryIo("/profile echo-main\nhello interactively\n/exit\n");
    const exitCode = await runCli([], io, () => new TestRuntime());

    expect(exitCode).toBe(0);
    expect(io.outputText()).toContain("Profile: echo-main\n");
    expect(io.outputText()).toContain("echo: hello interactively\n");
    expect(io.errorText()).toBe("");
  });

  it("can answer a request while an interactive turn is pending", async () => {
    const io = memoryIo("/profile echo-main\nneeds approval\n/respond approval-1 true\n/exit\n");
    const exitCode = await runCli([], io, () => new InteractiveRequestRuntime());

    expect(exitCode).toBe(0);
    expect(io.outputText()).toContain("approved\n");
    expect(io.errorText()).toContain("[input required: approval-1]\n");
    expect(io.errorText()).not.toContain("There is no active session");
  });
});
