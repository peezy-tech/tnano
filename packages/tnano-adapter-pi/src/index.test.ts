import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import type { HarnessEventInput, HarnessProfile } from "@t-nano/sdk";
import { createPiAdapter, PiAdapterError } from "./index.ts";
import { FakePiChild, FakePiDeadlineFactory, FakePiLauncher, tick } from "./fakes.test-support.ts";
import { PiDeadlineExceededError } from "./process.ts";

const profile: HarnessProfile = {
  id: "pi-work",
  harness: "pi",
  label: "Pi work",
  enabled: true,
  config: {
    command: "custom-pi",
    agentDir: "/profiles/pi-work",
    sessionDir: "/sessions/pi-work",
    provider: "openai",
    thinking: "high",
    extraArgs: ["--no-extensions"],
  },
  environment: {
    KEEP_ME: "yes",
    REMOVE_ME: null,
  },
};

function installRpcResponder(
  child: FakePiChild,
  sessionId = "native-1",
  sessionFile = "/sessions/pi-work/native-1.jsonl",
) {
  const state = {
    sessionId,
    sessionFile,
    isStreaming: false,
  };
  child.onWrite = (record) => {
    if (record.type === "prompt") state.isStreaming = true;
    if (record.type === "get_state" || record.type === "prompt" || record.type === "abort") {
      child.emit({
        id: record.id,
        type: "response",
        command: record.type,
        success: true,
        ...(record.type === "get_state" ? { data: { ...state } } : {}),
      });
    }
  };
  return state;
}

function finiteCommand(stdout: string, exitCode = 0): FakePiChild {
  const child = new FakePiChild();
  child.onEndStdin = () => {
    child.emitText(stdout);
    child.exit(exitCode, null);
    child.endStdout();
    child.close();
  };
  return child;
}

async function collect(events: AsyncIterable<HarnessEventInput>): Promise<HarnessEventInput[]> {
  const result: HarnessEventInput[] = [];
  for await (const event of events) result.push(event);
  return result;
}

NodeTest.test("probe reports version and redacted auth readiness", async () => {
  const launcher = new FakePiLauncher();
  launcher.spawnChildren.push(
    finiteCommand("pi 1.2.3\n"),
    finiteCommand('{"status":"ready","provider":"openai","authType":"oauth"}\n'),
  );
  const result = await createPiAdapter({ launcher }).probe(profile);

  NodeAssert.equal(result.status, "ready");
  NodeAssert.equal(result.version, "pi 1.2.3");
  NodeAssert.deepEqual(result.metadata, { provider: "openai", authType: "oauth" });
  NodeAssert.equal(result.account, undefined);
  NodeAssert.deepEqual(launcher.spawns[1]?.args, [
    "auth",
    "check",
    "--provider",
    "openai",
    "--json",
    "--no-refresh",
  ]);
  NodeAssert.equal(launcher.spawns[1]?.args.includes("--credentials"), false);
  NodeAssert.equal(launcher.spawns[1]?.options.env.PI_CODING_AGENT_DIR, "/profiles/pi-work");
});

NodeTest.test("opens persistent RPC, maps a turn, resolves UI, and persists binding", async () => {
  const launcher = new FakePiLauncher();
  const state = installRpcResponder(launcher.child);
  const session = await createPiAdapter({ launcher }).open({
    profile,
    sessionId: "tnano-session",
    cwd: "/workspace",
    model: "openai/gpt-test",
  });

  NodeAssert.deepEqual(launcher.spawns[0]?.args, [
    "--no-extensions",
    "--mode",
    "rpc",
    "--provider",
    "openai",
    "--model",
    "openai/gpt-test",
    "--thinking",
    "high",
  ]);
  NodeAssert.equal(
    launcher.spawns[0]?.options.env.PI_CODING_AGENT_SESSION_DIR,
    "/sessions/pi-work",
  );
  NodeAssert.deepEqual(session.binding, {
    schema: 1,
    profileId: "pi-work",
    cwd: "/workspace",
    sessionId: "native-1",
    sessionFile: "/sessions/pi-work/native-1.jsonl",
  });

  const collected = collect(session.run({ text: "hello" }));
  await tick();
  launcher.child.emit({ type: "agent_start" });
  launcher.child.emit({
    type: "message_update",
    assistantMessageEvent: { type: "text_delta", delta: "Hello " },
  });
  launcher.child.emit({
    type: "message_update",
    assistantMessageEvent: { type: "thinking_delta", delta: "hmm" },
  });
  launcher.child.emit({
    type: "tool_execution_start",
    toolCallId: "tool-1",
    toolName: "bash",
    args: { command: "pwd" },
  });
  launcher.child.emit({
    type: "extension_ui_request",
    id: "ui-1",
    method: "confirm",
    title: "Continue?",
    message: "Proceed",
  });
  await session.respond?.("ui-1", true);
  launcher.child.emit({ type: "future_event", value: 42 });
  state.isStreaming = false;
  launcher.child.emit({ type: "agent_settled" });
  const events = await collected;

  NodeAssert.ok(
    events.some((event) => event.type === "session.state" && event.state === "running"),
  );
  NodeAssert.ok(
    events.some(
      (event) =>
        event.type === "content.delta" && event.channel === "assistant" && event.text === "Hello ",
    ),
  );
  NodeAssert.ok(
    events.some(
      (event) =>
        event.type === "content.delta" && event.channel === "thinking" && event.text === "hmm",
    ),
  );
  NodeAssert.ok(events.some((event) => event.type === "activity.upsert"));
  NodeAssert.ok(events.some((event) => event.type === "request.opened"));
  NodeAssert.ok(events.some((event) => event.type === "request.resolved"));
  NodeAssert.ok(
    events.some((event) => event.type === "custom" && event.name === "pi.rpc.future_event"),
  );
  NodeAssert.ok(events.some((event) => event.type === "turn.state" && event.state === "completed"));
  await session.close?.();
});

NodeTest.test("keeps two named profile agent and session directories isolated", async () => {
  const workChild = new FakePiChild();
  const personalChild = new FakePiChild();
  installRpcResponder(workChild, "native-work", "/sessions/pi-work/native-work.jsonl");
  installRpcResponder(
    personalChild,
    "native-personal",
    "/sessions/pi-personal/native-personal.jsonl",
  );
  const launcher = new FakePiLauncher();
  launcher.spawnChildren.push(workChild, personalChild);
  const adapter = createPiAdapter({ launcher });
  const personalProfile: HarnessProfile = {
    id: "pi-personal",
    harness: "pi",
    label: "Pi personal",
    enabled: true,
    config: {
      agentDir: "/profiles/pi-personal",
      sessionDir: "/sessions/pi-personal",
      provider: "anthropic",
    },
    environment: { PROFILE_MARKER: "personal" },
  };

  const work = await adapter.open({
    profile,
    sessionId: "tnano-work",
    cwd: "/workspace",
  });
  const personal = await adapter.open({
    profile: personalProfile,
    sessionId: "tnano-personal",
    cwd: "/workspace",
  });

  NodeAssert.deepEqual(
    launcher.spawns.map((spawn) => spawn.options.env),
    [
      {
        KEEP_ME: "yes",
        REMOVE_ME: undefined,
        PI_CODING_AGENT_DIR: "/profiles/pi-work",
        PI_CODING_AGENT_SESSION_DIR: "/sessions/pi-work",
      },
      {
        PROFILE_MARKER: "personal",
        PI_CODING_AGENT_DIR: "/profiles/pi-personal",
        PI_CODING_AGENT_SESSION_DIR: "/sessions/pi-personal",
      },
    ],
  );
  NodeAssert.deepEqual(work.binding, {
    schema: 1,
    profileId: "pi-work",
    cwd: "/workspace",
    sessionId: "native-work",
    sessionFile: "/sessions/pi-work/native-work.jsonl",
  });
  NodeAssert.deepEqual(personal.binding, {
    schema: 1,
    profileId: "pi-personal",
    cwd: "/workspace",
    sessionId: "native-personal",
    sessionFile: "/sessions/pi-personal/native-personal.jsonl",
  });
  NodeAssert.doesNotMatch(JSON.stringify(launcher.spawns[1]?.options.env), /pi-work/u);
  const workBinding = work.binding;
  if (workBinding === undefined) throw new Error("Work session did not produce a binding");
  await NodeAssert.rejects(
    async () =>
      adapter.open({
        profile: personalProfile,
        sessionId: "tnano-work",
        cwd: "/workspace",
        resume: workBinding,
      }),
    (error: unknown) => error instanceof PiAdapterError && error.code === "invalid_resume",
  );

  await Promise.all([work.close?.(), personal.close?.()]);
});

NodeTest.test("resume requires an absolute, profile-pinned native session file", async () => {
  const launcher = new FakePiLauncher();
  await NodeAssert.rejects(
    async () =>
      createPiAdapter({ launcher }).open({
        profile,
        sessionId: "tnano-session",
        cwd: "/workspace",
        resume: {
          schema: 1,
          profileId: "pi-work",
          cwd: "/workspace",
          sessionId: "native-1",
          sessionFile: "relative.jsonl",
        },
      }),
    (error: unknown) => error instanceof PiAdapterError && error.code === "invalid_resume",
  );
  NodeAssert.equal(launcher.spawns.length, 0);
});

NodeTest.test(
  "close ends stdin then escalates only the captured child without timers",
  async () => {
    const child = new FakePiChild();
    child.waitResults = [false, false, true];
    installRpcResponder(child);
    const launcher = new FakePiLauncher(child);
    const session = await createPiAdapter({ launcher }).open({
      profile,
      sessionId: "tnano-session",
      cwd: "/workspace",
    });

    await session.close?.();
    NodeAssert.equal(child.stdinEnded, true);
    NodeAssert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  },
);

NodeTest.test("idle process death permanently closes the session to new turns", async () => {
  const child = new FakePiChild();
  installRpcResponder(child);
  const launcher = new FakePiLauncher(child);
  const session = await createPiAdapter({ launcher }).open({
    profile,
    sessionId: "tnano-session",
    cwd: "/workspace",
  });
  const writesBeforeDeath = child.writes.length;

  child.exit(1, null);
  child.endStdout();

  NodeAssert.throws(
    () => session.run({ text: "must not launch" }),
    (error: unknown) => error instanceof PiAdapterError && error.code === "dead",
  );
  NodeAssert.equal(child.writes.length, writesBeforeDeath);
  await session.close?.();
});

NodeTest.test("process death during settlement emits failed state and never ready", async () => {
  const child = new FakePiChild();
  let getStateCount = 0;
  child.onWrite = (record) => {
    if (record.type === "prompt") {
      child.emit({
        id: record.id,
        type: "response",
        command: "prompt",
        success: true,
      });
      return;
    }
    if (record.type === "get_state") {
      getStateCount += 1;
      if (getStateCount <= 2) {
        child.emit({
          id: record.id,
          type: "response",
          command: "get_state",
          success: true,
          data: {
            sessionId: "native-1",
            sessionFile: "/sessions/pi-work/native-1.jsonl",
            isStreaming: getStateCount === 2,
          },
        });
      }
    }
  };
  const launcher = new FakePiLauncher(child);
  const session = await createPiAdapter({ launcher }).open({
    profile,
    sessionId: "tnano-session",
    cwd: "/workspace",
  });
  const collected = collect(session.run({ text: "hello" }));
  await tick();
  child.emit({ type: "agent_start" });
  child.emit({ type: "agent_settled" });
  await tick();
  child.fail(new Error("transport lost"));
  const events = await collected;

  NodeAssert.ok(events.some((event) => event.type === "turn.state" && event.state === "failed"));
  NodeAssert.ok(events.some((event) => event.type === "session.state" && event.state === "failed"));
  NodeAssert.equal(
    events.some((event) => event.type === "session.state" && event.state === "ready"),
    false,
  );
  await session.close?.();
});

NodeTest.test("open cancellation bounds TERM/KILL and rejects a stuck handshake", async () => {
  const child = new FakePiChild();
  child.waitResults = [false, false, false];
  const launcher = new FakePiLauncher(child);
  const controller = new AbortController();
  const opening = Promise.resolve(
    createPiAdapter({ launcher }).open({
      profile,
      sessionId: "tnano-session",
      cwd: "/workspace",
      signal: controller.signal,
    }),
  );
  await tick();
  controller.abort(new Error("cancel open"));

  await NodeAssert.rejects(opening, /cancel open/u);
  NodeAssert.equal(child.stdinEnded, true);
  NodeAssert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

NodeTest.test("probe cancellation bounds TERM/KILL for an unresponsive child", async () => {
  const child = new FakePiChild();
  child.waitResults = [false, false];
  const launcher = new FakePiLauncher(child);
  const controller = new AbortController();
  const probing = Promise.resolve(createPiAdapter({ launcher }).probe(profile, controller.signal));
  await tick();
  controller.abort(new Error("cancel probe"));

  await NodeAssert.rejects(probing, /cancel probe/u);
  NodeAssert.equal(child.stdinEnded, true);
  NodeAssert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

NodeTest.test("adapter-owned probe deadline terminates a silent child", async () => {
  const child = new FakePiChild();
  child.waitResults = [false, false];
  const launcher = new FakePiLauncher(child);
  const deadlines = new FakePiDeadlineFactory();
  const probing = Promise.resolve(
    createPiAdapter({
      launcher,
      deadlineFactory: deadlines,
      probeDeadlineMs: 1,
    }).probe(profile),
  );
  await tick();

  NodeAssert.equal(deadlines.created[0]?.label, "Pi probe");
  NodeAssert.equal(deadlines.created[0]?.timeoutMs, 1);
  deadlines.expire();

  const result = await probing;
  NodeAssert.equal(result.status, "error");
  NodeAssert.match(result.message ?? "", /timed out after 1ms/u);
  NodeAssert.equal(child.stdinEnded, true);
  NodeAssert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  NodeAssert.equal(deadlines.created[0]?.disposed, true);
});

NodeTest.test("adapter-owned open deadline cleans up a silent child", async () => {
  const child = new FakePiChild();
  child.waitResults = [false, false, false];
  const launcher = new FakePiLauncher(child);
  const deadlines = new FakePiDeadlineFactory();
  const opening = Promise.resolve(
    createPiAdapter({
      launcher,
      deadlineFactory: deadlines,
      openDeadlineMs: 1,
    }).open({
      profile,
      sessionId: "tnano-session",
      cwd: "/workspace",
    }),
  );
  await tick();

  NodeAssert.equal(deadlines.created[0]?.label, "Pi RPC initialization");
  NodeAssert.equal(deadlines.created[0]?.timeoutMs, 1);
  deadlines.expire();

  await NodeAssert.rejects(
    opening,
    (error: unknown) => error instanceof PiDeadlineExceededError && error.message.includes("1ms"),
  );
  NodeAssert.equal(child.stdinEnded, true);
  NodeAssert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
  NodeAssert.equal(deadlines.created[0]?.disposed, true);
});

NodeTest.test("close cleans up even when its signal was already aborted", async () => {
  const child = new FakePiChild();
  installRpcResponder(child);
  const launcher = new FakePiLauncher(child);
  const session = await createPiAdapter({ launcher }).open({
    profile,
    sessionId: "tnano-session",
    cwd: "/workspace",
  });
  const controller = new AbortController();
  controller.abort();

  await session.close?.(controller.signal);
  NodeAssert.equal(child.stdinEnded, true);
});
