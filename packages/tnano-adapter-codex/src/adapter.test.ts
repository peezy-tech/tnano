import type { HarnessEventInput, HarnessProfile } from "@t-nano/sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCodexEnvironment,
  buildCodexExecArgs,
  createCodexAdapter,
  parseCodexProfileConfig,
} from "./adapter.ts";
import type {
  Clock,
  LaunchProcessInput,
  ProcessExit,
  ProcessLauncher,
  SpawnedProcess,
  TimeoutResult,
} from "./process.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

async function* chunks(values: readonly string[]): AsyncIterable<string> {
  for (const value of values) yield value;
}

class FakeChild implements SpawnedProcess {
  readonly stdout: AsyncIterable<string>;
  readonly stderr: AsyncIterable<string>;
  readonly exited: Promise<ProcessExit>;
  readonly signals: NodeJS.Signals[] = [];
  readonly inputs: string[] = [];
  private result: ProcessExit | undefined;
  private readonly settleExit: (value: ProcessExit) => void;
  private readonly exitOnSignal: NodeJS.Signals | undefined;

  constructor(input: {
    readonly stdout?: AsyncIterable<string>;
    readonly stderr?: AsyncIterable<string>;
    readonly exit?: ProcessExit;
    readonly exitOnSignal?: NodeJS.Signals;
  }) {
    this.stdout = input.stdout ?? chunks([]);
    this.stderr = input.stderr ?? chunks([]);
    this.exitOnSignal = input.exitOnSignal;
    const exit = deferred<ProcessExit>();
    this.exited = exit.promise;
    this.settleExit = exit.resolve;
    if (input.exit !== undefined) this.finish(input.exit);
  }

  getResult(): ProcessExit | undefined {
    return this.result;
  }

  async writeAndCloseStdin(input: string): Promise<void> {
    this.inputs.push(input);
  }

  signal(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === this.exitOnSignal) this.finish({ code: null, signal });
    return true;
  }

  finish(result: ProcessExit): void {
    if (this.result !== undefined) return;
    this.result = result;
    this.settleExit(result);
  }
}

class FakeLauncher implements ProcessLauncher {
  readonly launches: LaunchProcessInput[] = [];
  readonly children: FakeChild[] = [];
  private readonly queued: FakeChild[] = [];

  queue(child: FakeChild): void {
    this.queued.push(child);
  }

  launch(input: LaunchProcessInput): SpawnedProcess {
    const child = this.queued.shift();
    if (child === undefined) throw new Error(`Unexpected launch of ${input.command}`);
    this.launches.push(input);
    this.children.push(child);
    return child;
  }
}

const immediateClock: Clock = {
  async withTimeout<T>(promise: Promise<T>): Promise<TimeoutResult<T>> {
    const marker = Symbol("timeout");
    const result = await Promise.race([promise, Promise.resolve(marker)]);
    return result === marker ? { timedOut: true } : { timedOut: false, value: result as T };
  },
};

const profile: HarnessProfile = {
  id: "codex-work",
  harness: "codex",
  label: "Codex work",
  enabled: true,
  config: {
    codexHome: "/profiles/codex-work",
    extraArgs: ["--skip-git-repo-check"],
  },
  environment: {
    REMOVE_ME: null,
    PROFILE_FLAG: "enabled",
  },
};

const openInput = {
  profile,
  sessionId: "session-1",
  cwd: "/workspace/project",
  model: "gpt-test",
} as const;

describe("Codex profile and command construction", () => {
  it("applies safe defaults and keeps all shared flags before resume", () => {
    const config = parseCodexProfileConfig({
      ...profile,
      config: {},
    });
    expect(config).toEqual({
      command: "codex",
      extraArgs: [],
      sandbox: "read-only",
    });
    expect(
      buildCodexExecArgs({
        config,
        cwd: "/work",
        threadId: "native-thread",
      }),
    ).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      "/work",
      "resume",
      "native-thread",
      "-",
    ]);
  });

  it("applies profile environment unsets and explicit CODEX_HOME", () => {
    const config = parseCodexProfileConfig(profile);
    expect(
      buildCodexEnvironment(profile, config, {
        REMOVE_ME: "host-value",
        CODEX_HOME: "/host/codex",
      }),
    ).toEqual({
      CODEX_HOME: "/profiles/codex-work",
      PROFILE_FLAG: "enabled",
    });
  });
});

describe("Codex probing", () => {
  it("uses version and login-status subprocesses without reading credential files", async () => {
    const launcher = new FakeLauncher();
    launcher.queue(
      new FakeChild({
        stdout: chunks(["codex-cli 1.2.3\n"]),
        exit: { code: 0, signal: null },
      }),
    );
    launcher.queue(
      new FakeChild({
        stdout: chunks(["Logged in using ChatGPT\n"]),
        exit: { code: 0, signal: null },
      }),
    );
    const adapter = createCodexAdapter({
      launcher,
      clock: immediateClock,
      baseEnvironment: { REMOVE_ME: "host-value" },
    });

    await expect(adapter.probe(profile)).resolves.toEqual({
      status: "ready",
      message: "Logged in using ChatGPT",
      version: "codex-cli 1.2.3",
    });
    expect(launcher.launches.map(({ command, args }) => ({ command, args }))).toEqual([
      { command: "codex", args: ["--version"] },
      { command: "codex", args: ["login", "status"] },
    ]);
    expect(launcher.launches[0]?.env).toMatchObject({
      CODEX_HOME: "/profiles/codex-work",
      PROFILE_FLAG: "enabled",
    });
    expect(launcher.launches[0]?.env.REMOVE_ME).toBeUndefined();
  });

  it("honors an already-aborted probe signal without spawning", async () => {
    const launcher = new FakeLauncher();
    const adapter = createCodexAdapter({ launcher, clock: immediateClock });
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));

    await expect(adapter.probe(profile, controller.signal)).rejects.toThrow("cancelled");
    expect(launcher.launches).toEqual([]);
  });
});

describe("Codex exec sessions", () => {
  it("keeps two named profile homes and environment overrides isolated", async () => {
    const launcher = new FakeLauncher();
    launcher.queue(
      new FakeChild({
        stdout: chunks([
          '{"type":"thread.started","thread_id":"thread-work"}\n{"type":"turn.completed"}\n',
        ]),
        exit: { code: 0, signal: null },
      }),
    );
    launcher.queue(
      new FakeChild({
        stdout: chunks([
          '{"type":"thread.started","thread_id":"thread-personal"}\n{"type":"turn.completed"}\n',
        ]),
        exit: { code: 0, signal: null },
      }),
    );
    const personalProfile: HarnessProfile = {
      id: "codex-personal",
      harness: "codex",
      label: "Codex personal",
      enabled: true,
      config: { codexHome: "/profiles/codex-personal" },
      environment: { PROFILE_MARKER: "personal" },
    };
    const adapter = createCodexAdapter({
      launcher,
      clock: immediateClock,
      baseEnvironment: {
        CODEX_HOME: "/profiles/host-default",
        PROFILE_MARKER: "host",
        SHARED_MARKER: "shared",
      },
    });
    const work = await adapter.open({
      profile,
      sessionId: "session-work",
      cwd: "/workspace/project",
    });
    const personal = await adapter.open({
      profile: personalProfile,
      sessionId: "session-personal",
      cwd: "/workspace/project",
    });

    const [workEvents, personalEvents] = await Promise.all([
      Array.fromAsync(work.run({ text: "work" })),
      Array.fromAsync(personal.run({ text: "personal" })),
    ]);

    expect(launcher.launches.map((launch) => launch.env)).toEqual([
      {
        CODEX_HOME: "/profiles/codex-work",
        PROFILE_FLAG: "enabled",
        PROFILE_MARKER: "host",
        SHARED_MARKER: "shared",
      },
      {
        CODEX_HOME: "/profiles/codex-personal",
        PROFILE_MARKER: "personal",
        SHARED_MARKER: "shared",
      },
    ]);
    expect(workEvents[0]).toMatchObject({
      type: "binding.updated",
      binding: { profileId: "codex-work", codexHomeKey: "/profiles/codex-work" },
    });
    expect(personalEvents[0]).toMatchObject({
      type: "binding.updated",
      binding: {
        profileId: "codex-personal",
        codexHomeKey: "/profiles/codex-personal",
      },
    });
    expect(JSON.stringify(launcher.launches[1]?.env)).not.toContain("/profiles/codex-work");

    const workBinding =
      workEvents[0]?.type === "binding.updated" ? workEvents[0].binding : undefined;
    if (workBinding === undefined) throw new Error("Work session did not produce a binding");
    expect(() =>
      adapter.open({
        profile: personalProfile,
        sessionId: "session-work",
        cwd: "/workspace/project",
        resume: workBinding,
      }),
    ).toThrowError(expect.objectContaining({ code: "incompatible_resume" }));
    await Promise.all([work.close?.(), personal.close?.()]);
  });

  it("starts one subprocess, writes the prompt to stdin, and normalizes its JSONL", async () => {
    const launcher = new FakeLauncher();
    launcher.queue(
      new FakeChild({
        stdout: chunks([
          '{"type":"thread.started","thread_id":"native-1"}\n{"type":"turn.started"}\n',
          '{"type":"item.started","item":{"id":"cmd-1","type":"command_execution","command":"pwd"}}\n',
          '{"type":"future.event","value":1}\n{malformed\n',
          '{"type":"item.completed","item":{"id":"msg-1","type":"agent_message","text":"Finished"}}\n',
          '{"type":"turn.completed","usage":{"input_tokens":8,"output_tokens":2}}\n',
        ]),
        exit: { code: 0, signal: null },
      }),
    );
    const adapter = createCodexAdapter({
      launcher,
      clock: immediateClock,
      baseEnvironment: {},
    });
    const session = await adapter.open(openInput);

    expect(session.binding).toBeUndefined();
    const events = await Array.fromAsync(session.run({ text: "Do the work" }));

    expect(launcher.launches[0]).toEqual({
      command: "codex",
      args: [
        "exec",
        "--json",
        "--color",
        "never",
        "--sandbox",
        "read-only",
        "--cd",
        "/workspace/project",
        "--model",
        "gpt-test",
        "--skip-git-repo-check",
        "-",
      ],
      cwd: "/workspace/project",
      env: {
        CODEX_HOME: "/profiles/codex-work",
        PROFILE_FLAG: "enabled",
      },
    });
    expect(launcher.children[0]?.inputs).toEqual(["Do the work"]);
    expect(events).toEqual([
      {
        type: "binding.updated",
        binding: {
          schema: 1,
          threadId: "native-1",
          profileId: "codex-work",
          codexHomeKey: "/profiles/codex-work",
        },
      },
      {
        type: "turn.state",
        state: "running",
        detail: { type: "turn.started" },
      },
      {
        type: "activity.upsert",
        activityId: "cmd-1",
        activity: {
          phase: "started",
          item: {
            id: "cmd-1",
            type: "command_execution",
            command: "pwd",
          },
          native: {
            type: "item.started",
            item: {
              id: "cmd-1",
              type: "command_execution",
              command: "pwd",
            },
          },
        },
      },
      {
        type: "custom",
        name: "codex.future.event",
        payload: { type: "future.event", value: 1 },
      },
      {
        type: "custom",
        name: "codex.jsonl.malformed",
        payload: { raw: "{malformed" },
      },
      {
        type: "activity.upsert",
        activityId: "msg-1",
        activity: {
          phase: "completed",
          item: { id: "msg-1", type: "agent_message", text: "Finished" },
          native: {
            type: "item.completed",
            item: { id: "msg-1", type: "agent_message", text: "Finished" },
          },
        },
      },
      { type: "content.delta", text: "Finished", channel: "final" },
      {
        type: "turn.state",
        state: "completed",
        detail: {
          type: "turn.completed",
          usage: { input_tokens: 8, output_tokens: 2 },
        },
      },
    ] satisfies HarnessEventInput[]);
    expect(session.binding).toBeUndefined();
  });

  it("resumes the exact native thread and never falls back to a new thread", async () => {
    const launcher = new FakeLauncher();
    launcher.queue(
      new FakeChild({
        stdout: chunks(['{"type":"turn.failed","error":{"message":"thread not found"}}\n']),
        stderr: chunks(["resume failed"]),
        exit: { code: 1, signal: null },
      }),
    );
    const adapter = createCodexAdapter({ launcher, clock: immediateClock, baseEnvironment: {} });
    const binding = {
      schema: 1,
      threadId: "native-original",
      profileId: "codex-work",
      codexHomeKey: "/profiles/codex-work",
    } as const;
    const session = await adapter.open({ ...openInput, resume: binding });

    const events = await Array.fromAsync(session.run({ text: "Continue" }));

    expect(launcher.launches[0]?.args).toEqual([
      "exec",
      "--json",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--cd",
      "/workspace/project",
      "--model",
      "gpt-test",
      "--skip-git-repo-check",
      "resume",
      "native-original",
      "-",
    ]);
    expect(events).toEqual([
      {
        type: "turn.state",
        state: "failed",
        detail: {
          type: "turn.failed",
          error: { message: "thread not found" },
        },
      },
      {
        type: "error",
        code: "codex_error",
        message: "thread not found",
        recoverable: false,
        details: {
          type: "turn.failed",
          error: { message: "thread not found" },
        },
      },
    ]);
    expect(session.binding).toEqual(binding);
    expect(launcher.launches).toHaveLength(1);
  });

  it("rejects concurrent turns and interrupts only its captured child", async () => {
    const launcher = new FakeLauncher();
    const releaseStdout = deferred<void>();
    const child = new FakeChild({
      stdout: (async function* () {
        yield '{"type":"thread.started","thread_id":"native-hold"}\n';
        await releaseStdout.promise;
      })(),
      exitOnSignal: "SIGINT",
    });
    const originalSignal = child.signal.bind(child);
    child.signal = ((signal: NodeJS.Signals) => {
      const result = originalSignal(signal);
      if (signal === "SIGINT") releaseStdout.resolve();
      return result;
    }) as typeof child.signal;
    launcher.queue(child);
    const adapter = createCodexAdapter({ launcher, clock: immediateClock, baseEnvironment: {} });
    const session = await adapter.open(openInput);
    const first = session.run({ text: "Hold" })[Symbol.asyncIterator]();

    await expect(first.next()).resolves.toMatchObject({
      done: false,
      value: { type: "binding.updated" },
    });
    const second = session.run({ text: "Overlap" })[Symbol.asyncIterator]();
    await expect(second.next()).rejects.toMatchObject({ code: "turn_active" });

    await session.interrupt?.();
    const remaining: HarnessEventInput[] = [];
    for (;;) {
      const next = await first.next();
      if (next.done) break;
      remaining.push(next.value);
    }

    expect(child.signals).toEqual(["SIGINT"]);
    expect(remaining).toContainEqual({ type: "turn.state", state: "interrupted" });
  });
});
