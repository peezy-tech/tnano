import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";
import { FakePiChild, tick } from "./fakes.test-support.ts";
import { PiRpcProtocolError } from "./jsonl.ts";
import { PiRpcClient, PiRpcCommandError } from "./rpc.ts";

function createClient(child: FakePiChild, events: Record<string, unknown>[] = []) {
  const errors: Error[] = [];
  const client = new PiRpcClient(child, {
    onEvent: (event) => events.push(event),
    onProtocolError: (error) => errors.push(error),
  });
  return { client, errors };
}

NodeTest.test("correlates out-of-order responses while preserving interleaved events", async () => {
  const child = new FakePiChild();
  const events: Record<string, unknown>[] = [];
  const { client } = createClient(child, events);
  const first = client.request({ type: "get_state" });
  const second = client.request({ type: "get_available_models" });
  await tick();

  child.emit({ type: "agent_start" });
  child.emit({
    id: "tnano-2",
    type: "response",
    command: "get_available_models",
    success: true,
    data: { models: [] },
  });
  child.emit({
    id: "tnano-1",
    type: "response",
    command: "get_state",
    success: true,
    data: {},
  });

  NodeAssert.equal((await first).command, "get_state");
  NodeAssert.equal((await second).command, "get_available_models");
  NodeAssert.deepEqual(events, [{ type: "agent_start" }]);
});

NodeTest.test(
  "serializes mutations but lets extension responses bypass a blocked prompt",
  async () => {
    const child = new FakePiChild();
    const { client } = createClient(child);
    const prompt = client.request({ type: "prompt", message: "/dialog" }, true);
    const model = client.request({ type: "set_model", provider: "openai", modelId: "gpt" }, true);
    await tick();
    NodeAssert.equal(child.writes.length, 1);

    await client.notify({ type: "extension_ui_response", id: "ui-1", confirmed: true }, false);
    NodeAssert.equal(child.writes.length, 2);
    NodeAssert.equal(JSON.parse(child.writes[1]!).type, "extension_ui_response");

    child.emit({
      id: "tnano-1",
      type: "response",
      command: "prompt",
      success: true,
    });
    await prompt;
    await tick();
    NodeAssert.equal(child.writes.length, 3);

    child.emit({
      id: "tnano-2",
      type: "response",
      command: "set_model",
      success: true,
      data: {},
    });
    await model;
  },
);

NodeTest.test("preserves command failures and rejects mismatched responses", async () => {
  const failedChild = new FakePiChild();
  const failedClient = createClient(failedChild).client;
  const failed = failedClient.request({ type: "prompt", message: "hello" });
  await tick();
  failedChild.emit({
    id: "tnano-1",
    type: "response",
    command: "prompt",
    success: false,
    error: "not accepted",
  });
  await NodeAssert.rejects(failed, (error: unknown) => {
    NodeAssert.ok(error instanceof PiRpcCommandError);
    NodeAssert.equal(error.message, "not accepted");
    return true;
  });

  const mismatchChild = new FakePiChild();
  const mismatchClient = createClient(mismatchChild).client;
  const mismatch = mismatchClient.request({ type: "get_state" });
  await tick();
  mismatchChild.emit({
    id: "tnano-1",
    type: "response",
    command: "prompt",
    success: true,
  });
  await NodeAssert.rejects(mismatch, PiRpcProtocolError);
});

NodeTest.test("drains a final non-LF response before classifying process exit", async () => {
  const child = new FakePiChild();
  const { client, errors } = createClient(child);
  const request = client.request({ type: "get_state" });
  await tick();
  child.emit(
    {
      id: "tnano-1",
      type: "response",
      command: "get_state",
      success: true,
      data: {},
    },
    false,
  );
  child.exit(0, null);
  child.endStdout();

  NodeAssert.equal((await request).success, true);
  NodeAssert.equal(errors.length, 1);
});
