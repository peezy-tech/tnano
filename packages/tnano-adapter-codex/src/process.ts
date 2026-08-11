// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - This package intentionally supervises native harness subprocesses with Node primitives.
import * as NodeChildProcess from "node:child_process";

export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly error?: Error;
}

export interface SpawnedProcess {
  readonly stdout: AsyncIterable<Uint8Array | string>;
  readonly stderr: AsyncIterable<Uint8Array | string>;
  readonly exited: Promise<ProcessExit>;
  getResult(): ProcessExit | undefined;
  writeAndCloseStdin(input: string): Promise<void>;
  signal(signal: NodeJS.Signals): boolean;
}

export interface LaunchProcessInput {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface ProcessLauncher {
  launch(input: LaunchProcessInput): SpawnedProcess;
}

export type TimeoutResult<T> =
  | { readonly timedOut: false; readonly value: T }
  | { readonly timedOut: true };

export interface Clock {
  withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>>;
}

export const systemClock: Clock = {
  withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<TimeoutResult<T>> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => resolve({ timedOut: true }), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timeout);
          resolve({ timedOut: false, value });
        },
        () => {
          clearTimeout(timeout);
          resolve({ timedOut: true });
        },
      );
    });
  },
};

export const nodeProcessLauncher: ProcessLauncher = {
  launch(input): SpawnedProcess {
    const child = NodeChildProcess.spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let result: ProcessExit | undefined;
    const exited = new Promise<ProcessExit>((resolve) => {
      const settle = (next: ProcessExit) => {
        if (result !== undefined) return;
        result = next;
        resolve(next);
      };

      child.once("error", (error) => settle({ code: null, signal: null, error }));
      child.once("exit", (code, signal) => settle({ code, signal }));
    });

    const writeAndCloseStdin = (contents: string): Promise<void> =>
      new Promise((resolve, reject) => {
        let settled = false;
        const settle = (error?: Error) => {
          if (settled) return;
          settled = true;
          if (error) reject(error);
          else resolve();
        };

        // Keep the listener installed after the write callback. A subprocess can
        // close stdin immediately after accepting input, and an unhandled EPIPE
        // must not terminate T-Nano.
        child.stdin.on("error", (error) => settle(error));
        child.stdin.end(contents, () => settle());
      });

    return {
      stdout: child.stdout,
      stderr: child.stderr,
      exited,
      getResult: () => result,
      writeAndCloseStdin,
      signal: (signal) => child.kill(signal),
    };
  },
};

export interface TerminationTimings {
  readonly interruptMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
}

export const DEFAULT_TERMINATION_TIMINGS: TerminationTimings = {
  interruptMs: 750,
  terminateMs: 750,
  killMs: 750,
};

async function signalAndWait(
  process: SpawnedProcess,
  signal: NodeJS.Signals,
  timeoutMs: number,
  clock: Clock,
): Promise<boolean> {
  if (process.getResult() !== undefined) return true;
  process.signal(signal);
  const result = await clock.withTimeout(process.exited, timeoutMs);
  return !result.timedOut;
}

/** Stops exactly the captured child: SIGINT, then bounded TERM/KILL escalation. */
export async function terminateProcess(
  process: SpawnedProcess,
  clock: Clock,
  timings: TerminationTimings = DEFAULT_TERMINATION_TIMINGS,
): Promise<void> {
  if (await signalAndWait(process, "SIGINT", timings.interruptMs, clock)) return;
  if (await signalAndWait(process, "SIGTERM", timings.terminateMs, clock)) return;
  await signalAndWait(process, "SIGKILL", timings.killMs, clock);
}

export async function collectText(
  stream: AsyncIterable<Uint8Array | string>,
  limit = 64 * 1024,
): Promise<string> {
  const decoder = new TextDecoder();
  let output = "";
  let truncated = false;

  for await (const chunk of stream) {
    const text = typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const remaining = limit - output.length;
    if (remaining <= 0) {
      truncated = true;
      continue;
    }
    output += text.slice(0, remaining);
    if (text.length > remaining) truncated = true;
  }

  const tail = decoder.decode();
  if (tail.length > 0 && output.length < limit) {
    output += tail.slice(0, limit - output.length);
    if (output.length + tail.length > limit) truncated = true;
  }

  return truncated ? `${output}\n[truncated]` : output;
}

export async function* splitLfLines(
  stream: AsyncIterable<Uint8Array | string>,
): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of stream) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline);
      yield line.endsWith("\r") ? line.slice(0, -1) : line;
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    yield buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer;
  }
}
