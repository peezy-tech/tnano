// @effect-diagnostics nodeBuiltinImport:off - Harness adapters intentionally supervise native processes with Node primitives.
import * as NodePath from "node:path";
import type {
  HarnessAdapter,
  HarnessEventInput,
  HarnessOpenInput,
  HarnessProfile,
  HarnessRunInput,
  HarnessSession,
  JsonObject,
  JsonValue,
  ProbeResult,
} from "@t-nano/sdk";
import {
  DEFAULT_PI_TERMINATION_TIMINGS,
  nodePiProcessLauncher,
  PiDeadlineExceededError,
  runCapturedPiChild,
  systemPiDeadlineFactory,
  terminatePiChild,
  type PiChildProcess,
  type PiDeadlineFactory,
  type PiProcessLauncher,
  type PiTerminationTimings,
} from "./process.ts";
import { isJsonObject, PiRpcClient } from "./rpc.ts";

const PI_ADAPTER_VERSION = "0.0.0";

export const DEFAULT_PI_PROBE_DEADLINE_MS = 5_000;
export const DEFAULT_PI_OPEN_DEADLINE_MS = 10_000;

export interface PiProfileConfig {
  readonly command: string;
  readonly agentDir: string;
  readonly sessionDir?: string;
  readonly provider?: string;
  readonly thinking?: string;
  readonly extraArgs: readonly string[];
}

export interface PiBinding extends JsonObject {
  readonly schema: 1;
  readonly profileId: string;
  readonly cwd: string;
  readonly sessionId: string;
  readonly sessionFile: string;
}

export interface PiAdapterOptions {
  readonly launcher?: PiProcessLauncher;
  readonly terminationTimings?: PiTerminationTimings;
  readonly deadlineFactory?: PiDeadlineFactory;
  readonly probeDeadlineMs?: number;
  readonly openDeadlineMs?: number;
}

export class PiAdapterError extends Error {
  override readonly name = "PiAdapterError";
  readonly code:
    | "invalid_profile"
    | "invalid_config"
    | "invalid_resume"
    | "invalid_state"
    | "busy"
    | "closed"
    | "dead"
    | "unknown_request";

  constructor(code: PiAdapterError["code"], message: string) {
    super(message);
    this.code = code;
  }
}

const manifest = {
  apiVersion: 1,
  id: "pi",
  label: "Pi",
  version: PI_ADAPTER_VERSION,
  capabilities: ["resume", "interrupt", "streaming", "thinking", "requests"] as const,
} as const;

export function createPiAdapter(options: PiAdapterOptions = {}): HarnessAdapter {
  const launcher = options.launcher ?? nodePiProcessLauncher;
  const timings = options.terminationTimings ?? DEFAULT_PI_TERMINATION_TIMINGS;
  const deadlineFactory = options.deadlineFactory ?? systemPiDeadlineFactory;
  const probeDeadlineMs = options.probeDeadlineMs ?? DEFAULT_PI_PROBE_DEADLINE_MS;
  const openDeadlineMs = options.openDeadlineMs ?? DEFAULT_PI_OPEN_DEADLINE_MS;
  return {
    manifest,
    async probe(profile, signal) {
      try {
        return await withDeadline(
          (boundedSignal) => probePiProfile(profile, launcher, timings, boundedSignal),
          deadlineFactory,
          probeDeadlineMs,
          "Pi probe",
          signal,
        );
      } catch (error) {
        if (signal?.aborted) throw error;
        if (error instanceof PiDeadlineExceededError) {
          return { status: "error", message: error.message };
        }
        throw error;
      }
    },
    open: (input) => openPiSession(input, launcher, timings, deadlineFactory, openDeadlineMs),
  };
}

async function probePiProfile(
  profile: HarnessProfile,
  launcher: PiProcessLauncher,
  timings: PiTerminationTimings,
  signal?: AbortSignal,
): Promise<ProbeResult> {
  try {
    signal?.throwIfAborted();
    assertPiProfile(profile);
    const config = parsePiProfileConfig(profile);
    const env = processEnvironment(profile, config);
    const versionResult = await runCapturedPiChild(
      launcher.spawn(config.command, ["--version"], {
        cwd: process.cwd(),
        env,
        ...(signal === undefined ? {} : { signal }),
      }),
      signal,
      timings,
    );
    signal?.throwIfAborted();
    if (versionResult.exitCode !== 0) {
      return {
        status: "unavailable",
        message: "Pi is installed but did not answer --version successfully.",
      };
    }
    const version = firstNonemptyLine(versionResult.stdout) ?? "unknown";
    if (config.provider === undefined) {
      return { status: "ready", version };
    }

    const auth = await runCapturedPiChild(
      launcher.spawn(
        config.command,
        ["auth", "check", "--provider", config.provider, "--json", "--no-refresh"],
        {
          cwd: process.cwd(),
          env,
          ...(signal === undefined ? {} : { signal }),
        },
      ),
      signal,
      timings,
    );
    signal?.throwIfAborted();
    const result = parseAuthCheck(auth.stdout);
    if (result === undefined) {
      return {
        status: "error",
        message: "Pi returned an invalid authentication check result.",
        version,
      };
    }
    const authType = typeof result.authType === "string" ? result.authType : undefined;
    const metadata: JsonObject = {
      provider: config.provider,
      ...(authType === undefined ? {} : { authType }),
    };
    if (result.status === "ready") {
      return {
        status: "ready",
        version,
        metadata,
      };
    }
    const reason = typeof result.reason === "string" ? result.reason : undefined;
    if (result.status === "not_ready") {
      return {
        status: "unauthenticated",
        version,
        message:
          reason === undefined
            ? `Pi provider ${config.provider} is not authenticated.`
            : `Pi provider ${config.provider} is not ready (${reason}).`,
        metadata,
      };
    }
    return {
      status: "error",
      version,
      message: `Pi provider ${config.provider} has invalid authentication state.`,
      metadata,
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (error instanceof PiAdapterError) {
      return { status: "error", message: error.message };
    }
    return {
      status: "unavailable",
      message: "Pi could not be launched for probing.",
    };
  }
}

async function openPiSession(
  input: HarnessOpenInput,
  launcher: PiProcessLauncher,
  timings: PiTerminationTimings,
  deadlineFactory: PiDeadlineFactory,
  openDeadlineMs: number,
): Promise<HarnessSession> {
  input.signal?.throwIfAborted();
  assertPiProfile(input.profile);
  const config = parsePiProfileConfig(input.profile);
  const resumeBinding = parseResumeBinding(input);
  const args = buildRpcArgs(config, input, resumeBinding);
  const child = launcher.spawn(config.command, args, {
    cwd: input.cwd,
    env: processEnvironment(input.profile, config),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  });
  const session = new PiHarnessSession(input, child, resumeBinding, timings);
  try {
    await withDeadline(
      () => session.initialize(),
      deadlineFactory,
      openDeadlineMs,
      "Pi RPC initialization",
      input.signal,
    );
    input.signal?.throwIfAborted();
    return session;
  } catch (error) {
    await session.close();
    throw error;
  }
}

interface ActiveTurn {
  readonly queue: AsyncEventQueue<HarnessEventInput>;
  failed: boolean;
  interrupted: boolean;
  runningEmitted: boolean;
  settling: boolean;
}

class PiHarnessSession implements HarnessSession {
  readonly #input: HarnessOpenInput;
  readonly #child: PiChildProcess;
  readonly #rpc: PiRpcClient;
  readonly #resumeBinding: PiBinding | undefined;
  readonly #timings: PiTerminationTimings;
  readonly #requests = new Map<string, string>();
  #active: ActiveTurn | undefined;
  #binding: PiBinding | undefined;
  #dead: Error | undefined;
  #closed = false;
  #closing = false;
  #closePromise: Promise<void> | undefined;

  constructor(
    input: HarnessOpenInput,
    child: PiChildProcess,
    resumeBinding: PiBinding | undefined,
    timings: PiTerminationTimings,
  ) {
    this.#input = input;
    this.#child = child;
    this.#resumeBinding = resumeBinding;
    this.#timings = timings;
    this.#rpc = new PiRpcClient(child, {
      onEvent: (event) => this.#onNativeEvent(event),
      onProtocolError: (error) => this.#onProcessError(error),
      onExit: (code, signal) => this.#onProcessExit(code, signal),
    });
  }

  get binding(): JsonValue {
    if (this.#binding === undefined) {
      throw new PiAdapterError("invalid_state", "Pi session has not completed its handshake.");
    }
    return this.#binding;
  }

  async initialize(): Promise<void> {
    const response = await this.#rpc.request({ type: "get_state" });
    const binding = bindingFromState(response.data, this.#input);
    if (this.#resumeBinding !== undefined) {
      if (
        binding.sessionId !== this.#resumeBinding.sessionId ||
        NodePath.resolve(binding.sessionFile) !== NodePath.resolve(this.#resumeBinding.sessionFile)
      ) {
        throw new PiAdapterError(
          "invalid_resume",
          "Pi resumed a different native session than the stored binding.",
        );
      }
    }
    this.#binding = binding;
  }

  run(input: HarnessRunInput): AsyncIterable<HarnessEventInput> {
    this.#throwIfDead();
    if (this.#closed || this.#closing) {
      throw new PiAdapterError("closed", "Pi session is closed.");
    }
    if (this.#active !== undefined) {
      throw new PiAdapterError("busy", "Pi session already has an active turn.");
    }
    input.signal?.throwIfAborted();

    const active: ActiveTurn = {
      queue: new AsyncEventQueue<HarnessEventInput>(),
      failed: false,
      interrupted: false,
      runningEmitted: false,
      settling: false,
    };
    this.#active = active;
    const onAbort = () => {
      active.interrupted = true;
      void this.interrupt().catch((error: unknown) => this.#turnError(toError(error)));
    };
    input.signal?.addEventListener("abort", onAbort, { once: true });
    void this.#beginTurn(input, active);

    const finish = () => {
      if (this.#active === active && active.queue.ended) this.#active = undefined;
    };
    return (async function* () {
      try {
        yield* active.queue;
      } finally {
        input.signal?.removeEventListener("abort", onAbort);
        finish();
      }
    })();
  }

  async respond(requestId: string, response: JsonValue, signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#throwIfDead();
    if (this.#closed || this.#closing) {
      throw new PiAdapterError("closed", "Pi session is closed.");
    }
    const method = this.#requests.get(requestId);
    if (method === undefined) {
      throw new PiAdapterError("unknown_request", `Unknown Pi request ${requestId}.`);
    }
    const nativeResponse = extensionUiResponse(requestId, method, response);
    await this.#rpc.notify(nativeResponse, false);
    this.#requests.delete(requestId);
    this.#active?.queue.push({ type: "request.resolved", requestId, response });
  }

  async interrupt(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.#throwIfDead();
    if (this.#closed || this.#closing) return;
    if (this.#active !== undefined) this.#active.interrupted = true;
    await this.#rpc.request({ type: "abort" }, false);
  }

  close(_signal?: AbortSignal): Promise<void> {
    if (this.#closed) return Promise.resolve();
    this.#closePromise ??= this.#performClose();
    return this.#closePromise;
  }

  async #performClose(): Promise<void> {
    this.#closing = true;
    try {
      if (this.#active !== undefined && this.#dead === undefined) {
        this.#active.interrupted = true;
        try {
          await this.#rpc.notify({ type: "abort" }, false);
        } catch {
          // The process may already be exiting. Stdin EOF remains the graceful path.
        }
      }
      this.#requests.clear();
      try {
        this.#child.endStdin();
      } catch {
        // Continue to bounded process termination when stdin is already broken.
      }
      let exited = false;
      try {
        exited = await this.#child.waitForExit(this.#timings.stdinCloseMs);
      } catch {
        // A broken wait path must not prevent TERM/KILL cleanup.
      }
      if (!exited) {
        await terminatePiChild(this.#child, this.#timings);
      }
    } finally {
      this.#closed = true;
      this.#closing = false;
      this.#rpc.dispose();
      this.#active?.queue.end();
      this.#active = undefined;
    }
  }

  async #beginTurn(input: HarnessRunInput, active: ActiveTurn): Promise<void> {
    try {
      const images = parseImages(input.attachments);
      await this.#rpc.request(
        {
          type: "prompt",
          message: input.text,
          ...(images.length === 0 ? {} : { images }),
        },
        true,
      );

      // Extension commands can complete without an agent lifecycle. An immediate
      // idle state after prompt acceptance is therefore a valid settlement.
      const state = await this.#rpc.request({ type: "get_state" });
      if (
        this.#active === active &&
        isJsonObject(state.data) &&
        state.data.isStreaming === false &&
        !active.runningEmitted &&
        !active.settling
      ) {
        await this.#settle(active);
      }
    } catch (error) {
      if (this.#active !== active || active.settling) return;
      if (this.#dead !== undefined) return;
      active.failed = true;
      active.queue.push(errorEvent("pi_prompt_rejected", toError(error), true));
      active.queue.push({ type: "turn.state", state: "failed" });
      if (this.#dead === undefined) active.queue.push({ type: "session.state", state: "ready" });
      active.queue.end();
    }
  }

  #onNativeEvent(event: Record<string, unknown>): void {
    const active = this.#active;
    const type = typeof event.type === "string" ? event.type : undefined;
    if (active === undefined) return;

    switch (type) {
      case "agent_start":
      case "turn_start":
        this.#emitRunning(active);
        return;
      case "agent_settled":
        void this.#settle(active);
        return;
      case "message_update":
        this.#mapMessageUpdate(event, active);
        return;
      case "message_end":
        this.#mapMessageEnd(event, active);
        return;
      case "tool_execution_start":
      case "tool_execution_update":
      case "tool_execution_end":
        this.#mapToolEvent(type, event, active);
        return;
      case "extension_ui_request":
        this.#mapExtensionRequest(event, active);
        return;
      case "extension_error": {
        active.failed = true;
        const message = typeof event.error === "string" ? event.error : "Pi extension failed.";
        active.queue.push({
          type: "error",
          code: "pi_extension_error",
          message,
          recoverable: true,
          details: toJsonValue(event),
        });
        return;
      }
      default:
        active.queue.push({
          type: "custom",
          name: `pi.rpc.${type ?? "unknown"}`,
          payload: toJsonValue(event),
        });
    }
  }

  #emitRunning(active: ActiveTurn): void {
    if (active.runningEmitted) return;
    active.runningEmitted = true;
    active.queue.push({ type: "session.state", state: "running" });
    active.queue.push({ type: "turn.state", state: "running" });
  }

  #mapMessageUpdate(event: Record<string, unknown>, active: ActiveTurn): void {
    const update = event.assistantMessageEvent;
    if (!isJsonObject(update)) {
      active.queue.push({
        type: "custom",
        name: "pi.rpc.message_update",
        payload: toJsonValue(event),
      });
      return;
    }
    if (update.type === "text_delta" && typeof update.delta === "string") {
      active.queue.push({ type: "content.delta", text: update.delta, channel: "assistant" });
      return;
    }
    if (update.type === "thinking_delta" && typeof update.delta === "string") {
      active.queue.push({ type: "content.delta", text: update.delta, channel: "thinking" });
      return;
    }
    if (update.type === "text_start" || update.type === "text_end") return;
    if (update.type === "thinking_start" || update.type === "thinking_end") return;
    active.queue.push({
      type: "custom",
      name: `pi.rpc.message_update.${String(update.type ?? "unknown")}`,
      payload: toJsonValue(event),
    });
  }

  #mapMessageEnd(event: Record<string, unknown>, active: ActiveTurn): void {
    const message = event.message;
    if (!isJsonObject(message) || message.role !== "assistant") return;
    if (message.stopReason === "aborted") active.interrupted = true;
    if (message.stopReason === "error") {
      active.failed = true;
      active.queue.push({
        type: "error",
        code: "pi_assistant_error",
        message:
          typeof message.errorMessage === "string"
            ? message.errorMessage
            : "Pi assistant request failed.",
        recoverable: true,
      });
    }
  }

  #mapToolEvent(
    type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end",
    event: Record<string, unknown>,
    active: ActiveTurn,
  ): void {
    if (typeof event.toolCallId !== "string") {
      active.queue.push({
        type: "custom",
        name: `pi.rpc.${type}`,
        payload: toJsonValue(event),
      });
      return;
    }
    const status =
      type === "tool_execution_end" ? (event.isError === true ? "failed" : "completed") : "running";
    active.queue.push({
      type: "activity.upsert",
      activityId: event.toolCallId,
      activity: {
        status,
        ...(typeof event.toolName === "string" ? { name: event.toolName } : {}),
        ...(event.args === undefined ? {} : { args: toJsonValue(event.args) }),
        ...(event.partialResult === undefined ? {} : { result: toJsonValue(event.partialResult) }),
        ...(event.result === undefined ? {} : { result: toJsonValue(event.result) }),
      },
    });
  }

  #mapExtensionRequest(event: Record<string, unknown>, active: ActiveTurn): void {
    const id = typeof event.id === "string" ? event.id : undefined;
    const method = typeof event.method === "string" ? event.method : undefined;
    if (id === undefined || method === undefined) {
      active.queue.push({
        type: "custom",
        name: "pi.rpc.extension_ui_request",
        payload: toJsonValue(event),
      });
      return;
    }
    if (["select", "confirm", "input", "editor"].includes(method)) {
      this.#requests.set(id, method);
      active.queue.push({
        type: "request.opened",
        requestId: id,
        request: toJsonValue(event) as JsonObject,
      });
      return;
    }
    active.queue.push({
      type: "custom",
      name: `pi.rpc.extension_ui.${method}`,
      payload: toJsonValue(event),
    });
  }

  async #settle(active: ActiveTurn): Promise<void> {
    if (this.#active !== active || active.settling) return;
    active.settling = true;
    try {
      const response = await this.#rpc.request({ type: "get_state" });
      const nextBinding = bindingFromState(response.data, this.#input);
      if (!sameBinding(this.#binding, nextBinding)) {
        this.#binding = nextBinding;
        active.queue.push({ type: "binding.updated", binding: nextBinding });
      }
    } catch (error) {
      if (!this.#closing && !this.#closed && this.#dead === undefined) {
        active.failed = true;
        active.queue.push(errorEvent("pi_state_refresh_failed", toError(error), true));
      }
    }

    if (active.queue.ended) return;

    active.queue.push({
      type: "turn.state",
      state: active.interrupted ? "interrupted" : active.failed ? "failed" : "completed",
    });
    if (!this.#closing && !this.#closed && this.#dead === undefined) {
      active.queue.push({ type: "session.state", state: "ready" });
    }
    active.queue.end();
  }

  #turnError(error: Error): void {
    const active = this.#active;
    if (active === undefined || active.settling || this.#dead !== undefined) return;
    active.failed = true;
    active.queue.push(errorEvent("pi_interrupt_failed", error, true));
  }

  #onProcessError(error: Error): void {
    this.#markDead("pi_process_error", error);
  }

  #onProcessExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.#markDead(
      "pi_process_exit",
      new Error(`Pi exited unexpectedly (code=${String(code)}, signal=${String(signal)}).`),
    );
  }

  #markDead(code: string, error: Error): void {
    if (this.#closing || this.#closed || this.#dead !== undefined) return;
    this.#dead = error;
    this.#requests.clear();
    const active = this.#active;
    if (active !== undefined && !active.queue.ended) {
      active.failed = true;
      active.queue.push(errorEvent(code, error, false));
      active.queue.push({ type: "turn.state", state: "failed" });
      active.queue.push({ type: "session.state", state: "failed" });
      active.queue.end();
    }
    void this.close();
  }

  #throwIfDead(): void {
    if (this.#dead === undefined) return;
    throw new PiAdapterError("dead", `Pi session is no longer running: ${this.#dead.message}`);
  }
}

function assertPiProfile(profile: HarnessProfile): void {
  if (profile.harness !== manifest.id) {
    throw new PiAdapterError(
      "invalid_profile",
      `Pi adapter cannot open harness ${JSON.stringify(profile.harness)}.`,
    );
  }
}

export function parsePiProfileConfig(profile: HarnessProfile): PiProfileConfig {
  const config = profile.config;
  const command = optionalString(config.command, "command") ?? "pi";
  const agentDir = requiredString(config.agentDir, "agentDir");
  const sessionDir = optionalString(config.sessionDir, "sessionDir");
  const provider = optionalString(config.provider, "provider");
  const thinking = optionalString(config.thinking, "thinking");
  const extraArgs = optionalStringArray(config.extraArgs, "extraArgs");
  for (const arg of extraArgs) {
    if (isReservedArgument(arg)) {
      throw new PiAdapterError(
        "invalid_config",
        `Pi extraArgs may not override T-Nano lifecycle option ${JSON.stringify(arg)}.`,
      );
    }
  }
  return {
    command,
    agentDir,
    ...(sessionDir === undefined ? {} : { sessionDir }),
    ...(provider === undefined ? {} : { provider }),
    ...(thinking === undefined ? {} : { thinking }),
    extraArgs,
  };
}

function processEnvironment(
  profile: HarnessProfile,
  config: PiProfileConfig,
): Readonly<Record<string, string | undefined>> {
  const environment: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(profile.environment ?? {})) {
    environment[name] = value === null ? undefined : value;
  }
  environment.PI_CODING_AGENT_DIR = config.agentDir;
  if (config.sessionDir !== undefined) {
    environment.PI_CODING_AGENT_SESSION_DIR = config.sessionDir;
  }
  return environment;
}

function buildRpcArgs(
  config: PiProfileConfig,
  input: HarnessOpenInput,
  resumeBinding: PiBinding | undefined,
): readonly string[] {
  const args = [...config.extraArgs, "--mode", "rpc"];
  if (config.provider !== undefined) args.push("--provider", config.provider);
  if (input.model !== undefined) args.push("--model", input.model);
  if (config.thinking !== undefined) args.push("--thinking", config.thinking);
  if (resumeBinding !== undefined) args.push("--session", resumeBinding.sessionFile);
  return args;
}

function parseResumeBinding(input: HarnessOpenInput): PiBinding | undefined {
  if (input.resume === undefined) return undefined;
  const value = input.resume;
  if (
    !isSdkObject(value) ||
    value.schema !== 1 ||
    value.profileId !== input.profile.id ||
    value.cwd !== input.cwd ||
    typeof value.sessionId !== "string" ||
    value.sessionId.length === 0 ||
    typeof value.sessionFile !== "string" ||
    !NodePath.isAbsolute(value.sessionFile)
  ) {
    throw new PiAdapterError(
      "invalid_resume",
      "Pi resume binding must be absolute and belong to this profile and cwd.",
    );
  }
  return value as PiBinding;
}

function bindingFromState(state: unknown, input: HarnessOpenInput): PiBinding {
  if (
    !isJsonObject(state) ||
    typeof state.sessionId !== "string" ||
    state.sessionId.length === 0 ||
    typeof state.sessionFile !== "string" ||
    !NodePath.isAbsolute(state.sessionFile)
  ) {
    throw new PiAdapterError(
      "invalid_state",
      "Pi get_state did not return a resumable session binding.",
    );
  }
  return {
    schema: 1,
    profileId: input.profile.id,
    cwd: input.cwd,
    sessionId: state.sessionId,
    sessionFile: state.sessionFile,
  };
}

function sameBinding(left: PiBinding | undefined, right: PiBinding): boolean {
  return (
    left !== undefined &&
    left.profileId === right.profileId &&
    left.cwd === right.cwd &&
    left.sessionId === right.sessionId &&
    NodePath.resolve(left.sessionFile) === NodePath.resolve(right.sessionFile)
  );
}

function parseImages(attachments: readonly JsonValue[] | undefined): readonly JsonObject[] {
  if (attachments === undefined) return [];
  return attachments.map((attachment) => {
    if (
      !isSdkObject(attachment) ||
      attachment.type !== "image" ||
      typeof attachment.data !== "string" ||
      typeof attachment.mimeType !== "string"
    ) {
      throw new PiAdapterError(
        "invalid_config",
        "Pi only accepts inline image attachments with data and mimeType.",
      );
    }
    return {
      type: "image",
      data: attachment.data,
      mimeType: attachment.mimeType,
    };
  });
}

function extensionUiResponse(
  requestId: string,
  method: string,
  response: JsonValue,
): Record<string, unknown> {
  if (response === null || (isSdkObject(response) && response.cancelled === true)) {
    return { type: "extension_ui_response", id: requestId, cancelled: true };
  }
  if (method === "confirm") {
    const confirmed =
      typeof response === "boolean"
        ? response
        : isSdkObject(response) && typeof response.confirmed === "boolean"
          ? response.confirmed
          : undefined;
    if (confirmed === undefined) {
      throw new PiAdapterError("invalid_state", "Pi confirm responses must be boolean.");
    }
    return { type: "extension_ui_response", id: requestId, confirmed };
  }
  const value =
    typeof response === "string"
      ? response
      : isSdkObject(response) && typeof response.value === "string"
        ? response.value
        : undefined;
  if (value === undefined) {
    throw new PiAdapterError("invalid_state", `Pi ${method} responses must be strings.`);
  }
  return { type: "extension_ui_response", id: requestId, value };
}

function parseAuthCheck(stdout: string): Record<string, unknown> | undefined {
  const line = firstNonemptyLine(stdout);
  if (line === undefined) return undefined;
  try {
    const parsed = JSON.parse(line) as unknown;
    return isJsonObject(parsed) && typeof parsed.status === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function firstNonemptyLine(value: string): string | undefined {
  return value
    .split(/\r?\n/u)
    .find((line) => line.trim().length > 0)
    ?.trim();
}

function requiredString(value: JsonValue | undefined, name: string): string {
  const result = optionalString(value, name);
  if (result === undefined) {
    throw new PiAdapterError("invalid_config", `Pi profile config requires ${name}.`);
  }
  return result;
}

function optionalString(value: JsonValue | undefined, name: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new PiAdapterError(
      "invalid_config",
      `Pi profile config ${name} must be a nonempty string.`,
    );
  }
  return value;
}

function optionalStringArray(value: JsonValue | undefined, name: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new PiAdapterError(
      "invalid_config",
      `Pi profile config ${name} must be an array of strings.`,
    );
  }
  return value as readonly string[];
}

const RESERVED_OPTIONS = new Set([
  "-c",
  "-p",
  "-r",
  "--api-key",
  "--continue",
  "--export",
  "--fork",
  "--mode",
  "--model",
  "--no-session",
  "--print",
  "--provider",
  "--resume",
  "--session",
  "--session-dir",
  "--session-id",
  "--thinking",
]);

function isReservedArgument(argument: string): boolean {
  const option = argument.split("=", 1)[0];
  return option !== undefined && RESERVED_OPTIONS.has(option);
}

function isSdkObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toJsonValue(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(toJsonValue);
  if (isJsonObject(value)) {
    const result: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toJsonValue(item);
    }
    return result;
  }
  return String(value);
}

function errorEvent(code: string, error: Error, recoverable: boolean): HarnessEventInput {
  return { type: "error", code, message: error.message, recoverable };
}

async function withCancellation<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return operation();
  signal.throwIfAborted();
  let rejectCancellation!: (error: Error) => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    rejectCancellation = reject;
  });
  const onAbort = () => rejectCancellation(abortError(signal));
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([operation(), cancelled]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  factory: PiDeadlineFactory,
  timeoutMs: number,
  label: string,
  callerSignal?: AbortSignal,
): Promise<T> {
  callerSignal?.throwIfAborted();
  const deadline = factory.create(timeoutMs, label);
  const signal =
    callerSignal === undefined ? deadline.signal : AbortSignal.any([callerSignal, deadline.signal]);
  try {
    const result = await withCancellation(() => operation(signal), signal);
    signal.throwIfAborted();
    return result;
  } finally {
    deadline.dispose();
  }
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("The Pi operation was aborted.");
  error.name = "AbortError";
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}

class AsyncEventQueue<T> implements AsyncIterable<T> {
  readonly #values: T[] = [];
  readonly #waiters: Array<(result: IteratorResult<T>) => void> = [];
  #ended = false;

  get ended(): boolean {
    return this.#ended;
  }

  push(value: T): void {
    if (this.#ended) return;
    const waiter = this.#waiters.shift();
    if (waiter === undefined) this.#values.push(value);
    else waiter({ done: false, value });
  }

  end(): void {
    if (this.#ended) return;
    this.#ended = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const value = this.#values.shift();
        if (value !== undefined) return Promise.resolve({ done: false, value });
        if (this.#ended) return Promise.resolve({ done: true, value: undefined });
        return new Promise((resolveNext) => this.#waiters.push(resolveNext));
      },
    };
  }
}

const piAdapter = createPiAdapter();

export default piAdapter;
