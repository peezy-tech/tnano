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

import { parseCodexRecord, parseJsonLine, type CodexNormalizedEvent } from "./jsonl.ts";
import {
  collectText,
  type Clock,
  DEFAULT_TERMINATION_TIMINGS,
  type LaunchProcessInput,
  nodeProcessLauncher,
  type ProcessExit,
  type ProcessLauncher,
  type SpawnedProcess,
  splitLfLines,
  systemClock,
  terminateProcess,
  type TerminationTimings,
} from "./process.ts";

export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";

export interface CodexProfileConfig {
  readonly command: string;
  readonly codexHome?: string;
  readonly extraArgs: readonly string[];
  readonly sandbox: CodexSandbox;
}

export interface CodexAdapterOptions {
  readonly launcher?: ProcessLauncher;
  readonly clock?: Clock;
  readonly baseEnvironment?: NodeJS.ProcessEnv;
  readonly probeTimeoutMs?: number;
  readonly terminationTimings?: TerminationTimings;
}

export class CodexAdapterError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "CodexAdapterError";
    this.code = code;
  }
}

interface CodexBinding extends JsonObject {
  readonly schema: 1;
  readonly threadId: string;
  readonly profileId: string;
  readonly codexHomeKey: string;
}

interface CapturedCommandResult {
  readonly exit: ProcessExit;
  readonly stdout: string;
  readonly stderr: string;
  readonly writeError?: Error;
  readonly aborted: boolean;
}

interface ActiveRun {
  readonly child: SpawnedProcess;
  interrupted: boolean;
  termination?: Promise<void>;
}

const SANDBOXES = new Set<CodexSandbox>(["read-only", "workspace-write", "danger-full-access"]);

const MANIFEST = {
  apiVersion: 1,
  id: "codex",
  label: "Codex",
  version: "0.0.0",
  capabilities: ["resume", "model", "final-content", "activities", "interrupt"] as const,
} as const;

function optionalString(config: JsonObject, key: string): string | undefined {
  const value = config[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new CodexAdapterError(
      "invalid_profile",
      `Codex profile ${key} must be a non-empty string`,
    );
  }
  return value;
}

export function parseCodexProfileConfig(profile: HarnessProfile): CodexProfileConfig {
  if (profile.harness !== MANIFEST.id) {
    throw new CodexAdapterError(
      "invalid_profile",
      `Codex adapter cannot open harness ${JSON.stringify(profile.harness)}`,
    );
  }
  const config = profile.config;
  const command = optionalString(config, "command") ?? "codex";
  const codexHome = optionalString(config, "codexHome");

  const sandboxValue = config.sandbox ?? "read-only";
  if (typeof sandboxValue !== "string" || !SANDBOXES.has(sandboxValue as CodexSandbox)) {
    throw new CodexAdapterError(
      "invalid_profile",
      "Codex profile sandbox must be read-only, workspace-write, or danger-full-access",
    );
  }

  const extraArgsValue = config.extraArgs ?? [];
  if (
    !Array.isArray(extraArgsValue) ||
    extraArgsValue.some((argument) => typeof argument !== "string")
  ) {
    throw new CodexAdapterError(
      "invalid_profile",
      "Codex profile extraArgs must be an array of strings",
    );
  }

  return {
    command,
    ...(codexHome === undefined ? {} : { codexHome }),
    extraArgs: extraArgsValue as readonly string[],
    sandbox: sandboxValue as CodexSandbox,
  };
}

export function buildCodexEnvironment(
  profile: HarnessProfile,
  config: CodexProfileConfig,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...baseEnvironment };
  for (const [key, value] of Object.entries(profile.environment ?? {})) {
    if (value === null) delete environment[key];
    else environment[key] = value;
  }
  if (config.codexHome !== undefined) environment.CODEX_HOME = config.codexHome;
  return environment;
}

export function buildCodexExecArgs(input: {
  readonly config: CodexProfileConfig;
  readonly cwd: string;
  readonly model?: string;
  readonly threadId?: string;
}): readonly string[] {
  const shared = [
    "exec",
    "--json",
    "--color",
    "never",
    "--sandbox",
    input.config.sandbox,
    "--cd",
    input.cwd,
    ...(input.model === undefined ? [] : ["--model", input.model]),
    ...input.config.extraArgs,
  ];

  return input.threadId === undefined
    ? [...shared, "-"]
    : [...shared, "resume", input.threadId, "-"];
}

function trimOutput(stdout: string, stderr: string): string | undefined {
  const output = stdout.trim() || stderr.trim();
  return output.length > 0 ? output.slice(0, 4 * 1024) : undefined;
}

function processFailureMessage(result: CapturedCommandResult, fallback: string): string {
  if (result.exit.error) return result.exit.error.message;
  return trimOutput(result.stderr, result.stdout) ?? fallback;
}

async function runCapturedCommand(
  launcher: ProcessLauncher,
  clock: Clock,
  terminationTimings: TerminationTimings,
  input: LaunchProcessInput,
  signal: AbortSignal,
): Promise<CapturedCommandResult> {
  signal.throwIfAborted();
  let child: SpawnedProcess;
  try {
    child = launcher.launch(input);
  } catch (error) {
    return {
      exit: {
        code: null,
        signal: null,
        error: error instanceof Error ? error : new Error(String(error)),
      },
      stdout: "",
      stderr: "",
      aborted: false,
    };
  }

  let aborted = false;
  let termination: Promise<void> | undefined;
  const abort = () => {
    aborted = true;
    termination ??= terminateProcess(child, clock, terminationTimings);
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();

  const stdout = collectText(child.stdout);
  const stderr = collectText(child.stderr);
  const write = child.writeAndCloseStdin("").then(
    () => undefined,
    (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
  );

  const [exit, output, diagnostics, writeError] = await Promise.all([
    child.exited,
    stdout,
    stderr,
    write,
  ]);
  if (termination) await termination;
  signal.removeEventListener("abort", abort);

  return {
    exit,
    stdout: output,
    stderr: diagnostics,
    ...(writeError === undefined ? {} : { writeError }),
    aborted,
  };
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseResumeBinding(
  resume: JsonValue | undefined,
  profileId: string,
  codexHomeKey: string,
): string | undefined {
  if (resume === undefined) return undefined;
  if (!isJsonObject(resume)) {
    throw new CodexAdapterError("invalid_resume", "Codex resume binding must be an object");
  }

  if (
    resume.schema !== 1 ||
    typeof resume.threadId !== "string" ||
    resume.threadId.length === 0 ||
    resume.profileId !== profileId ||
    resume.codexHomeKey !== codexHomeKey
  ) {
    throw new CodexAdapterError(
      "incompatible_resume",
      "Codex session binding does not match the selected profile and CODEX_HOME",
    );
  }
  return resume.threadId;
}

function bindingFor(threadId: string, profileId: string, codexHomeKey: string): CodexBinding {
  return { schema: 1, threadId, profileId, codexHomeKey };
}

function eventFromNormalized(event: CodexNormalizedEvent): HarnessEventInput | undefined {
  switch (event.type) {
    case "binding":
      return undefined;
    case "turn":
      return { type: "turn.state", state: event.state, detail: event.raw };
    case "content":
      return { type: "content.delta", text: event.text, channel: "final" };
    case "activity":
      return {
        type: "activity.upsert",
        activityId: event.activityId,
        activity: {
          phase: event.phase,
          item: event.item,
          native: event.raw,
        },
      };
    case "error":
      return {
        type: "error",
        code: "codex_error",
        message: event.message,
        recoverable: false,
        details: event.raw,
      };
    case "custom":
      return { type: "custom", name: event.name, payload: event.data };
  }
}

class CodexSession {
  private readonly openInput: HarnessOpenInput;
  private readonly config: CodexProfileConfig;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly codexHomeKey: string;
  private readonly launcher: ProcessLauncher;
  private readonly clock: Clock;
  private readonly terminationTimings: TerminationTimings;
  private threadId: string | undefined;
  private active: ActiveRun | "starting" | undefined;
  private closed = false;

  constructor(
    openInput: HarnessOpenInput,
    config: CodexProfileConfig,
    environment: NodeJS.ProcessEnv,
    codexHomeKey: string,
    launcher: ProcessLauncher,
    clock: Clock,
    terminationTimings: TerminationTimings,
    resumeThreadId: string | undefined,
  ) {
    this.openInput = openInput;
    this.config = config;
    this.environment = environment;
    this.codexHomeKey = codexHomeKey;
    this.launcher = launcher;
    this.clock = clock;
    this.terminationTimings = terminationTimings;
    this.threadId = resumeThreadId;
  }

  initialBinding(): JsonValue | undefined {
    return this.threadId === undefined
      ? undefined
      : bindingFor(this.threadId, this.openInput.profile.id, this.codexHomeKey);
  }

  run(input: HarnessRunInput): AsyncIterable<HarnessEventInput> {
    return this.runInternal(input);
  }

  private async *runInternal(input: HarnessRunInput): AsyncIterable<HarnessEventInput> {
    if (this.closed) {
      throw new CodexAdapterError("session_closed", "Codex session is closed");
    }
    if (this.active !== undefined) {
      throw new CodexAdapterError("turn_active", "Codex session already has an active turn");
    }
    if ((input.attachments?.length ?? 0) > 0) {
      throw new CodexAdapterError(
        "unsupported_attachments",
        "The Codex exec adapter does not support attachments",
      );
    }
    input.signal?.throwIfAborted();

    this.active = "starting";
    const resumeThreadId = this.threadId;
    let child: SpawnedProcess;
    try {
      child = this.launcher.launch({
        command: this.config.command,
        args: buildCodexExecArgs({
          config: this.config,
          cwd: this.openInput.cwd,
          ...(this.openInput.model === undefined ? {} : { model: this.openInput.model }),
          ...(resumeThreadId === undefined ? {} : { threadId: resumeThreadId }),
        }),
        cwd: this.openInput.cwd,
        env: this.environment,
      });
    } catch (error) {
      this.active = undefined;
      yield {
        type: "error",
        code: "codex_spawn_failed",
        message: error instanceof Error ? error.message : String(error),
        recoverable: true,
      };
      yield { type: "turn.state", state: "failed" };
      return;
    }

    const active: ActiveRun = { child, interrupted: false };
    this.active = active;
    const abort = () => {
      active.interrupted = true;
      active.termination ??= terminateProcess(child, this.clock, this.terminationTimings);
    };
    input.signal?.addEventListener("abort", abort, { once: true });
    if (input.signal?.aborted) abort();

    const stderrPromise = collectText(child.stderr);
    const writePromise = child.writeAndCloseStdin(input.text).then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error : new Error(String(error))),
    );
    let sawError = false;
    let sawTerminalTurn = false;
    let bindingMismatch = false;

    try {
      for await (const line of splitLfLines(child.stdout)) {
        if (line.trim().length === 0) continue;
        const parsedLine = parseJsonLine(line);
        if (!parsedLine.ok) {
          yield {
            type: "custom",
            name: "codex.jsonl.malformed",
            payload: { raw: parsedLine.raw },
          };
          continue;
        }

        for (const nativeEvent of parseCodexRecord(parsedLine.value)) {
          if (nativeEvent.type === "binding") {
            if (resumeThreadId !== undefined && nativeEvent.threadId !== resumeThreadId) {
              bindingMismatch = true;
              sawError = true;
              yield {
                type: "error",
                code: "codex_resume_binding_mismatch",
                message: "Codex resumed a different thread; the stored binding was preserved",
                recoverable: false,
                details: nativeEvent.raw,
              };
              active.termination ??= terminateProcess(child, this.clock, this.terminationTimings);
              continue;
            }

            this.threadId = nativeEvent.threadId;
            yield {
              type: "binding.updated",
              binding: bindingFor(
                nativeEvent.threadId,
                this.openInput.profile.id,
                this.codexHomeKey,
              ),
            };
            continue;
          }

          if (nativeEvent.type === "error") sawError = true;
          if (nativeEvent.type === "turn" && nativeEvent.state !== "running") {
            sawTerminalTurn = true;
          }
          const event = eventFromNormalized(nativeEvent);
          if (event !== undefined) yield event;
        }
      }

      const [exit, stderr, writeError] = await Promise.all([
        child.exited,
        stderrPromise,
        writePromise,
      ]);
      if (active.termination) await active.termination;

      if (active.interrupted) {
        if (!sawTerminalTurn) yield { type: "turn.state", state: "interrupted" };
        return;
      }

      if (bindingMismatch) {
        if (!sawTerminalTurn) yield { type: "turn.state", state: "failed" };
        return;
      }

      if (exit.error !== undefined) {
        if (!sawError) {
          yield {
            type: "error",
            code: "codex_spawn_failed",
            message: exit.error.message,
            recoverable: true,
          };
        }
        if (!sawTerminalTurn) yield { type: "turn.state", state: "failed" };
        return;
      }

      if (writeError !== undefined) {
        if (!sawError) {
          yield {
            type: "error",
            code: "codex_stdin_failed",
            message: writeError.message,
            recoverable: true,
          };
        }
        if (!sawTerminalTurn) yield { type: "turn.state", state: "failed" };
        return;
      }

      if (exit.code !== 0) {
        if (!sawError) {
          yield {
            type: "error",
            code: resumeThreadId === undefined ? "codex_process_failed" : "codex_resume_failed",
            message: trimOutput(stderr, "") ?? `Codex exited with code ${String(exit.code)}`,
            recoverable: true,
            details: { exitCode: exit.code, signal: exit.signal },
          };
        }
        if (!sawTerminalTurn) yield { type: "turn.state", state: "failed" };
        return;
      }

      if (!sawTerminalTurn) {
        yield {
          type: "error",
          code: "codex_protocol_incomplete",
          message: "Codex exited without a terminal turn event",
          recoverable: true,
        };
        yield { type: "turn.state", state: "failed" };
      }
    } finally {
      input.signal?.removeEventListener("abort", abort);
      if (child.getResult() === undefined) {
        active.interrupted = true;
        active.termination ??= terminateProcess(child, this.clock, this.terminationTimings);
      }
      if (active.termination) await active.termination;
      if (this.active === active) this.active = undefined;
    }
  }

  async interrupt(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    const active = this.active;
    if (active === undefined || active === "starting") return;
    active.interrupted = true;
    active.termination ??= terminateProcess(active.child, this.clock, this.terminationTimings);
    await active.termination;
  }

  async close(signal?: AbortSignal): Promise<void> {
    signal?.throwIfAborted();
    this.closed = true;
    await this.interrupt(signal);
  }
}

export function createCodexAdapter(options: CodexAdapterOptions = {}): HarnessAdapter {
  const launcher = options.launcher ?? nodeProcessLauncher;
  const clock = options.clock ?? systemClock;
  const baseEnvironment = options.baseEnvironment ?? process.env;
  const probeTimeoutMs = options.probeTimeoutMs ?? 5_000;
  const terminationTimings = options.terminationTimings ?? DEFAULT_TERMINATION_TIMINGS;

  return {
    manifest: MANIFEST,

    async probe(profile, signal): Promise<ProbeResult> {
      signal?.throwIfAborted();
      const config = parseCodexProfileConfig(profile);
      const environment = buildCodexEnvironment(profile, config, baseEnvironment);
      const timeoutSignal = AbortSignal.timeout(probeTimeoutMs);
      const boundedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

      const version = await runCapturedCommand(
        launcher,
        clock,
        terminationTimings,
        { command: config.command, args: ["--version"], env: environment },
        boundedSignal,
      );
      signal?.throwIfAborted();
      if (version.aborted) {
        return { status: "error", message: "Codex version probe timed out" };
      }
      if (version.exit.error !== undefined || version.exit.code !== 0) {
        return {
          status: "unavailable",
          message: processFailureMessage(version, "Codex executable is unavailable"),
        };
      }
      const versionLabel = trimOutput(version.stdout, version.stderr) ?? "unknown";

      const auth = await runCapturedCommand(
        launcher,
        clock,
        terminationTimings,
        { command: config.command, args: ["login", "status"], env: environment },
        boundedSignal,
      );
      signal?.throwIfAborted();
      if (auth.aborted) {
        return {
          status: "error",
          message: "Codex authentication probe timed out",
          version: versionLabel,
        };
      }
      if (auth.exit.error !== undefined) {
        return {
          status: "error",
          message: auth.exit.error.message,
          version: versionLabel,
        };
      }
      if (auth.exit.code !== 0) {
        return {
          status: "unauthenticated",
          message: processFailureMessage(auth, "Codex is not authenticated"),
          version: versionLabel,
        };
      }

      const authMessage = trimOutput(auth.stdout, auth.stderr);
      return {
        status: "ready",
        ...(authMessage === undefined ? {} : { message: authMessage }),
        version: versionLabel,
      };
    },

    open(input): HarnessSession {
      input.signal?.throwIfAborted();
      if (input.options !== undefined && Object.keys(input.options).length > 0) {
        throw new CodexAdapterError(
          "unsupported_options",
          "Codex adapter options must be configured with profile.extraArgs",
        );
      }

      const config = parseCodexProfileConfig(input.profile);
      const environment = buildCodexEnvironment(input.profile, config, baseEnvironment);
      const codexHomeKey = environment.CODEX_HOME ?? "<default>";
      const resumeThreadId = parseResumeBinding(input.resume, input.profile.id, codexHomeKey);
      const implementation = new CodexSession(
        input,
        config,
        environment,
        codexHomeKey,
        launcher,
        clock,
        terminationTimings,
        resumeThreadId,
      );
      const binding = implementation.initialBinding();
      return {
        ...(binding === undefined ? {} : { binding }),
        run: (runInput) => implementation.run(runInput),
        interrupt: (signal) => implementation.interrupt(signal),
        close: (signal) => implementation.close(signal),
      };
    },
  };
}

export const codexAdapter: HarnessAdapter = createCodexAdapter();
