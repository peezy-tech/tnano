// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests use isolated temporary directories and a deterministic injected clock.
import * as NodeAssert from "node:assert/strict";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

const assert: typeof NodeAssert = NodeAssert;
const { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } = NodeFSP;
const { hostname, tmpdir } = NodeOS;
const { join, resolve } = NodePath;
const test: typeof NodeTest.test = NodeTest.test;

import {
  createTNanoRuntime,
  HarnessRegistry,
  TNanoError,
  titleFromPrompt,
  type HarnessAdapter,
  type HarnessEventInput,
  type HarnessOpenInput,
  type HarnessProfile,
  type HarnessRunInput,
  type HarnessSession,
  type JsonValue,
  type StartSessionInput,
} from "./index.ts";

const PROFILE = {
  id: "echo-work",
  harness: "echo",
  label: "Echo work",
  enabled: true,
  config: { account: "work" },
  environment: { TOKEN: "secret", REMOVE_ME: null },
  defaultModel: "echo-1",
  defaultOptions: { effort: "low" },
} as const satisfies HarnessProfile;

test("profiles and settings persist as inspectable JSON", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const runtime = await createTNanoRuntime({ dataDir });
  await runtime.upsertProfile(PROFILE);
  await runtime.setSettings({ color: "never", quiet: false });

  const reopened = await createTNanoRuntime({ dataDir });
  assert.deepEqual(reopened.listProfiles(), [PROFILE]);
  assert.deepEqual(reopened.getSettings(), {
    version: 1,
    values: { color: "never", quiet: false },
  });

  const profilesText = await readFile(join(dataDir, "profiles.json"), "utf8");
  const settingsText = await readFile(join(dataDir, "settings.json"), "utf8");
  assert.match(profilesText, /"echo-work"/u);
  assert.match(settingsText, /"color": "never"/u);
});

test("mutable inputs and returned views cannot change runtime state", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const runtime = await createTNanoRuntime({ dataDir });
  const mutableProfile = {
    ...PROFILE,
    config: { nested: { account: "work" } },
    defaultOptions: { nested: { effort: "low" } },
  } satisfies HarnessProfile;
  const returnedProfile = await runtime.upsertProfile(mutableProfile);
  mutableProfile.config.nested.account = "mutated-input";
  (returnedProfile.config as { nested: { account: string } }).nested.account = "mutated-return";
  const profileView = runtime.getProfile(PROFILE.id);
  assert.ok(profileView);
  (profileView.config as { nested: { account: string } }).nested.account = "mutated-get";
  assert.deepEqual(runtime.getProfile(PROFILE.id)?.config, {
    nested: { account: "work" },
  });

  const settingsInput = { nested: { color: "never" } };
  const returnedSettings = await runtime.setSettings(settingsInput);
  settingsInput.nested.color = "input-mutation";
  (returnedSettings.values as { nested: { color: string } }).nested.color = "return-mutation";
  (runtime.getSettings().values as { nested: { color: string } }).nested.color = "get-mutation";
  assert.deepEqual(runtime.getSettings().values, {
    nested: { color: "never" },
  });

  const baseAdapter = fixtureAdapter([]);
  runtime.register({
    ...baseAdapter,
    probe: (profile) => {
      (profile.config as { nested: { account: string } }).nested.account = "adapter-mutation";
      return { status: "ready" };
    },
    open: (input) => {
      (input.profile.config as { nested: { account: string } }).nested.account =
        "adapter-open-mutation";
      return baseAdapter.open(input);
    },
  });
  await runtime.probeProfile(PROFILE.id);
  const session = await runtime.start({
    profileId: PROFILE.id,
    sessionId: "profile-snapshot",
    cwd: "/work",
  });
  assert.deepEqual(runtime.getProfile(PROFILE.id)?.config, {
    nested: { account: "work" },
  });
  await session.close();
});

test("write-time validation rejects state that storage cannot reopen", async (context) => {
  const runtime = await createTNanoRuntime({
    dataDir: await temporaryDataDir(context),
  });
  const invalidProfiles: unknown[] = [
    { ...PROFILE, config: [] },
    { ...PROFILE, defaultOptions: [] },
    { ...PROFILE, enabled: "yes" },
    { ...PROFILE, environment: [] },
    { ...PROFILE, defaultModel: 42 },
    { ...PROFILE, defaultModel: "   " },
  ];
  for (const profile of invalidProfiles) {
    await assert.rejects(
      runtime.upsertProfile(profile as HarnessProfile),
      hasCode("INVALID_ARGUMENT"),
    );
  }
  await assert.rejects(
    runtime.setSettings([] as unknown as Record<string, JsonValue>),
    hasCode("INVALID_ARGUMENT"),
  );
});

test("start rejects invalid explicit models before open and preserves reopenability", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const opened: HarnessOpenInput[] = [];
  const runtime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "model-validation",
  });
  runtime.register(fixtureAdapter(opened));
  await runtime.upsertProfile(PROFILE);

  for (const model of [42, "", "   "]) {
    await assert.rejects(
      runtime.start({
        profileId: PROFILE.id,
        cwd: "/work",
        model,
      } as unknown as StartSessionInput),
      hasCode("INVALID_ARGUMENT"),
    );
  }
  assert.equal(opened.length, 0);
  assert.deepEqual(await runtime.listSessions(), []);

  const session = await runtime.start({
    profileId: PROFILE.id,
    cwd: "/work",
    model: "echo-explicit",
  });
  assert.equal(opened.length, 1);
  assert.equal(opened[0]?.model, "echo-explicit");
  await session.close();

  const reopened = await createTNanoRuntime({ dataDir });
  reopened.register(fixtureAdapter([]));
  assert.equal((await reopened.getSession("model-validation")).model, "echo-explicit");
  const resumed = await reopened.resume({ sessionId: "model-validation" });
  assert.equal(resumed.binding.model, "echo-explicit");
  await resumed.close();
});

test("runtime envelopes events, titles deterministically, and keeps native binding private", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const opened: HarnessOpenInput[] = [];
  const nativeSecret = "native-resume-secret";
  const adapter = fixtureAdapter(opened, () => ({
    binding: { initial: "initial-private-value" },
    async *run(): AsyncIterable<HarnessEventInput> {
      yield { type: "session.state", state: "ready" };
      yield { type: "content.delta", channel: "assistant", text: "hello" };
      yield {
        type: "binding.updated",
        binding: { nativeSessionId: "native-1", token: nativeSecret },
      };
    },
  }));
  const times = deterministicClock();
  const runtime = await createTNanoRuntime({
    dataDir,
    clock: times,
    idGenerator: () => "session-1",
  });
  runtime.register(adapter);
  await runtime.upsertProfile(PROFILE);

  const session = await runtime.start({
    profileId: PROFILE.id,
    cwd: "/workspace/project",
    options: { effort: "high" },
  });
  const events = [];
  for await (const event of session.run({
    text: "  Explain the adapter boundary\nwith more detail",
  })) {
    events.push(event);
  }

  assert.deepEqual(
    events.map((event) => event.sequence),
    [1, 2, 3],
  );
  assert.ok(events.every((event) => event.protocolVersion === 1));
  assert.ok(events.every((event) => event.sessionId === "session-1"));
  assert.deepEqual(events.at(-1), {
    type: "binding.updated",
    protocolVersion: 1,
    sequence: 3,
    timestamp: "2026-08-11T00:00:04.000Z",
    sessionId: "session-1",
    profileId: "echo-work",
    harnessId: "echo",
  });
  assert.deepEqual(opened[0]?.options, { effort: "high" });

  const bindingText = await readFile(
    join(dataDir, "sessions", "session-1", "binding.json"),
    "utf8",
  );
  const eventsText = await readFile(join(dataDir, "sessions", "session-1", "events.jsonl"), "utf8");
  assert.match(bindingText, new RegExp(nativeSecret, "u"));
  assert.doesNotMatch(eventsText, new RegExp(nativeSecret, "u"));
  assert.doesNotMatch(
    JSON.stringify(await runtime.readEvents("session-1")),
    /native-resume-secret/u,
  );
  assert.doesNotMatch(
    JSON.stringify(session.binding),
    /native-resume-secret|initial-private-value/u,
  );
  assert.equal("resume" in session.binding, false);

  const summary = await runtime.getSession("session-1");
  assert.equal(summary.title, "Explain the adapter boundary");
  assert.equal(summary.model, "echo-1");
  assert.deepEqual(summary.options, { effort: "high" });
  assert.equal("resume" in summary, false);
  assert.equal("resume" in (await runtime.listSessions())[0]!, false);
  (session.binding.options as { effort: string }).effort = "mutated-view";
  assert.deepEqual(session.binding.options, { effort: "high" });
  await session.close();
});

test("one active turn is enforced without timers", async (context) => {
  const dataDir = await temporaryDataDir(context);
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  const adapter = fixtureAdapter([], () => ({
    async *run(): AsyncIterable<HarnessEventInput> {
      yield { type: "turn.state", state: "running" };
      await gate;
      yield { type: "turn.state", state: "completed" };
    },
  }));
  const runtime = await createTNanoRuntime({
    dataDir,
    clock: deterministicClock(),
    idGenerator: () => "one-turn",
  });
  runtime.register(adapter);
  await runtime.upsertProfile(PROFILE);
  const session = await runtime.start({ profileId: PROFILE.id, cwd: "/work" });

  const firstTurn = session.run({ text: "first" })[Symbol.asyncIterator]();
  assert.equal((await firstTurn.next()).value?.type, "turn.state");
  const secondTurn = session.run({ text: "second" })[Symbol.asyncIterator]();
  await assert.rejects(secondTurn.next(), hasCode("TURN_ACTIVE"));

  releaseGate();
  assert.equal((await firstTurn.next()).value?.type, "turn.state");
  assert.equal((await firstTurn.next()).done, true);
  await session.close();
});

test("a per-session lease excludes a second runtime until the owner closes", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const firstRuntime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "leased-session",
  });
  firstRuntime.register(fixtureAdapter([]));
  await firstRuntime.upsertProfile(PROFILE);
  const firstSession = await firstRuntime.start({
    profileId: PROFILE.id,
    cwd: "/work",
  });

  const lease = JSON.parse(
    await readFile(join(dataDir, "sessions", "leased-session", ".lease"), "utf8"),
  ) as Record<string, unknown>;
  assert.equal(lease.version, 1);
  assert.equal(lease.pid, process.pid);
  assert.equal(typeof lease.hostname, "string");
  assert.equal(typeof lease.token, "string");

  const secondOpens: HarnessOpenInput[] = [];
  const secondRuntime = await createTNanoRuntime({ dataDir });
  secondRuntime.register(fixtureAdapter(secondOpens));
  await assert.rejects(
    secondRuntime.resume({ sessionId: "leased-session" }),
    hasCode("SESSION_ACTIVE"),
  );
  await assert.rejects(
    secondRuntime.start({
      profileId: PROFILE.id,
      sessionId: "leased-session",
      cwd: "/work",
    }),
    hasCode("SESSION_ACTIVE"),
  );
  assert.equal(secondOpens.length, 0);

  await firstSession.close();
  const resumed = await secondRuntime.resume({ sessionId: "leased-session" });
  assert.equal(secondOpens.length, 1);
  await resumed.close();
});

test("start pins an absolute cwd before adapter open and persistence", async (context) => {
  const opened: HarnessOpenInput[] = [];
  const runtime = await createTNanoRuntime({
    dataDir: await temporaryDataDir(context),
    idGenerator: () => "absolute-cwd",
  });
  runtime.register(fixtureAdapter(opened));
  await runtime.upsertProfile(PROFILE);
  const session = await runtime.start({
    profileId: PROFILE.id,
    cwd: "relative/project",
  });
  assert.equal(opened[0]?.cwd, resolve("relative/project"));
  assert.equal(session.binding.cwd, resolve("relative/project"));
  await session.close();
});

test("a dead same-host owner is reclaimed under a serialized marker", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const seedRuntime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "stale-owner",
  });
  seedRuntime.register(fixtureAdapter([]));
  await seedRuntime.upsertProfile(PROFILE);
  const seeded = await seedRuntime.start({
    profileId: PROFILE.id,
    cwd: "/work",
  });
  await seeded.close();

  const deadPid = 2_147_483_647;
  assert.throws(() => process.kill(deadPid, 0), hasSystemCode("ESRCH"));
  await writeFile(
    join(dataDir, "sessions", "stale-owner", ".lease"),
    `${JSON.stringify({
      version: 1,
      token: "stale-token",
      pid: deadPid,
      hostname: hostname(),
      acquiredAt: "2026-08-11T00:00:00.000Z",
    })}\n`,
    "utf8",
  );

  const resumedRuntime = await createTNanoRuntime({ dataDir });
  resumedRuntime.register(fixtureAdapter([]));
  const resumed = await resumedRuntime.resume({ sessionId: "stale-owner" });
  const replacementOwner = JSON.parse(
    await readFile(join(dataDir, "sessions", "stale-owner", ".lease"), "utf8"),
  ) as { token: string };
  assert.notEqual(replacementOwner.token, "stale-token");
  await resumed.close();
});

test("saved sessions pin profile account compatibility and opaque continuation binding", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const firstAdapter = fixtureAdapter([], () => ({
    async *run(): AsyncIterable<HarnessEventInput> {
      yield { type: "binding.updated", binding: { nativeId: "native-resume" } };
    },
  }));
  const firstRuntime = await createTNanoRuntime({
    dataDir,
    clock: deterministicClock(),
    idGenerator: () => "resumable",
  });
  firstRuntime.register(firstAdapter);
  await firstRuntime.upsertProfile(PROFILE);
  const firstSession = await firstRuntime.start({
    profileId: PROFILE.id,
    cwd: "/work",
  });
  for await (const _event of firstSession.run({ text: "remember me" })) {
    // Drain the event stream so the continuation binding is persisted.
  }
  await firstSession.close();

  const resumedOpens: HarnessOpenInput[] = [];
  const secondRuntime = await createTNanoRuntime({
    dataDir,
    clock: deterministicClock(),
  });
  secondRuntime.register(fixtureAdapter(resumedOpens));
  const resumed = await secondRuntime.resume({ sessionId: "resumable" });
  assert.deepEqual(resumedOpens[0]?.resume, { nativeId: "native-resume" });
  assert.equal(resumed.binding.profileId, PROFILE.id);
  await resumed.close();

  await secondRuntime.upsertProfile({ ...PROFILE, id: "echo-personal", label: "Personal" });
  await secondRuntime.upsertProfile({ ...PROFILE, label: "Renamed safely" });
  await assert.rejects(
    secondRuntime.upsertProfile({
      ...PROFILE,
      config: { account: "different-account" },
    }),
    hasCode("PROFILE_IN_USE"),
  );
  await assert.rejects(
    secondRuntime.upsertProfile({
      ...PROFILE,
      environment: { TOKEN: "different-secret" },
    }),
    hasCode("PROFILE_IN_USE"),
  );
  await assert.rejects(secondRuntime.removeProfile(PROFILE.id), hasCode("PROFILE_IN_USE"));

  // A manual state edit cannot bypass the resume-time compatibility check.
  await writeFile(
    join(dataDir, "profiles.json"),
    `${JSON.stringify(
      {
        version: 1,
        profiles: [
          { ...PROFILE, config: { account: "edited-outside-runtime" } },
          { ...PROFILE, id: "echo-personal", label: "Personal" },
        ],
      },
      undefined,
      2,
    )}\n`,
    "utf8",
  );
  const editedRuntime = await createTNanoRuntime({ dataDir });
  editedRuntime.register(fixtureAdapter([]));
  await assert.rejects(editedRuntime.resume({ sessionId: "resumable" }), hasCode("INVALID_STATE"));
});

test("resume ignores only a truncated final JSONL fragment", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const seedRuntime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "truncated-tail",
  });
  seedRuntime.register(fixtureAdapter([]));
  await seedRuntime.upsertProfile(PROFILE);
  const seeded = await seedRuntime.start({
    profileId: PROFILE.id,
    cwd: "/work",
  });
  for await (const _event of seeded.run({ text: "first" })) {
    // Persist one complete event.
  }
  await seeded.close();

  const eventsPath = join(dataDir, "sessions", "truncated-tail", "events.jsonl");
  await appendFile(
    eventsPath,
    `${JSON.stringify({
      type: "custom",
      name: "test.second",
      protocolVersion: 1,
      sequence: 2,
      timestamp: "2026-08-11T00:00:00.000Z",
      sessionId: "truncated-tail",
      profileId: PROFILE.id,
      harnessId: "echo",
    })}\n{"type":"content.delta"`,
    "utf8",
  );

  const resumedRuntime = await createTNanoRuntime({ dataDir });
  resumedRuntime.register(fixtureAdapter([]));
  const resumed = await resumedRuntime.resume({ sessionId: "truncated-tail" });
  assert.equal(resumed.binding.lastSequence, 2);
  await assert.rejects(resumedRuntime.readEvents("truncated-tail"), hasCode("STORAGE_ERROR"));
  await resumed.close();
});

test("profile selection is explicit and registry rejects duplicate adapters", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const runtime = await createTNanoRuntime({ dataDir });
  const adapter = fixtureAdapter([]);
  runtime.register(adapter);
  assert.deepEqual(runtime.listHarnesses(), [adapter.manifest]);
  assert.throws(() => runtime.register(adapter), hasCode("ADAPTER_ALREADY_REGISTERED"));

  await assert.rejects(
    runtime.start({ cwd: "/work" } as unknown as StartSessionInput),
    hasCode("INVALID_ARGUMENT"),
  );

  const registry = new HarnessRegistry();
  assert.equal(registry.list().length, 0);
});

test("harness inspection reports capabilities and profile references without configuration", async (context) => {
  const runtime = await createTNanoRuntime({ dataDir: await temporaryDataDir(context) });
  runtime.register(fixtureAdapter([]));
  await runtime.upsertProfile(PROFILE);
  await runtime.upsertProfile({
    id: "echo-personal",
    harness: "echo",
    label: "Echo personal",
    enabled: false,
    config: { account: "personal-secret" },
    environment: { TOKEN: "personal-token" },
  });

  const inspection = runtime.inspectHarness("echo");
  assert.deepEqual(inspection, {
    manifest: {
      apiVersion: 1,
      id: "echo",
      label: "Echo",
      version: "1.0.0",
      capabilities: ["streaming"],
    },
    profiles: [
      { id: "echo-personal", label: "Echo personal", enabled: false },
      { id: "echo-work", label: "Echo work", enabled: true, defaultModel: "echo-1" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(inspection), /personal-secret|personal-token|TOKEN/u);
  assert.throws(() => runtime.inspectHarness("missing"), hasCode("ADAPTER_NOT_FOUND"));
});

test("profile probes persist an account baseline and warn on identity drift", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const clock = deterministicClock();
  let account = { id: "account-work", email: "work@example.test", plan: "Pro" };
  const adapter: HarnessAdapter = {
    ...fixtureAdapter([]),
    probe: () => ({ status: "ready", account }),
  };
  const runtime = await createTNanoRuntime({ dataDir, clock });
  runtime.register(adapter);
  await runtime.upsertProfile(PROFILE);

  const baseline = await runtime.probeProfile(PROFILE.id);
  assert.equal(baseline.warnings, undefined);
  assert.deepEqual(runtime.getProfileObservation(PROFILE.id)?.baselineAccount, {
    observedAt: baseline.observedAt,
    account: { id: "account-work", email: "work@example.test", plan: "Pro" },
  });

  account = { id: "account-work", email: "work@example.test", plan: "Team" };
  assert.equal((await runtime.probeProfile(PROFILE.id)).warnings, undefined);

  account = { id: "account-personal", email: "personal@example.test", plan: "Free" };
  const drifted = await runtime.probeProfile(PROFILE.id);
  assert.deepEqual(drifted.warnings, [
    {
      code: "account_identity_drift",
      message:
        "Profile echo-work now reports a different account id; T-Nano will not switch or fail over automatically.",
      baseline: {
        observedAt: baseline.observedAt,
        account: { id: "account-work", email: "work@example.test", plan: "Pro" },
      },
      observed: {
        observedAt: drifted.observedAt,
        account: { id: "account-personal", email: "personal@example.test", plan: "Free" },
      },
    },
  ]);

  const observationsText = await readFile(join(dataDir, "observations.json"), "utf8");
  assert.match(observationsText, /"baselineAccount"/u);
  assert.match(observationsText, /"account-personal"/u);
  await runtime.close();

  const reopened = await createTNanoRuntime({ dataDir, clock });
  reopened.register(adapter);
  const repeated = await reopened.probeProfile(PROFILE.id);
  assert.equal(repeated.warnings?.[0]?.code, "account_identity_drift");
  assert.equal(
    reopened.getProfileObservation(PROFILE.id)?.baselineAccount?.account.id,
    "account-work",
  );

  await reopened.upsertProfile({ ...PROFILE, defaultModel: "echo-2" });
  assert.equal(
    (await reopened.probeProfile(PROFILE.id)).warnings?.[0]?.code,
    "account_identity_drift",
  );

  await reopened.upsertProfile({ ...PROFILE, config: { account: "personal" } });
  const reconfigured = await reopened.probeProfile(PROFILE.id);
  assert.equal(reconfigured.warnings, undefined);
  assert.equal(
    reopened.getProfileObservation(PROFILE.id)?.baselineAccount?.account.id,
    "account-personal",
  );
});

test("resume rejects an adapter continuation ABI version change", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const firstRuntime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "version-pinned",
  });
  firstRuntime.register(fixtureAdapter([], undefined, "1.0.0"));
  await firstRuntime.upsertProfile(PROFILE);
  const firstSession = await firstRuntime.start({
    profileId: PROFILE.id,
    cwd: "/work",
  });
  await firstSession.close();

  const upgradedRuntime = await createTNanoRuntime({ dataDir });
  upgradedRuntime.register(fixtureAdapter([], undefined, "2.0.0"));
  await assert.rejects(
    upgradedRuntime.resume({ sessionId: "version-pinned" }),
    hasCode("INVALID_STATE"),
  );
});

test("post-open setup failures close captured start and resume sessions", async (context) => {
  const startDataDir = await temporaryDataDir(context);
  let startCloseCount = 0;
  const startRuntime = await createTNanoRuntime({
    dataDir: startDataDir,
    clock: () => {
      throw new Error("clock failed after open");
    },
  });
  startRuntime.register(
    fixtureAdapter([], () => ({
      async *run(): AsyncIterable<HarnessEventInput> {
        yield* [];
      },
      close: () => {
        startCloseCount += 1;
      },
    })),
  );
  await startRuntime.upsertProfile(PROFILE);
  await assert.rejects(
    startRuntime.start({
      profileId: PROFILE.id,
      sessionId: "failed-start",
      cwd: "/work",
    }),
    /clock failed after open/u,
  );
  assert.equal(startCloseCount, 1);

  const resumeDataDir = await temporaryDataDir(context);
  const seedRuntime = await createTNanoRuntime({ dataDir: resumeDataDir });
  seedRuntime.register(fixtureAdapter([]));
  await seedRuntime.upsertProfile(PROFILE);
  const seeded = await seedRuntime.start({
    profileId: PROFILE.id,
    sessionId: "failed-resume",
    cwd: "/work",
  });
  await seeded.close();

  let resumeCloseCount = 0;
  const resumeRuntime = await createTNanoRuntime({
    dataDir: resumeDataDir,
    clock: () => {
      throw new Error("resume clock failed after open");
    },
  });
  resumeRuntime.register(
    fixtureAdapter([], () => ({
      async *run(): AsyncIterable<HarnessEventInput> {
        yield* [];
      },
      close: () => {
        resumeCloseCount += 1;
      },
    })),
  );
  await assert.rejects(
    resumeRuntime.resume({ sessionId: "failed-resume" }),
    /resume clock failed after open/u,
  );
  assert.equal(resumeCloseCount, 1);
});

test("runtime close waits an in-flight activation and closes its session", async (context) => {
  const dataDir = await temporaryDataDir(context);
  let releaseOpen: () => void = () => undefined;
  const openGate = new Promise<void>((resolveOpen) => {
    releaseOpen = resolveOpen;
  });
  let markOpenEntered: () => void = () => undefined;
  const openEntered = new Promise<void>((resolveEntered) => {
    markOpenEntered = resolveEntered;
  });
  let closeCount = 0;
  const runtime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "closing-activation",
  });
  runtime.register({
    ...fixtureAdapter([]),
    open: async () => {
      markOpenEntered();
      await openGate;
      return {
        async *run(): AsyncIterable<HarnessEventInput> {
          yield* [];
        },
        close: () => {
          closeCount += 1;
        },
      };
    },
  });
  await runtime.upsertProfile(PROFILE);

  const starting = runtime.start({ profileId: PROFILE.id, cwd: "/work" });
  await openEntered;
  const closing = runtime.close();
  await assert.rejects(
    runtime.start({ profileId: PROFILE.id, cwd: "/work" }),
    hasCode("SESSION_CLOSED"),
  );
  releaseOpen();
  const activated = await starting;
  await closing;
  assert.equal(closeCount, 1);
  assert.equal((await runtime.getSession("closing-activation")).active, false);
  await assert.rejects(
    activated.run({ text: "too late" })[Symbol.asyncIterator]().next(),
    hasCode("SESSION_CLOSED"),
  );
});

test("close attempts adapter interrupt and close independently and aggregates failures", async (context) => {
  const dataDir = await temporaryDataDir(context);
  let releaseGate: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    releaseGate = resolve;
  });
  let interruptCount = 0;
  let closeCount = 0;
  const runtime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "close-failures",
  });
  runtime.register(
    fixtureAdapter([], () => ({
      async *run(): AsyncIterable<HarnessEventInput> {
        yield { type: "turn.state", state: "running" };
        await gate;
        yield { type: "turn.state", state: "completed" };
      },
      interrupt: (signal) => {
        assert.equal(signal, undefined);
        interruptCount += 1;
        throw new Error("interrupt failure");
      },
      close: (signal) => {
        assert.equal(signal, undefined);
        closeCount += 1;
        throw new Error("close failure");
      },
    })),
  );
  await runtime.upsertProfile(PROFILE);
  const session = await runtime.start({ profileId: PROFILE.id, cwd: "/work" });
  const turn = session.run({ text: "wait" })[Symbol.asyncIterator]();
  await turn.next();

  let closeError: unknown;
  const aborted = new AbortController();
  aborted.abort(new Error("caller stopped waiting"));
  try {
    await session.close(aborted.signal);
  } catch (error) {
    closeError = error;
  }
  assert.equal(interruptCount, 1);
  assert.equal(closeCount, 1);
  assert.ok(closeError instanceof TNanoError);
  assert.ok(closeError.cause instanceof AggregateError);
  assert.equal(closeError.cause.errors.length, 2);

  await assert.rejects(
    readFile(join(dataDir, "sessions", "close-failures", ".lease"), "utf8"),
    isMissingFile,
  );
  const successorRuntime = await createTNanoRuntime({ dataDir });
  successorRuntime.register(fixtureAdapter([]));
  const successor = await successorRuntime.resume({
    sessionId: "close-failures",
  });

  releaseGate();
  await assert.rejects(turn.next(), hasCode("SESSION_CLOSED"));
  assert.equal((await successorRuntime.readEvents("close-failures")).length, 1);
  await successor.close();
});

test("binding updates commit before their redacted display marker", async (context) => {
  const dataDir = await temporaryDataDir(context);
  const bindingSecret = "durable-before-log-secret";
  const runtime = await createTNanoRuntime({
    dataDir,
    idGenerator: () => "binding-order",
  });
  runtime.register(
    fixtureAdapter([], () => ({
      async *run(): AsyncIterable<HarnessEventInput> {
        yield {
          type: "binding.updated",
          binding: { nativeId: "native-order", secret: bindingSecret },
        };
      },
    })),
  );
  await runtime.upsertProfile(PROFILE);
  const session = await runtime.start({ profileId: PROFILE.id, cwd: "/work" });

  // Force the redacted append to fail after the atomic binding write.
  await mkdir(join(dataDir, "sessions", "binding-order", "events.jsonl"));
  const turn = session.run({ text: "persist first" })[Symbol.asyncIterator]();
  await assert.rejects(turn.next(), hasCode("STORAGE_ERROR"));
  const bindingText = await readFile(
    join(dataDir, "sessions", "binding-order", "binding.json"),
    "utf8",
  );
  assert.match(bindingText, new RegExp(bindingSecret, "u"));
  await session.close();
});

test("first-prompt titles are normalized and bounded by Unicode code points", () => {
  assert.equal(titleFromPrompt("\n  a   useful   title \nignored"), "a useful title");
  assert.equal(titleFromPrompt("😀😀😀😀", 3), "😀😀…");
  assert.equal(titleFromPrompt("   "), "Untitled session");
});

function fixtureAdapter(
  opened: HarnessOpenInput[],
  sessionFactory: ((input: HarnessOpenInput) => HarnessSession) | undefined = undefined,
  version = "1.0.0",
): HarnessAdapter {
  const createSession =
    sessionFactory ??
    (() => ({
      async *run(input: HarnessRunInput): AsyncIterable<HarnessEventInput> {
        yield { type: "content.delta", text: input.text };
      },
    }));
  return {
    manifest: {
      apiVersion: 1,
      id: "echo",
      label: "Echo",
      version,
      capabilities: ["streaming"],
    },
    probe: () => ({ status: "ready", version }),
    open: (input) => {
      opened.push(input);
      return createSession(input);
    },
  };
}

function deterministicClock(): () => Date {
  let call = 0;
  return () => {
    const value = new Date(Date.UTC(2026, 7, 11, 0, 0, call));
    call += 1;
    return value;
  };
}

async function temporaryDataDir(context: NodeTest.TestContext): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "tnano-sdk-test-"));
  context.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

function hasCode(code: string): (error: unknown) => boolean {
  return (error) => error instanceof TNanoError && error.code === code;
}

function isMissingFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function hasSystemCode(code: string): (error: unknown) => boolean {
  return (error) =>
    typeof error === "object" && error !== null && "code" in error && error.code === code;
}

void (undefined satisfies JsonValue | undefined);
