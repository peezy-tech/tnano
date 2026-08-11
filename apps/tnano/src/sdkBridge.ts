// @effect-diagnostics nodeBuiltinImport:off - This package is the Node CLI boundary.
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as CodexAdapterModule from "@t-nano/adapter-codex";
import * as EchoAdapterModule from "@t-nano/adapter-echo";
import * as PiAdapterModule from "@t-nano/adapter-pi";
import {
  createTNanoRuntime,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessProfile,
  type JsonObject,
  type JsonValue,
  type RuntimeSession,
  type SessionSummary as SdkSessionSummary,
  type TNanoRuntime,
} from "@t-nano/sdk";

import type { RuntimeFactory, RuntimeFactoryOptions } from "./cli.ts";
import { trustedAdapterSpecifierIssue } from "./adapterSpecifier.ts";
import { CliError, EXIT_CODES } from "./errors.ts";
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
} from "./runtimePort.ts";

function isAdapter(value: unknown): value is HarnessAdapter {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<HarnessAdapter>;
  return (
    candidate.manifest !== undefined &&
    typeof candidate.manifest.id === "string" &&
    typeof candidate.probe === "function" &&
    typeof candidate.open === "function"
  );
}

function adaptersFrom(moduleValue: object): HarnessAdapter[] {
  const module = moduleValue as Record<string, unknown>;
  const candidates: unknown[] = Object.values(module).filter(isAdapter);
  for (const name of ["createEchoAdapter", "createCodexAdapter", "createPiAdapter"]) {
    const factory = module[name];
    if (typeof factory === "function") candidates.push(factory());
  }

  const adapters = candidates.filter(isAdapter);
  return adapters.filter(
    (adapter, index) =>
      adapters.findIndex((candidate) => candidate.manifest.id === adapter.manifest.id) === index,
  );
}

function profileSummary(profile: HarnessProfile): ProfileSummary {
  return {
    id: profile.id,
    harnessId: profile.harness,
    label: profile.label,
    ...(profile.defaultModel === undefined ? {} : { model: profile.defaultModel }),
    status: profile.enabled ? "enabled" : "disabled",
  };
}

function sessionSummary(summary: SdkSessionSummary): SessionSummary {
  return {
    id: summary.sessionId,
    profileId: summary.profileId,
    cwd: summary.cwd,
    ...(summary.model === undefined ? {} : { model: summary.model }),
    state: summary.turnActive ? "running" : summary.active ? "ready" : "saved",
    active: summary.active,
    turnActive: summary.turnActive,
    createdAt: summary.createdAt,
    updatedAt: summary.updatedAt,
  };
}

function runtimeEvent(event: HarnessEvent): RuntimeEvent {
  const { type, ...details } = event;
  return {
    ...details,
    kind: type,
  };
}

function jsonObject(value: Record<string, unknown>): JsonObject {
  return JSON.parse(JSON.stringify(value)) as JsonObject;
}

function jsonValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

class SdkRuntimePort implements RuntimePort {
  readonly #runtime: TNanoRuntime;
  readonly #listeners = new Set<EventListener>();
  readonly #sessions = new Map<string, RuntimeSession>();

  constructor(runtime: TNanoRuntime) {
    this.#runtime = runtime;
  }

  initialize(): Promise<unknown> {
    return this.#runtime.initialize();
  }

  shutdown(): Promise<void> {
    return this.#runtime.close();
  }

  async listHarnesses(): Promise<readonly HarnessSummary[]> {
    return this.#runtime.listHarnesses().map((manifest) => ({
      id: manifest.id,
      label: manifest.label,
      version: manifest.version,
      description: `${manifest.label} adapter ${manifest.version}`,
      capabilities: manifest.capabilities,
    }));
  }

  async listProfiles(): Promise<readonly ProfileSummary[]> {
    return (await this.#runtime.listProfiles()).map(profileSummary);
  }

  async addProfile(input: AddProfileInput): Promise<ProfileSummary> {
    const profile = await this.#runtime.upsertProfile({
      id: input.id,
      harness: input.harnessId,
      label: input.label ?? input.id,
      enabled: true,
      config: jsonObject(input.config),
    });
    return profileSummary(profile);
  }

  removeProfile(id: string): Promise<void> {
    return this.#runtime.removeProfile(id);
  }

  probeProfile(id: string): Promise<unknown> {
    return this.#runtime.probeProfile(id);
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    return (await this.#runtime.listSessions()).map(sessionSummary);
  }

  async startSession(input: StartSessionInput): Promise<SessionSummary> {
    const session =
      input.resumeSessionId === undefined
        ? await this.#runtime.start({
            profileId: input.profileId,
            cwd: input.cwd,
            ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
            ...(input.model === undefined ? {} : { model: input.model }),
          })
        : (this.#sessions.get(input.resumeSessionId) ??
          (await this.#runtime.resume({ sessionId: input.resumeSessionId })));
    this.#sessions.set(session.id, session);
    return sessionSummary({
      ...session.binding,
      active: true,
      turnActive: session.turnActive,
    });
  }

  async send(input: SendInput): Promise<SendResult> {
    const session = await this.#session(input.sessionId);
    let text = "";
    let failureMessage: string | undefined;
    let turnFailed = false;
    for await (const event of session.run({ text: input.prompt })) {
      if (event.type === "content.delta") text += event.text;
      if (event.type === "error") {
        failureMessage = event.message;
        if (event.recoverable !== true) turnFailed = true;
      }
      if (event.type === "turn.state" && event.state === "failed") turnFailed = true;
      const normalized = runtimeEvent(event);
      for (const listener of this.#listeners) listener(normalized);
    }
    if (turnFailed) {
      throw new CliError(
        "harness_crashed",
        failureMessage ?? `Harness turn failed: ${session.id}`,
        EXIT_CODES.harnessCrashed,
      );
    }
    return { sessionId: session.id, text };
  }

  async interrupt(sessionId: string): Promise<void> {
    await (await this.#session(sessionId)).interrupt();
  }

  async stop(sessionId: string): Promise<void> {
    const session = await this.#session(sessionId);
    await session.close();
    this.#sessions.delete(sessionId);
  }

  async respond(sessionId: string, requestId: string, response: unknown): Promise<void> {
    await (await this.#session(sessionId)).respond(requestId, jsonValue(response));
  }

  subscribe(listener: EventListener): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async #session(id: string): Promise<RuntimeSession> {
    const existing = this.#sessions.get(id);
    if (existing !== undefined) return existing;
    const resumed = await this.#runtime.resume({ sessionId: id });
    this.#sessions.set(id, resumed);
    return resumed;
  }
}

function registerBuiltIns(runtime: TNanoRuntime): void {
  const seen = new Set<string>();
  for (const module of [EchoAdapterModule, CodexAdapterModule, PiAdapterModule]) {
    for (const adapter of adaptersFrom(module)) {
      if (seen.has(adapter.manifest.id)) continue;
      runtime.register(adapter);
      seen.add(adapter.manifest.id);
    }
  }
}

async function loadTrustedAdapters(
  runtime: TNanoRuntime,
  specifiers: readonly string[],
): Promise<void> {
  for (const specifier of specifiers) {
    const issue = trustedAdapterSpecifierIssue(specifier);
    if (issue !== undefined) {
      throw new CliError("invalid_configuration", issue, EXIT_CODES.configuration);
    }
    await runtime.loadAdapter(specifier);
  }
}

export const defaultRuntimeFactory: RuntimeFactory = async (
  options: RuntimeFactoryOptions,
): Promise<RuntimePort> => {
  const dataDir = NodePath.resolve(options.home ?? NodePath.join(NodeOS.homedir(), ".t-nano"));
  const runtime = await createTNanoRuntime({ dataDir });
  registerBuiltIns(runtime);
  await loadTrustedAdapters(runtime, options.adapters ?? []);
  return new SdkRuntimePort(runtime);
};
