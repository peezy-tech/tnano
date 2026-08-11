import { TNanoError } from "./errors.ts";
import {
  CORE_EVENT_KINDS,
  type HarnessAdapter,
  type HarnessEventInput,
  type HarnessOpenInput,
  type HarnessProfile,
  type HarnessRunInput,
  type HarnessSession,
  type JsonValue,
  type ProbeResult,
} from "./types.ts";

export interface AdapterConformanceCase {
  readonly profile: HarnessProfile;
  readonly sessionId: string;
  readonly cwd: string;
  readonly model?: string;
  readonly options?: HarnessOpenInput["options"];
  /** Supply a deterministic turn when a resumable binding is produced only after input. */
  readonly run?: HarnessRunInput;
}

export interface AdapterConformanceContext {
  readonly adapterId: string;
  readonly probes: readonly [ProbeResult, ProbeResult];
  readonly bindings: readonly [JsonValue | undefined, JsonValue | undefined];
  readonly events: readonly [readonly HarnessEventInput[], readonly HarnessEventInput[]];
}

export interface AdapterConformanceOptions {
  readonly adapter: HarnessAdapter;
  /** Two named profiles are mandatory so implementations exercise isolated contexts. */
  readonly cases: readonly [AdapterConformanceCase, AdapterConformanceCase];
  /** Adapter packages can inspect their captured child environments here. */
  readonly verifyIsolation: (context: AdapterConformanceContext) => Promise<void> | void;
}

export interface AdapterConformanceReport {
  readonly adapterId: string;
  readonly checks: readonly [
    "manifest",
    "profiles",
    "probes",
    "sessions",
    "events",
    "capabilities",
    "resume",
    "isolation",
  ];
}

const CHECKS = [
  "manifest",
  "profiles",
  "probes",
  "sessions",
  "events",
  "capabilities",
  "resume",
  "isolation",
] as const;

const PROBE_STATUSES = new Set(["ready", "unavailable", "unauthenticated", "error"]);
const EVENT_KINDS = new Set<string>(CORE_EVENT_KINDS);

/**
 * Exercise the public adapter contract without depending on a test runner.
 * Adapter authors provide deterministic fake child processes and can call this
 * helper from Node test, Vitest, or another runner.
 */
export async function runAdapterConformance(
  options: AdapterConformanceOptions,
): Promise<AdapterConformanceReport> {
  const { adapter, cases } = options;
  validateManifest(adapter);
  validateCases(adapter, cases);

  const probeProfiles = cases.map((entry) => cloneProfile(entry.profile)) as [
    HarnessProfile,
    HarnessProfile,
  ];
  const probes = (await Promise.all(probeProfiles.map((profile) => adapter.probe(profile)))) as [
    ProbeResult,
    ProbeResult,
  ];
  for (const [index, result] of probes.entries()) {
    validateProbe(result, `probe ${String(index + 1)}`);
    assertUnchangedProfile(probeProfiles[index]!, cases[index]!.profile, "probe");
  }

  const sessions: HarnessSession[] = [];
  const openProfiles: HarnessProfile[] = [];
  let events: [readonly HarnessEventInput[], readonly HarnessEventInput[]] = [[], []];
  let bindings: [JsonValue | undefined, JsonValue | undefined] = [undefined, undefined];
  try {
    for (const entry of cases) {
      const profile = cloneProfile(entry.profile);
      openProfiles.push(profile);
      const session = await adapter.open(openInput(entry, profile));
      validateSession(adapter, session);
      sessions.push(session);
    }
    for (const [index, profile] of openProfiles.entries()) {
      assertUnchangedProfile(profile, cases[index]!.profile, "open");
    }

    events = (await Promise.all(
      sessions.map((session, index) => collectEvents(session, cases[index]!.run)),
    )) as [readonly HarnessEventInput[], readonly HarnessEventInput[]];
    for (const [index, profile] of openProfiles.entries()) {
      assertUnchangedProfile(profile, cases[index]!.profile, "run");
    }
    bindings = [bindingFrom(sessions[0]!, events[0]), bindingFrom(sessions[1]!, events[1])];
    validateBindings(bindings);

    await options.verifyIsolation({
      adapterId: adapter.manifest.id,
      probes,
      bindings,
      events,
    });
  } finally {
    await closeAll(sessions);
  }

  if (adapter.manifest.capabilities.includes("resume")) {
    const resumed: HarnessSession[] = [];
    try {
      for (const [index, entry] of cases.entries()) {
        const binding = bindings[index];
        if (binding === undefined) {
          throw failure(
            `Adapter ${adapter.manifest.id} declares resume but case ${String(index + 1)} produced no binding`,
          );
        }
        const profile = cloneProfile(entry.profile);
        const session = await adapter.open({
          ...openInput(entry, profile),
          resume: cloneJson(binding),
        });
        validateSession(adapter, session);
        assertUnchangedProfile(profile, entry.profile, "resume");
        resumed.push(session);
      }
    } finally {
      await closeAll(resumed);
    }
  }

  return { adapterId: adapter.manifest.id, checks: CHECKS };
}

function validateManifest(adapter: HarnessAdapter): void {
  const manifest = adapter?.manifest;
  if (
    manifest?.apiVersion !== 1 ||
    typeof manifest.id !== "string" ||
    manifest.id.trim() === "" ||
    typeof manifest.label !== "string" ||
    manifest.label.trim() === "" ||
    typeof manifest.version !== "string" ||
    manifest.version.trim() === "" ||
    !Array.isArray(manifest.capabilities) ||
    manifest.capabilities.some((entry) => typeof entry !== "string" || entry.trim() === "") ||
    new Set(manifest.capabilities).size !== manifest.capabilities.length ||
    typeof adapter.probe !== "function" ||
    typeof adapter.open !== "function"
  ) {
    throw failure("Adapter manifest does not satisfy API version 1");
  }
  assertJson(manifest, "adapter manifest");
}

function validateCases(
  adapter: HarnessAdapter,
  cases: readonly [AdapterConformanceCase, AdapterConformanceCase],
): void {
  if (cases[0].profile.id === cases[1].profile.id) {
    throw failure("Conformance cases require two distinct profile ids");
  }
  if (cases[0].sessionId === cases[1].sessionId) {
    throw failure("Conformance cases require two distinct session ids");
  }
  for (const entry of cases) {
    if (entry.profile.harness !== adapter.manifest.id) {
      throw failure(
        `Profile ${entry.profile.id} targets ${entry.profile.harness}, not ${adapter.manifest.id}`,
      );
    }
    if (entry.cwd.trim() === "" || entry.sessionId.trim() === "") {
      throw failure("Conformance session ids and working directories cannot be empty");
    }
    assertJson(entry.profile, `profile ${entry.profile.id}`);
    if (entry.options !== undefined) assertJson(entry.options, `options for ${entry.profile.id}`);
    if (entry.run?.attachments !== undefined) {
      assertJson(entry.run.attachments, `attachments for ${entry.profile.id}`);
    }
  }
}

function validateProbe(result: ProbeResult, label: string): void {
  if (typeof result !== "object" || result === null || !PROBE_STATUSES.has(String(result.status))) {
    throw failure(`${label} returned an invalid status`);
  }
  assertJson(result, label);
}

function validateSession(adapter: HarnessAdapter, session: HarnessSession): void {
  if (typeof session !== "object" || session === null || typeof session.run !== "function") {
    throw failure(`Adapter ${adapter.manifest.id} returned an invalid session`);
  }
  if (
    adapter.manifest.capabilities.includes("interrupt") &&
    typeof session.interrupt !== "function"
  ) {
    throw failure(`Adapter ${adapter.manifest.id} declares interrupt without implementing it`);
  }
  if (adapter.manifest.capabilities.includes("requests") && typeof session.respond !== "function") {
    throw failure(`Adapter ${adapter.manifest.id} declares requests without implementing respond`);
  }
  if (session.binding !== undefined) assertJson(session.binding, "session binding");
}

async function collectEvents(
  session: HarnessSession,
  input: HarnessRunInput | undefined,
): Promise<readonly HarnessEventInput[]> {
  if (input === undefined) return [];
  const events: HarnessEventInput[] = [];
  for await (const event of session.run(input)) {
    if (
      typeof event !== "object" ||
      event === null ||
      !("type" in event) ||
      typeof event.type !== "string" ||
      !EVENT_KINDS.has(event.type)
    ) {
      throw failure("Adapter emitted an unsupported event kind");
    }
    assertJson(event, `event ${event.type}`);
    events.push(event);
  }
  return events;
}

function bindingFrom(
  session: HarnessSession,
  events: readonly HarnessEventInput[],
): JsonValue | undefined {
  let binding = session.binding;
  for (const event of events) {
    if (event.type === "binding.updated") binding = event.binding;
  }
  return binding === undefined ? undefined : cloneJson(binding);
}

function validateBindings(bindings: readonly [JsonValue | undefined, JsonValue | undefined]): void {
  for (const binding of bindings) {
    if (binding !== undefined) assertJson(binding, "resume binding");
  }
}

function openInput(entry: AdapterConformanceCase, profile: HarnessProfile): HarnessOpenInput {
  return {
    profile,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    ...(entry.model === undefined ? {} : { model: entry.model }),
    ...(entry.options === undefined ? {} : { options: cloneJson(entry.options) }),
  };
}

async function closeAll(sessions: readonly HarnessSession[]): Promise<void> {
  const results = await Promise.allSettled(sessions.map((session) => session.close?.()));
  const rejected = results.find(
    (result): result is PromiseRejectedResult => result.status === "rejected",
  );
  if (rejected !== undefined) throw rejected.reason;
}

function assertUnchangedProfile(
  actual: HarnessProfile,
  expected: HarnessProfile,
  operation: string,
): void {
  if (stableJson(actual) !== stableJson(expected)) {
    throw failure(`Adapter mutated profile ${expected.id} during ${operation}`);
  }
}

function cloneProfile(profile: HarnessProfile): HarnessProfile {
  return cloneJson(profile) as HarnessProfile;
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function assertJson(value: unknown, label: string): void {
  const seen = new Set<object>();
  const visit = (entry: unknown): void => {
    if (
      entry === null ||
      typeof entry === "string" ||
      typeof entry === "boolean" ||
      (typeof entry === "number" && Number.isFinite(entry))
    ) {
      return;
    }
    if (typeof entry !== "object" || seen.has(entry)) {
      throw failure(`${label} must contain only acyclic JSON values`);
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) visit(item);
    } else {
      const prototype = Object.getPrototypeOf(entry) as unknown;
      if (prototype !== Object.prototype && prototype !== null) {
        throw failure(`${label} must contain only plain JSON objects`);
      }
      for (const item of Object.values(entry)) visit(item);
    }
    seen.delete(entry);
  };
  visit(value);
}

function failure(message: string): TNanoError {
  return new TNanoError("INVALID_ADAPTER", `Adapter conformance failed: ${message}`);
}
