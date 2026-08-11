import * as NodeAssert from "node:assert/strict";
import * as NodeTest from "node:test";

import { runAdapterConformance, type AdapterConformanceCase } from "./conformance.ts";
import type {
  HarnessAdapter,
  HarnessEventInput,
  HarnessProfile,
  HarnessSession,
  JsonValue,
} from "./types.ts";

const assert: typeof NodeAssert = NodeAssert;
const test: typeof NodeTest.test = NodeTest.test;

const workProfile = profile("work", "account-work");
const personalProfile = profile("personal", "account-personal");

const cases = [
  {
    profile: workProfile,
    sessionId: "session-work",
    cwd: "/workspace/work",
    run: { text: "work prompt" },
  },
  {
    profile: personalProfile,
    sessionId: "session-personal",
    cwd: "/workspace/personal",
    run: { text: "personal prompt" },
  },
] as const satisfies readonly [AdapterConformanceCase, AdapterConformanceCase];

test("public conformance helper exercises two profiles, events, capabilities, and resume", async () => {
  const openedProfiles: string[] = [];
  const adapter = fixtureAdapter(openedProfiles);
  const report = await runAdapterConformance({
    adapter,
    cases,
    verifyIsolation(context) {
      assert.deepEqual(
        context.probes.map((probe) => probe.account?.id),
        ["account-work", "account-personal"],
      );
      assert.deepEqual(context.bindings, [
        { schema: 1, profileId: "work", sessionId: "session-work" },
        { schema: 1, profileId: "personal", sessionId: "session-personal" },
      ]);
    },
  });

  assert.deepEqual(report, {
    adapterId: "fixture",
    checks: [
      "manifest",
      "profiles",
      "probes",
      "sessions",
      "events",
      "capabilities",
      "resume",
      "isolation",
    ],
  });
  assert.deepEqual(openedProfiles, ["work", "personal", "work", "personal"]);
});

test("public conformance helper rejects adapter mutation of a profile snapshot", async () => {
  const base = fixtureAdapter([]);
  const mutating: HarnessAdapter = {
    ...base,
    probe(profile) {
      (profile.config as { account: string }).account = "mutated";
      return { status: "ready" };
    },
  };

  await assert.rejects(
    runAdapterConformance({ adapter: mutating, cases, verifyIsolation() {} }),
    /Adapter mutated profile work during probe/u,
  );
});

function profile(id: string, account: string): HarnessProfile {
  return {
    id,
    harness: "fixture",
    label: `Fixture ${id}`,
    enabled: true,
    config: { account },
  };
}

function fixtureAdapter(openedProfiles: string[]): HarnessAdapter {
  return {
    manifest: {
      apiVersion: 1,
      id: "fixture",
      label: "Fixture",
      version: "1.0.0",
      capabilities: ["resume", "interrupt"],
    },
    probe(profile) {
      return {
        status: "ready",
        account: { id: String(profile.config.account) },
      };
    },
    open(input): HarnessSession {
      const binding = bindingFor(input.profile.id, input.sessionId);
      if (input.resume !== undefined && !sameBinding(input.resume, binding)) {
        throw new Error(`Invalid binding for ${input.profile.id}`);
      }
      openedProfiles.push(input.profile.id);
      return {
        binding,
        async *run({ text }): AsyncIterable<HarnessEventInput> {
          yield { type: "turn.state", state: "running" };
          yield { type: "content.delta", text, channel: "assistant" };
          yield { type: "binding.updated", binding };
          yield { type: "turn.state", state: "completed" };
        },
        interrupt() {},
        close() {},
      };
    },
  };
}

function bindingFor(profileId: string, sessionId: string): JsonValue {
  return { schema: 1, profileId, sessionId };
}

function sameBinding(actual: JsonValue, expected: JsonValue): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}
