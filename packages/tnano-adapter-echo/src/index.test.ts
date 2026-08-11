import type { HarnessEventInput, HarnessProfile, HarnessSession, JsonValue } from "@t-nano/sdk";
import { describe, expect, it } from "vite-plus/test";

import echoAdapter, { createEchoAdapter, EchoAdapterError } from "./index.ts";

const profile: HarnessProfile = {
  id: "echo-test",
  harness: "echo",
  label: "Echo test",
  enabled: true,
  config: {},
};

async function openSession(sessionId: string, resume?: JsonValue): Promise<HarnessSession> {
  return createEchoAdapter().open({
    profile,
    sessionId,
    cwd: "/echo-test",
    ...(resume === undefined ? {} : { resume }),
  });
}

async function collect(events: AsyncIterable<HarnessEventInput>): Promise<HarnessEventInput[]> {
  const collected: HarnessEventInput[] = [];
  for await (const event of events) collected.push(event);
  return collected;
}

function states(events: readonly HarnessEventInput[]): string[] {
  return events
    .filter((event) => event.type === "session.state" || event.type === "turn.state")
    .map((event) => event.state);
}

function deltas(events: readonly HarnessEventInput[]): string[] {
  return events.filter((event) => event.type === "content.delta").map((event) => event.text);
}

describe("echo adapter", () => {
  it("exports deterministic manifest and probe metadata", async () => {
    expect(echoAdapter.manifest).toEqual({
      apiVersion: 1,
      id: "echo",
      label: "Echo",
      version: "1.0.0",
      capabilities: ["resume", "interrupt"],
    });

    await expect(echoAdapter.probe(profile)).resolves.toEqual({
      status: "ready",
      version: "1.0.0",
      account: { id: "echo-local", label: "echo-local" },
      models: [{ id: "echo-v1", label: "echo-v1", available: true }],
    });
  });

  it("preserves Unicode and newlines in a separate content delta", async () => {
    const input = "héllo, 世界 👋\nsecond line\n";
    const session = await openSession("unicode");
    const events = await collect(session.run({ text: input }));

    expect(states(events)).toEqual(["running", "running", "completed", "ready"]);
    expect(deltas(events)).toEqual(["echo: ", input]);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
  });

  it("emits a structured failure and failed turn for FAIL", async () => {
    const session = await openSession("failure");
    const events = await collect(session.run({ text: "FAIL" }));

    expect(events.find((event) => event.type === "error")).toEqual({
      type: "error",
      code: "echo_failure",
      message: "Echo adapter received FAIL.",
      recoverable: true,
    });
    expect(states(events)).toEqual(["running", "running", "failed", "ready"]);
    expect(deltas(events)).toEqual([]);
  });

  it("round-trips and validates its session binding", async () => {
    const first = await openSession("resume-me");
    expect(first.binding).toEqual({ schema: 1, nativeSessionId: "echo:resume-me" });

    const serialized = JSON.stringify(first.binding);
    const resumed = await openSession("resume-me", JSON.parse(serialized) as JsonValue);
    expect(resumed.binding).toEqual(first.binding);

    await expect(
      openSession("resume-me", { schema: 1, nativeSessionId: "echo:someone-else" }),
    ).rejects.toMatchObject({ code: "invalid-resume" });
    await expect(openSession("resume-me", { schema: 2 })).rejects.toMatchObject({
      code: "invalid-resume",
    });
    await expect(openSession("resume-me", null)).rejects.toBeInstanceOf(EchoAdapterError);
  });

  it("rejects concurrent turns and future work after an idempotent close", async () => {
    const session = await openSession("lifecycle");
    const iterator = session.run({ text: "HOLD" })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "session.state" },
    });
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { type: "turn.state" },
    });
    expect(() => session.run({ text: "second" })).toThrowError(
      expect.objectContaining({ code: "busy" }),
    );

    await session.close?.();
    await session.close?.();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
    expect(() => session.run({ text: "after close" })).toThrowError(
      expect.objectContaining({ code: "closed" }),
    );
  });

  it("interrupts HOLD deterministically and idempotently", async () => {
    const session = await openSession("interrupt");
    const iterator = session.run({ text: "HOLD" })[Symbol.asyncIterator]();

    await iterator.next();
    await iterator.next();
    await session.interrupt?.();
    await session.interrupt?.();

    const remaining: HarnessEventInput[] = [];
    for (;;) {
      const result = await iterator.next();
      if (result.done) break;
      remaining.push(result.value);
    }
    expect(states(remaining)).toEqual(["interrupted", "ready"]);
    expect(deltas(remaining)).toEqual([]);
  });

  it("isolates active turns between sessions", async () => {
    const adapter = createEchoAdapter();
    const first = await adapter.open({
      profile,
      sessionId: "first",
      cwd: "/echo-test",
    });
    const second = await adapter.open({
      profile: { ...profile, id: "echo-other" },
      sessionId: "second",
      cwd: "/other",
    });
    const held = first.run({ text: "HOLD" })[Symbol.asyncIterator]();
    await held.next();
    await held.next();

    const secondEvents = await collect(second.run({ text: "independent" }));
    expect(deltas(secondEvents)).toEqual(["echo: ", "independent"]);
    expect(() => first.run({ text: "still busy" })).toThrowError(
      expect.objectContaining({ code: "busy" }),
    );

    await first.interrupt?.();
    await collect({ [Symbol.asyncIterator]: () => held });
  });

  it("suppresses the remainder of a turn after close", async () => {
    const session = await openSession("no-after-close");
    const iterator = session.run({ text: "not emitted" })[Symbol.asyncIterator]();

    await expect(iterator.next()).resolves.toMatchObject({ done: false });
    await session.close?.();
    await expect(iterator.next()).resolves.toEqual({ done: true, value: undefined });
  });
});
