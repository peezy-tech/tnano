// @effect-diagnostics nodeBuiltinImport:off globalDate:off - The SDK is intentionally a plain Node runtime boundary with an injectable clock.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { TNanoError, throwIfAborted } from "./errors.ts";
import { HarnessRegistry, type TrustedAdapterSpecifier } from "./registry.ts";
import { assertSafeId, FileRuntimeStore, type SessionLease } from "./storage.ts";
import {
  CORE_EVENT_KINDS,
  type Clock,
  type HarnessAdapter,
  type HarnessEvent,
  type HarnessEventInput,
  type HarnessInspection,
  type HarnessManifest,
  type HarnessProfile,
  type HarnessRunInput,
  type HarnessSession,
  type IdGenerator,
  type JsonObject,
  type JsonValue,
  type ProbeProfileOptions,
  type ProbeAccount,
  type ProbeAccountObservation,
  type ProbeResult,
  type ProfileObservation,
  type ProfileProbeResult,
  type ProfileProbeWarning,
  type ResumeSessionInput,
  type RuntimeSession,
  type RuntimeSettings,
  type SessionBinding,
  type SessionBindingView,
  type SessionSummary,
  type StartSessionInput,
  type TNanoRuntimeOptions,
} from "./types.ts";

const CORE_EVENT_KIND_SET: ReadonlySet<string> = new Set(CORE_EVENT_KINDS);

export class TNanoRuntime {
  readonly #store: FileRuntimeStore;
  readonly #registry: HarnessRegistry;
  readonly #clock: Clock;
  readonly #idGenerator: IdGenerator;
  readonly #profiles = new Map<string, HarnessProfile>();
  readonly #observations = new Map<string, ProfileObservation>();
  readonly #activeSessions = new Map<string, RuntimeSessionController>();
  readonly #openingSessions = new Set<string>();
  readonly #activations = new Set<Promise<void>>();
  readonly #activationAbort = new AbortController();
  #settings: RuntimeSettings = { version: 1, values: {} };
  #initialized = false;
  #closing = false;
  #runtimeClosePromise: Promise<void> | undefined;
  #initialization: Promise<void> | undefined;
  #profileMutation: Promise<void> = Promise.resolve();
  #observationMutation: Promise<void> = Promise.resolve();

  constructor(options: TNanoRuntimeOptions) {
    this.#store = new FileRuntimeStore(options.dataDir);
    this.#registry = options.registry ?? new HarnessRegistry();
    this.#clock = options.clock ?? (() => new Date());
    this.#idGenerator = options.idGenerator ?? NodeCrypto.randomUUID;
  }

  get dataDir(): string {
    return this.#store.root;
  }

  get registry(): HarnessRegistry {
    return this.#registry;
  }

  async initialize(): Promise<this> {
    if (this.#initialized) {
      return this;
    }
    if (this.#initialization === undefined) {
      this.#initialization = this.#initializeOnce();
    }
    await this.#initialization;
    return this;
  }

  register(adapter: HarnessAdapter): HarnessAdapter {
    return this.#registry.register(adapter);
  }

  registerAdapter(adapter: HarnessAdapter): HarnessAdapter {
    return this.register(adapter);
  }

  loadAdapter(specifier: TrustedAdapterSpecifier): Promise<readonly HarnessAdapter[]> {
    return this.#registry.load(specifier);
  }

  listHarnesses(): readonly HarnessManifest[] {
    return this.#registry.list();
  }

  inspectHarness(harnessId: string): HarnessInspection {
    this.#assertInitialized();
    const adapter = this.#registry.require(harnessId);
    return {
      manifest: cloneHarnessManifest(adapter.manifest),
      profiles: [...this.#profiles.values()]
        .filter((profile) => profile.harness === harnessId)
        .sort((left, right) => left.id.localeCompare(right.id))
        .map((profile) => ({
          id: profile.id,
          label: profile.label,
          enabled: profile.enabled,
          ...(profile.defaultModel === undefined ? {} : { defaultModel: profile.defaultModel }),
        })),
    };
  }

  listProfiles(): readonly HarnessProfile[] {
    this.#assertInitialized();
    return [...this.#profiles.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(cloneHarnessProfile);
  }

  getProfile(profileId: string): HarnessProfile | undefined {
    this.#assertInitialized();
    const profile = this.#profiles.get(profileId);
    return profile === undefined ? undefined : cloneHarnessProfile(profile);
  }

  getProfileObservation(profileId: string): ProfileObservation | undefined {
    this.#assertInitialized();
    const profile = this.#profiles.get(profileId);
    const observation = this.#observations.get(profileId);
    if (
      profile === undefined ||
      observation === undefined ||
      observation.harnessId !== profile.harness ||
      observation.profileFingerprint !== profileAccountFingerprint(profile)
    ) {
      return undefined;
    }
    return cloneProfileObservation(observation);
  }

  async upsertProfile(profile: HarnessProfile): Promise<HarnessProfile> {
    this.#assertInitialized();
    validateProfile(profile);
    const storedProfile = cloneHarnessProfile(profile);
    return this.#mutateProfiles(async () => {
      const existing = this.#profiles.get(storedProfile.id);
      if (
        existing !== undefined &&
        profileCompatibilityFingerprint(existing) !== profileCompatibilityFingerprint(storedProfile)
      ) {
        const pinned = (await this.#store.listBindings()).find(
          (binding) => binding.profileId === storedProfile.id,
        );
        if (pinned !== undefined) {
          throw new TNanoError(
            "PROFILE_IN_USE",
            `Profile compatibility fields are pinned to a saved session: ${storedProfile.id}`,
            {
              details: {
                profileId: storedProfile.id,
                sessionId: pinned.sessionId,
                changed: "harness, config, environment, defaultModel, or defaultOptions",
              },
            },
          );
        }
      }
      this.#profiles.set(storedProfile.id, storedProfile);
      await this.#store.writeProfiles([...this.#profiles.values()]);
      return cloneHarnessProfile(storedProfile);
    });
  }

  async removeProfile(profileId: string): Promise<void> {
    this.#assertInitialized();
    assertSafeId(profileId, "profile id");
    await this.#mutateProfiles(async () => {
      if (!this.#profiles.has(profileId)) {
        throw profileNotFound(profileId);
      }
      const pinned = (await this.#store.listBindings()).find(
        (binding) => binding.profileId === profileId,
      );
      if (pinned !== undefined) {
        throw new TNanoError(
          "PROFILE_IN_USE",
          `Profile is pinned to a saved session: ${profileId}`,
          { details: { profileId, sessionId: pinned.sessionId } },
        );
      }
      this.#profiles.delete(profileId);
      await this.#store.writeProfiles([...this.#profiles.values()]);
    });
  }

  getSettings(): RuntimeSettings {
    this.#assertInitialized();
    return cloneRuntimeSettings(this.#settings);
  }

  async setSettings(values: JsonObject): Promise<RuntimeSettings> {
    this.#assertInitialized();
    assertJsonObject(values, "settings");
    const settings: RuntimeSettings = { version: 1, values: cloneJson(values) };
    await this.#store.writeSettings(settings);
    this.#settings = settings;
    return cloneRuntimeSettings(settings);
  }

  async probeProfile(
    profileId: string,
    options: ProbeProfileOptions = {},
  ): Promise<ProfileProbeResult> {
    this.#assertInitialized();
    throwIfAborted(options.signal);
    const profile = this.#requireProfile(profileId);
    const adapter = this.#registry.require(profile.harness);
    let result: ProbeResult;
    try {
      result = await adapter.probe(cloneHarnessProfile(profile), options.signal);
      validateProbeResult(result);
    } catch (error) {
      throw TNanoError.from(
        error,
        "ADAPTER_ERROR",
        `Harness probe failed for profile: ${profileId}`,
        { profileId, harnessId: adapter.manifest.id },
      );
    }
    const observedAt = this.#now();
    const observation = await this.#recordObservation(
      profile,
      adapter.manifest.id,
      cloneProbeResult(result),
      observedAt,
    );
    const warnings = accountDriftWarnings(observation);
    return {
      ...cloneProbeResult(result),
      profileId,
      harnessId: adapter.manifest.id,
      observedAt,
      ...(warnings.length === 0 ? {} : { warnings }),
    };
  }

  async start(input: StartSessionInput): Promise<RuntimeSession> {
    this.#assertInitialized();
    this.#assertAcceptingSessions();
    return this.#trackActivation(this.#start(input));
  }

  async #start(input: StartSessionInput): Promise<RuntimeSession> {
    throwIfAborted(input.signal);
    if (typeof input.profileId !== "string" || input.profileId.trim() === "") {
      throw new TNanoError(
        "INVALID_ARGUMENT",
        "Starting a session requires an explicit profile id",
      );
    }
    if (typeof input.cwd !== "string" || input.cwd.trim() === "") {
      throw new TNanoError("INVALID_ARGUMENT", "Session cwd cannot be empty");
    }
    if (
      input.model !== undefined &&
      (typeof input.model !== "string" || input.model.trim() === "")
    ) {
      throw new TNanoError("INVALID_ARGUMENT", "Session model must be a non-empty string");
    }
    const cwd = NodePath.resolve(input.cwd);
    const profile = this.#requireEnabledProfile(input.profileId);
    const adapter = this.#registry.require(profile.harness);
    const sessionId = input.sessionId ?? this.#idGenerator();
    assertSafeId(sessionId, "session id");
    this.#reserveSession(sessionId);
    let harnessSession: HarnessSession | undefined;
    let lease: SessionLease | undefined;
    try {
      lease = await this.#store.acquireSessionLease(sessionId);
      if (await this.#store.hasSession(sessionId)) {
        throw new TNanoError("SESSION_ALREADY_EXISTS", `Session already exists: ${sessionId}`, {
          details: { sessionId },
        });
      }
      const model = input.model ?? profile.defaultModel;
      if (input.options !== undefined) {
        assertJsonObject(input.options, "session options");
      }
      const options = mergeOptions(profile.defaultOptions, input.options);
      const signal = combineSignals(input.signal, this.#activationAbort.signal);
      harnessSession = await this.#openAdapter(adapter, {
        profile: cloneHarnessProfile(profile),
        sessionId,
        cwd,
        ...(model === undefined ? {} : { model }),
        ...(options === undefined ? {} : { options }),
        signal,
      });
      const now = this.#now();
      const binding: SessionBinding = {
        version: 1,
        sessionId,
        profileId: profile.id,
        harnessId: adapter.manifest.id,
        adapterVersion: adapter.manifest.version,
        profileFingerprint: profileCompatibilityFingerprint(profile),
        cwd,
        ...(model === undefined ? {} : { model }),
        ...(options === undefined ? {} : { options }),
        ...(harnessSession.binding === undefined ? {} : { resume: harnessSession.binding }),
        createdAt: now,
        updatedAt: now,
        lastSequence: 0,
      };
      await this.#store.writeBinding(binding);
      const controller = this.#activate(binding, harnessSession, lease);
      lease = undefined;
      return controller;
    } catch (error) {
      return this.#cleanupFailedActivation(harnessSession, lease, error, sessionId);
    } finally {
      this.#openingSessions.delete(sessionId);
    }
  }

  async resume(input: ResumeSessionInput): Promise<RuntimeSession> {
    this.#assertInitialized();
    this.#assertAcceptingSessions();
    return this.#trackActivation(this.#resume(input));
  }

  async #resume(input: ResumeSessionInput): Promise<RuntimeSession> {
    throwIfAborted(input.signal);
    assertSafeId(input.sessionId, "session id");
    this.#reserveSession(input.sessionId);
    let harnessSession: HarnessSession | undefined;
    let lease: SessionLease | undefined;
    try {
      lease = await this.#store.acquireSessionLease(input.sessionId);
      const binding = await this.#store.readBinding(input.sessionId);
      const profile = this.#requireEnabledProfile(binding.profileId);
      const currentFingerprint = profileCompatibilityFingerprint(profile);
      if (currentFingerprint !== binding.profileFingerprint) {
        throw new TNanoError(
          "INVALID_STATE",
          `Pinned profile compatibility changed for session: ${input.sessionId}`,
          {
            details: {
              sessionId: input.sessionId,
              profileId: binding.profileId,
              expectedFingerprint: binding.profileFingerprint,
              actualFingerprint: currentFingerprint,
            },
          },
        );
      }
      if (profile.harness !== binding.harnessId) {
        throw new TNanoError(
          "INVALID_STATE",
          `Pinned profile harness changed for session: ${input.sessionId}`,
          {
            details: {
              sessionId: input.sessionId,
              pinnedHarnessId: binding.harnessId,
              profileHarnessId: profile.harness,
            },
          },
        );
      }
      const adapter = this.#registry.require(binding.harnessId);
      if (adapter.manifest.version !== binding.adapterVersion) {
        throw new TNanoError(
          "INVALID_STATE",
          `Pinned adapter version changed for session: ${input.sessionId}`,
          {
            details: {
              sessionId: input.sessionId,
              harnessId: binding.harnessId,
              expectedVersion: binding.adapterVersion,
              actualVersion: adapter.manifest.version,
            },
          },
        );
      }
      const signal = combineSignals(input.signal, this.#activationAbort.signal);
      harnessSession = await this.#openAdapter(adapter, {
        profile: cloneHarnessProfile(profile),
        sessionId: binding.sessionId,
        cwd: binding.cwd,
        ...(binding.model === undefined ? {} : { model: binding.model }),
        ...(binding.options === undefined ? {} : { options: binding.options }),
        ...(binding.resume === undefined ? {} : { resume: binding.resume }),
        signal,
      });
      const eventSequence = await this.#store.readLastEventSequenceForResume(binding.sessionId);
      const updated: SessionBinding = {
        ...binding,
        ...(harnessSession.binding === undefined ? {} : { resume: harnessSession.binding }),
        updatedAt: this.#now(),
        lastSequence: Math.max(binding.lastSequence, eventSequence),
      };
      await this.#store.writeBinding(updated);
      const controller = this.#activate(updated, harnessSession, lease);
      lease = undefined;
      return controller;
    } catch (error) {
      return this.#cleanupFailedActivation(harnessSession, lease, error, input.sessionId);
    } finally {
      this.#openingSessions.delete(input.sessionId);
    }
  }

  async listSessions(): Promise<readonly SessionSummary[]> {
    this.#assertInitialized();
    const bindings = await this.#store.listBindings();
    return bindings.map((binding) => {
      const active = this.#activeSessions.get(binding.sessionId);
      const currentBinding = active?.binding ?? sessionBindingView(binding);
      return {
        ...currentBinding,
        active: active !== undefined,
        turnActive: active?.turnActive ?? false,
      };
    });
  }

  async getSession(sessionId: string): Promise<SessionSummary> {
    this.#assertInitialized();
    const active = this.#activeSessions.get(sessionId);
    const binding = active?.binding ?? sessionBindingView(await this.#store.readBinding(sessionId));
    return {
      ...binding,
      active: active !== undefined,
      turnActive: active?.turnActive ?? false,
    };
  }

  async readEvents(sessionId: string): Promise<readonly HarnessEvent[]> {
    this.#assertInitialized();
    return this.#store.readEvents(sessionId);
  }

  async close(signal?: AbortSignal): Promise<void> {
    this.#assertInitialized();
    if (this.#runtimeClosePromise !== undefined) {
      return this.#runtimeClosePromise;
    }
    throwIfAborted(signal);
    this.#closing = true;
    this.#activationAbort.abort(new TNanoError("ABORTED", "T-Nano runtime is closing"));
    this.#runtimeClosePromise = this.#closeRuntime();
    return this.#runtimeClosePromise;
  }

  async #closeRuntime(): Promise<void> {
    await Promise.allSettled(this.#activations);
    const sessions = [...this.#activeSessions.values()];
    const results = await Promise.allSettled(sessions.map((session) => session.close()));
    const failed = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failed !== undefined) {
      throw TNanoError.from(
        failed.reason,
        "ADAPTER_ERROR",
        "One or more harness sessions failed to close",
      );
    }
  }

  async #initializeOnce(): Promise<void> {
    await this.#store.initialize();
    const [profiles, settings, observations] = await Promise.all([
      this.#store.readProfiles(),
      this.#store.readSettings(),
      this.#store.readObservations(),
    ]);
    for (const profile of profiles) {
      validateProfile(profile);
      const storedProfile = cloneHarnessProfile(profile);
      this.#profiles.set(storedProfile.id, storedProfile);
    }
    for (const observation of observations) {
      this.#observations.set(observation.profileId, cloneProfileObservation(observation));
    }
    this.#settings = cloneRuntimeSettings(settings);
    this.#initialized = true;
  }

  #activate(
    binding: SessionBinding,
    harnessSession: HarnessSession,
    lease: SessionLease,
  ): RuntimeSessionController {
    const controller = new RuntimeSessionController({
      binding,
      harnessSession,
      lease,
      store: this.#store,
      now: () => this.#now(),
      onClose: (sessionId) => {
        this.#activeSessions.delete(sessionId);
      },
    });
    this.#activeSessions.set(binding.sessionId, controller);
    return controller;
  }

  async #openAdapter(
    adapter: HarnessAdapter,
    input: Parameters<HarnessAdapter["open"]>[0],
  ): Promise<HarnessSession> {
    try {
      const session = await adapter.open(input);
      if (typeof session !== "object" || session === null || typeof session.run !== "function") {
        throw new TNanoError(
          "INVALID_ADAPTER",
          `Harness adapter returned an invalid session: ${adapter.manifest.id}`,
        );
      }
      return session;
    } catch (error) {
      throw TNanoError.from(
        error,
        "ADAPTER_ERROR",
        `Could not open harness session: ${adapter.manifest.id}`,
        { harnessId: adapter.manifest.id, sessionId: input.sessionId },
      );
    }
  }

  async #cleanupFailedActivation(
    harnessSession: HarnessSession | undefined,
    lease: SessionLease | undefined,
    primaryError: unknown,
    sessionId: string,
  ): Promise<never> {
    const failures = [primaryError];
    if (harnessSession?.close !== undefined) {
      try {
        // Cleanup must not inherit a signal that may have caused the failure.
        await harnessSession.close();
      } catch (closeError) {
        failures.push(closeError);
      }
    }
    if (lease !== undefined) {
      try {
        await lease.release();
      } catch (releaseError) {
        failures.push(releaseError);
      }
    }
    if (failures.length === 1) {
      throw primaryError;
    }
    const primaryCode = primaryError instanceof TNanoError ? primaryError.code : "ADAPTER_ERROR";
    throw new TNanoError(
      primaryCode,
      `Session setup failed and cleanup also failed: ${sessionId}`,
      {
        cause: new AggregateError(failures, "Session setup and cleanup failed"),
        details: {
          sessionId,
          failures: failures.map(errorMessage),
        },
      },
    );
  }

  #reserveSession(sessionId: string): void {
    if (this.#openingSessions.has(sessionId) || this.#activeSessions.has(sessionId)) {
      throw new TNanoError("SESSION_ACTIVE", `Session is already active: ${sessionId}`, {
        details: { sessionId },
      });
    }
    this.#openingSessions.add(sessionId);
  }

  #requireProfile(profileId: string): HarnessProfile {
    const profile = this.#profiles.get(profileId);
    if (profile === undefined) {
      throw profileNotFound(profileId);
    }
    return profile;
  }

  #requireEnabledProfile(profileId: string): HarnessProfile {
    const profile = this.#requireProfile(profileId);
    if (!profile.enabled) {
      throw new TNanoError("PROFILE_DISABLED", `Harness profile is disabled: ${profileId}`, {
        details: { profileId },
      });
    }
    return profile;
  }

  #assertInitialized(): void {
    if (!this.#initialized) {
      throw new TNanoError("NOT_INITIALIZED", "T-Nano runtime must be initialized before use");
    }
  }

  #assertAcceptingSessions(): void {
    if (this.#closing) {
      throw new TNanoError(
        "SESSION_CLOSED",
        "T-Nano runtime is closing and cannot activate another session",
      );
    }
  }

  #trackActivation<T>(activation: Promise<T>): Promise<T> {
    const settled = activation.then(
      () => undefined,
      () => undefined,
    );
    this.#activations.add(settled);
    void settled.then(() => {
      this.#activations.delete(settled);
    });
    return activation;
  }

  #now(): string {
    let value: ReturnType<Clock>;
    try {
      value = this.#clock();
    } catch (error) {
      throw TNanoError.from(error, "INVALID_STATE", `Runtime clock failed: ${errorMessage(error)}`);
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new TNanoError("INVALID_STATE", "Runtime clock returned an invalid date");
    }
    return date.toISOString();
  }

  async #mutateProfiles<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#profileMutation;
    let release: () => void = () => undefined;
    this.#profileMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }

  async #recordObservation(
    profile: HarnessProfile,
    harnessId: string,
    result: ProbeResult,
    observedAt: string,
  ): Promise<ProfileObservation> {
    return this.#mutateObservations(async () => {
      const profileFingerprint = profileAccountFingerprint(profile);
      const previous = this.#observations.get(profile.id);
      const compatiblePrevious =
        previous !== undefined &&
        previous.harnessId === harnessId &&
        previous.profileFingerprint === profileFingerprint
          ? previous
          : undefined;
      const account = stableAccount(result);
      const baselineAccount =
        compatiblePrevious?.baselineAccount ??
        (account === undefined ? undefined : { observedAt, account });
      const observation: ProfileObservation = {
        version: 1,
        profileId: profile.id,
        harnessId,
        profileFingerprint,
        ...(baselineAccount === undefined ? {} : { baselineAccount }),
        latest: { ...result, observedAt },
      };
      this.#observations.set(profile.id, cloneProfileObservation(observation));
      await this.#store.writeObservations([...this.#observations.values()]);
      return cloneProfileObservation(observation);
    });
  }

  async #mutateObservations<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#observationMutation;
    let release: () => void = () => undefined;
    this.#observationMutation = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

interface RuntimeSessionControllerOptions {
  readonly binding: SessionBinding;
  readonly harnessSession: HarnessSession;
  readonly lease: SessionLease;
  readonly store: FileRuntimeStore;
  readonly now: () => string;
  readonly onClose: (sessionId: string) => void;
}

class RuntimeSessionController implements RuntimeSession {
  readonly #harnessSession: HarnessSession;
  readonly #lease: SessionLease;
  readonly #store: FileRuntimeStore;
  readonly #now: () => string;
  readonly #onClose: (sessionId: string) => void;
  #binding: SessionBinding;
  #turnActive = false;
  #closing = false;
  #closed = false;
  #turnAbort: AbortController | undefined;
  #persistenceTail: Promise<void> = Promise.resolve();
  #closePromise: Promise<void> | undefined;

  constructor(options: RuntimeSessionControllerOptions) {
    this.#binding = options.binding;
    this.#harnessSession = options.harnessSession;
    this.#lease = options.lease;
    this.#store = options.store;
    this.#now = options.now;
    this.#onClose = options.onClose;
  }

  get id(): string {
    return this.#binding.sessionId;
  }

  get binding(): SessionBindingView {
    return sessionBindingView(this.#binding);
  }

  get turnActive(): boolean {
    return this.#turnActive;
  }

  async *run(input: HarnessRunInput): AsyncIterable<HarnessEvent> {
    this.#assertOpen();
    if (this.#turnActive) {
      throw new TNanoError("TURN_ACTIVE", `Session already has an active turn: ${this.id}`, {
        details: { sessionId: this.id },
      });
    }
    if (input.text.trim() === "") {
      throw new TNanoError("INVALID_ARGUMENT", "Turn text cannot be empty");
    }
    throwIfAborted(input.signal);
    this.#turnActive = true;
    this.#turnAbort = new AbortController();
    const signal = combineSignals(input.signal, this.#turnAbort.signal);
    try {
      if (this.#binding.title === undefined) {
        const titledBinding = {
          ...this.#binding,
          title: titleFromPrompt(input.text),
          updatedAt: this.#now(),
        };
        await this.#queuePersistence(async () => {
          await this.#store.writeBinding(titledBinding);
          this.#binding = titledBinding;
        });
      }
      let events: AsyncIterable<HarnessEventInput>;
      try {
        events = this.#harnessSession.run({
          text: input.text,
          ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
          signal,
        });
      } catch (error) {
        throw TNanoError.from(error, "ADAPTER_ERROR", `Harness turn could not start: ${this.id}`, {
          sessionId: this.id,
        });
      }

      try {
        for await (const inputEvent of events) {
          validateEventInput(inputEvent);
          const event = await this.#persistEvent(inputEvent);
          yield event;
        }
      } catch (error) {
        throw TNanoError.from(error, "ADAPTER_ERROR", `Harness turn failed: ${this.id}`, {
          sessionId: this.id,
          harnessId: this.#binding.harnessId,
        });
      }
    } finally {
      this.#turnAbort = undefined;
      this.#turnActive = false;
    }
  }

  async respond(requestId: string, response: JsonValue, signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    throwIfAborted(signal);
    if (this.#harnessSession.respond === undefined) {
      throw new TNanoError(
        "UNSUPPORTED_OPERATION",
        `Harness session does not support structured responses: ${this.id}`,
        { details: { sessionId: this.id, requestId } },
      );
    }
    try {
      await this.#harnessSession.respond(requestId, response, signal);
    } catch (error) {
      throw TNanoError.from(error, "ADAPTER_ERROR", `Harness response failed: ${this.id}`, {
        sessionId: this.id,
        requestId,
      });
    }
  }

  async interrupt(signal?: AbortSignal): Promise<void> {
    this.#assertOpen();
    throwIfAborted(signal);
    this.#turnAbort?.abort(new TNanoError("ABORTED", "Turn interrupted"));
    if (this.#harnessSession.interrupt !== undefined) {
      try {
        await this.#harnessSession.interrupt(signal);
      } catch (error) {
        throw TNanoError.from(error, "ADAPTER_ERROR", `Harness interrupt failed: ${this.id}`, {
          sessionId: this.id,
        });
      }
    }
  }

  close(_signal?: AbortSignal): Promise<void> {
    if (this.#closePromise !== undefined) {
      return this.#closePromise;
    }
    if (this.#closed) {
      return Promise.resolve();
    }
    this.#closing = true;
    this.#turnAbort?.abort(new TNanoError("ABORTED", "Session closed"));
    this.#closePromise = this.#closeOnce();
    return this.#closePromise;
  }

  async #closeOnce(): Promise<void> {
    const failures: unknown[] = [];
    if (this.#harnessSession.interrupt !== undefined && this.#turnActive) {
      try {
        await this.#harnessSession.interrupt();
      } catch (error) {
        failures.push(error);
      }
    }
    if (this.#harnessSession.close !== undefined) {
      try {
        await this.#harnessSession.close();
      } catch (error) {
        failures.push(error);
      }
    }
    // Closing is marked before adapter cleanup starts, so no new persistence
    // operation can enter the queue. Drain anything already admitted before
    // releasing the cross-process lease.
    try {
      await this.#persistenceTail;
    } catch (error) {
      failures.push(error);
    }
    try {
      // Lease cleanup never inherits a caller signal: even failed or aborted
      // adapter cleanup must relinquish ownership once writes are blocked.
      await this.#lease.release();
    } catch (error) {
      failures.push(error);
    }
    this.#closed = true;
    this.#onClose(this.id);
    if (failures.length > 0) {
      throw new TNanoError("ADAPTER_ERROR", `Harness session failed to close cleanly: ${this.id}`, {
        cause:
          failures.length === 1
            ? failures[0]
            : new AggregateError(failures, "Harness interrupt and close failed"),
        details: {
          sessionId: this.id,
          failures: failures.map(errorMessage),
        },
      });
    }
  }

  async #persistEvent(input: HarnessEventInput): Promise<HarnessEvent> {
    return this.#queuePersistence(async () => {
      const timestamp = this.#now();
      const sequence = this.#binding.lastSequence + 1;
      const publicInput =
        input.type === "binding.updated" ? ({ type: "binding.updated" } as const) : input;
      const event = {
        ...publicInput,
        protocolVersion: 1,
        sequence,
        timestamp,
        sessionId: this.#binding.sessionId,
        profileId: this.#binding.profileId,
        harnessId: this.#binding.harnessId,
      } satisfies HarnessEvent;
      const updatedBinding: SessionBinding = {
        ...this.#binding,
        ...(input.type === "binding.updated" ? { resume: input.binding } : {}),
        updatedAt: timestamp,
        lastSequence: sequence,
      };
      if (input.type === "binding.updated") {
        // Native continuation state is authoritative. Commit it atomically before
        // the redacted display marker so a log failure cannot lose resumability.
        await this.#store.writeBinding(updatedBinding);
        this.#binding = updatedBinding;
        await this.#store.appendEvent(event);
      } else {
        await this.#store.appendEvent(event);
        this.#binding = updatedBinding;
        await this.#store.writeBinding(updatedBinding);
      }
      return event;
    });
  }

  #queuePersistence<T>(operation: () => Promise<T>): Promise<T> {
    this.#assertOpen();
    const result = this.#persistenceTail.then(operation);
    this.#persistenceTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #assertOpen(): void {
    if (this.#closing || this.#closed) {
      throw new TNanoError("SESSION_CLOSED", `Session is closed: ${this.id}`, {
        details: { sessionId: this.id },
      });
    }
  }
}

export async function createTNanoRuntime(options: TNanoRuntimeOptions): Promise<TNanoRuntime> {
  const runtime = new TNanoRuntime(options);
  await runtime.initialize();
  return runtime;
}

export function titleFromPrompt(prompt: string, maximumLength = 72): string {
  if (!Number.isSafeInteger(maximumLength) || maximumLength < 2) {
    throw new TNanoError(
      "INVALID_ARGUMENT",
      "Title maximum length must be an integer of at least 2",
    );
  }
  const firstMeaningfulLine = prompt
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line !== "");
  const normalized = (firstMeaningfulLine ?? "Untitled session").replace(/\s+/gu, " ");
  const characters = Array.from(normalized);
  if (characters.length <= maximumLength) {
    return normalized;
  }
  return `${characters.slice(0, maximumLength - 1).join("")}…`;
}

/**
 * Fingerprint only fields that can change adapter/account/continuation
 * semantics. Cosmetic labels and the enabled switch are intentionally absent.
 */
export function profileCompatibilityFingerprint(profile: HarnessProfile): string {
  validateProfile(profile);
  const compatibleFields: JsonObject = {
    harness: profile.harness,
    config: profile.config,
    environment: profile.environment ?? null,
    defaultModel: profile.defaultModel ?? null,
    defaultOptions: profile.defaultOptions ?? null,
  };
  return NodeCrypto.createHash("sha256").update(canonicalJson(compatibleFields)).digest("hex");
}

function profileAccountFingerprint(profile: HarnessProfile): string {
  validateProfile(profile);
  const accountFields: JsonObject = {
    harness: profile.harness,
    config: profile.config,
    environment: profile.environment ?? null,
  };
  return NodeCrypto.createHash("sha256").update(canonicalJson(accountFields)).digest("hex");
}

function validateProfile(profile: HarnessProfile): void {
  if (!isPlainObject(profile)) {
    throw new TNanoError("INVALID_ARGUMENT", "Profile must be a JSON object");
  }
  if (typeof profile.id !== "string") {
    throw new TNanoError("INVALID_ARGUMENT", "Profile id must be a string");
  }
  assertSafeId(profile.id, "profile id");
  if (typeof profile.harness !== "string" || profile.harness.trim() === "") {
    throw new TNanoError("INVALID_ARGUMENT", "Profile harness id cannot be empty");
  }
  if (typeof profile.label !== "string" || profile.label.trim() === "") {
    throw new TNanoError("INVALID_ARGUMENT", "Profile label cannot be empty");
  }
  if (typeof profile.enabled !== "boolean") {
    throw new TNanoError("INVALID_ARGUMENT", "Profile enabled must be a boolean");
  }
  assertJsonObject(profile.config, "profile config");
  if (
    profile.environment !== undefined &&
    (!isPlainObject(profile.environment) ||
      Object.values(profile.environment).some(
        (entry) => entry !== null && typeof entry !== "string",
      ))
  ) {
    throw new TNanoError(
      "INVALID_ARGUMENT",
      "Profile environment must map names to strings or null",
    );
  }
  if (
    profile.defaultModel !== undefined &&
    (typeof profile.defaultModel !== "string" || profile.defaultModel.trim() === "")
  ) {
    throw new TNanoError("INVALID_ARGUMENT", "Profile default model must be a non-empty string");
  }
  if (profile.defaultOptions !== undefined) {
    assertJsonObject(profile.defaultOptions, "profile default options");
  }
}

function validateProbeResult(result: unknown): asserts result is ProbeResult {
  if (
    typeof result !== "object" ||
    result === null ||
    !("status" in result) ||
    !["ready", "unavailable", "unauthenticated", "error"].includes(String(result.status))
  ) {
    throw new TNanoError("INVALID_ADAPTER", "Harness adapter returned an invalid probe result");
  }
  assertJsonValue(result, "probe result");
}

function validateEventInput(event: unknown): asserts event is HarnessEventInput {
  if (
    typeof event !== "object" ||
    event === null ||
    !("type" in event) ||
    typeof event.type !== "string" ||
    !CORE_EVENT_KIND_SET.has(event.type)
  ) {
    throw new TNanoError("INVALID_ADAPTER", "Harness adapter emitted an unsupported event kind");
  }
  assertJsonValue(event, "harness event");
}

function assertJsonValue(value: unknown, label: string): asserts value is JsonValue {
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
    if (typeof entry !== "object") {
      throw new TNanoError("INVALID_ARGUMENT", `${label} must contain only JSON-compatible values`);
    }
    if (seen.has(entry)) {
      throw new TNanoError("INVALID_ARGUMENT", `${label} cannot contain cycles`);
    }
    seen.add(entry);
    if (Array.isArray(entry)) {
      for (const item of entry) {
        visit(item);
      }
    } else {
      if (!isPlainObject(entry)) {
        throw new TNanoError("INVALID_ARGUMENT", `${label} must contain only plain JSON objects`);
      }
      for (const item of Object.values(entry)) {
        visit(item);
      }
    }
    seen.delete(entry);
  };
  visit(value);
}

function assertJsonObject(value: unknown, label: string): asserts value is JsonObject {
  if (!isPlainObject(value)) {
    throw new TNanoError("INVALID_ARGUMENT", `${label} must be a JSON object`);
  }
  assertJsonValue(value, label);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

function profileNotFound(profileId: string): TNanoError {
  return new TNanoError("PROFILE_NOT_FOUND", `Harness profile does not exist: ${profileId}`, {
    details: { profileId },
  });
}

function mergeOptions(
  defaults: JsonObject | undefined,
  overrides: JsonObject | undefined,
): JsonObject | undefined {
  if (defaults === undefined) {
    return overrides === undefined ? undefined : cloneJson(overrides);
  }
  if (overrides === undefined) {
    return cloneJson(defaults);
  }
  return cloneJson({ ...defaults, ...overrides });
}

function cloneJson<T extends JsonValue>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cloneHarnessProfile(profile: HarnessProfile): HarnessProfile {
  return {
    id: profile.id,
    harness: profile.harness,
    label: profile.label,
    enabled: profile.enabled,
    config: cloneJson(profile.config),
    ...(profile.environment === undefined ? {} : { environment: { ...profile.environment } }),
    ...(profile.defaultModel === undefined ? {} : { defaultModel: profile.defaultModel }),
    ...(profile.defaultOptions === undefined
      ? {}
      : { defaultOptions: cloneJson(profile.defaultOptions) }),
  };
}

function cloneHarnessManifest(manifest: HarnessManifest): HarnessManifest {
  return {
    apiVersion: manifest.apiVersion,
    id: manifest.id,
    label: manifest.label,
    version: manifest.version,
    capabilities: [...manifest.capabilities],
  };
}

function cloneProbeResult(result: ProbeResult): ProbeResult {
  return JSON.parse(JSON.stringify(result)) as ProbeResult;
}

function cloneProfileObservation(observation: ProfileObservation): ProfileObservation {
  return JSON.parse(JSON.stringify(observation)) as ProfileObservation;
}

function stableAccount(result: ProbeResult): ProbeAccount | undefined {
  if (result.status !== "ready" || result.account === undefined) return undefined;
  const { id, email } = result.account;
  if ((id === undefined || id.trim() === "") && (email === undefined || email.trim() === "")) {
    return undefined;
  }
  return JSON.parse(JSON.stringify(result.account)) as ProbeAccount;
}

function changedAccountIdentity(
  baseline: ProbeAccount,
  observed: ProbeAccount,
): "id" | "email" | undefined {
  if (
    baseline.id !== undefined &&
    baseline.id.trim() !== "" &&
    observed.id !== undefined &&
    observed.id.trim() !== ""
  ) {
    return baseline.id === observed.id ? undefined : "id";
  }
  if (
    baseline.email !== undefined &&
    baseline.email.trim() !== "" &&
    observed.email !== undefined &&
    observed.email.trim() !== ""
  ) {
    return baseline.email === observed.email ? undefined : "email";
  }
  return undefined;
}

function accountDriftWarnings(observation: ProfileObservation): readonly ProfileProbeWarning[] {
  const baseline = observation.baselineAccount;
  const observedAccount = stableAccount(observation.latest);
  if (baseline === undefined || observedAccount === undefined) return [];
  const changedField = changedAccountIdentity(baseline.account, observedAccount);
  if (changedField === undefined) return [];
  const observed: ProbeAccountObservation = {
    observedAt: observation.latest.observedAt,
    account: observedAccount,
  };
  return [
    {
      code: "account_identity_drift",
      message: `Profile ${observation.profileId} now reports a different account ${changedField}; T-Nano will not switch or fail over automatically.`,
      baseline,
      observed,
    },
  ];
}

function cloneRuntimeSettings(settings: RuntimeSettings): RuntimeSettings {
  return { version: 1, values: cloneJson(settings.values) };
}

function sessionBindingView(binding: SessionBinding): SessionBindingView {
  return {
    version: binding.version,
    sessionId: binding.sessionId,
    profileId: binding.profileId,
    harnessId: binding.harnessId,
    adapterVersion: binding.adapterVersion,
    profileFingerprint: binding.profileFingerprint,
    cwd: binding.cwd,
    ...(binding.model === undefined ? {} : { model: binding.model }),
    ...(binding.options === undefined ? {} : { options: cloneJson(binding.options) }),
    ...(binding.title === undefined ? {} : { title: binding.title }),
    createdAt: binding.createdAt,
    updatedAt: binding.updatedAt,
    lastSequence: binding.lastSequence,
  };
}

function combineSignals(external: AbortSignal | undefined, internal: AbortSignal): AbortSignal {
  return external === undefined ? internal : AbortSignal.any([external, internal]);
}

function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalJson((value as JsonObject)[key] as JsonValue)}`,
    )
    .join(",")}}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
