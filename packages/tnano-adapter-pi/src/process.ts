// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Harness adapters intentionally supervise native processes with Node primitives.
import * as NodeChildProcess from "node:child_process";

export interface PiProcessEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly signal?: AbortSignal;
}

export interface PiCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface PiChildProcess {
  readonly pid: number | undefined;
  write(data: string): Promise<void>;
  endStdin(): void;
  onStdout(listener: (chunk: Uint8Array) => void): () => void;
  onStdoutEnd(listener: () => void): () => void;
  onStderr(listener: (chunk: Uint8Array) => void): () => void;
  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void;
  onClose(listener: () => void): () => void;
  onError(listener: (error: Error) => void): () => void;
  waitForExit(timeoutMs: number): Promise<boolean>;
  kill(signal: NodeJS.Signals): void;
}

export interface PiProcessLauncher {
  spawn(command: string, args: readonly string[], options: PiProcessEnvironment): PiChildProcess;
}

export const nodePiProcessLauncher: PiProcessLauncher = {
  spawn(command, args, options) {
    return new NodePiChildProcess(launch(command, args, options));
  },
};

export interface PiTerminationTimings {
  readonly stdinCloseMs: number;
  readonly terminateMs: number;
  readonly killMs: number;
}

export interface PiDeadline {
  readonly signal: AbortSignal;
  dispose(): void;
}

export interface PiDeadlineFactory {
  create(timeoutMs: number, label: string): PiDeadline;
}

export class PiDeadlineExceededError extends Error {
  override readonly name = "PiDeadlineExceededError";
  readonly timeoutMs: number;

  constructor(label: string, timeoutMs: number) {
    super(`${label} timed out after ${timeoutMs}ms.`);
    this.timeoutMs = timeoutMs;
  }
}

export const systemPiDeadlineFactory: PiDeadlineFactory = {
  create(timeoutMs, label) {
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
      throw new RangeError("Pi deadline must be a positive safe integer");
    }
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new PiDeadlineExceededError(label, timeoutMs));
    }, timeoutMs);
    timeout.unref();
    return {
      signal: controller.signal,
      dispose() {
        clearTimeout(timeout);
      },
    };
  },
};

export const DEFAULT_PI_TERMINATION_TIMINGS: PiTerminationTimings = {
  stdinCloseMs: 750,
  terminateMs: 750,
  killMs: 750,
};

/** Escalates only the captured child and always returns within the supplied bounds. */
export async function terminatePiChild(
  child: PiChildProcess,
  timings: PiTerminationTimings = DEFAULT_PI_TERMINATION_TIMINGS,
): Promise<void> {
  child.kill("SIGTERM");
  if (await child.waitForExit(timings.terminateMs)) return;
  child.kill("SIGKILL");
  await child.waitForExit(timings.killMs);
}

/**
 * Captures a finite Pi command. Cancellation owns termination rather than
 * trusting the subprocess to honor SIGTERM.
 */
export function runCapturedPiChild(
  child: PiChildProcess,
  signal?: AbortSignal,
  timings: PiTerminationTimings = DEFAULT_PI_TERMINATION_TIMINGS,
): Promise<PiCommandResult> {
  signal?.throwIfAborted();
  const stdout: Uint8Array[] = [];
  const stderr: Uint8Array[] = [];
  let exitCode: number | null = null;
  let exitSignal: NodeJS.Signals | null = null;

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelling = false;
    const cleanup: Array<() => void> = [];
    const finish = (result: PiCommandResult | Error, failed: boolean) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", onAbort);
      for (const dispose of cleanup.splice(0)) dispose();
      if (failed) reject(result);
      else resolve(result as PiCommandResult);
    };
    const onAbort = () => {
      if (settled || cancelling) return;
      cancelling = true;
      void terminatePiChild(child, timings).then(
        () => finish(abortError(signal), true),
        (error: unknown) => finish(toError(error), true),
      );
    };

    cleanup.push(
      child.onStdout((chunk) => stdout.push(chunk)),
      child.onStderr((chunk) => stderr.push(chunk)),
      child.onExit((code, processSignal) => {
        exitCode = code;
        exitSignal = processSignal;
      }),
      child.onClose(() => {
        if (cancelling) return;
        finish(
          {
            exitCode,
            signal: exitSignal,
            stdout: Buffer.concat(stdout).toString("utf8"),
            stderr: Buffer.concat(stderr).toString("utf8"),
          },
          false,
        );
      }),
      child.onError((error) => {
        if (!cancelling) finish(error, true);
      }),
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      child.endStdin();
    } catch (error) {
      finish(toError(error), true);
    }
    if (signal?.aborted) onAbort();
  });
}

function launch(
  command: string,
  args: readonly string[],
  options: PiProcessEnvironment,
): NodeChildProcess.ChildProcessWithoutNullStreams {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [name, value] of Object.entries(options.env)) {
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
  const spawnOptions: NodeChildProcess.SpawnOptionsWithoutStdio = {
    cwd: options.cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  };
  return NodeChildProcess.spawn(
    command,
    [...args],
    spawnOptions,
  ) as NodeChildProcess.ChildProcessWithoutNullStreams;
}

class NodePiChildProcess implements PiChildProcess {
  readonly #child: NodeChildProcess.ChildProcessWithoutNullStreams;
  readonly #exit: Promise<void>;
  readonly pid: number | undefined;

  constructor(child: NodeChildProcess.ChildProcessWithoutNullStreams) {
    this.#child = child;
    this.pid = child.pid;
    // `close` follows process exit only after stdio has been drained.
    this.#exit = new Promise((resolve) => child.once("close", () => resolve()));
  }

  write(data: string): Promise<void> {
    if (this.#child.stdin.destroyed || !this.#child.stdin.writable) {
      return Promise.reject(new Error("Pi RPC stdin is closed"));
    }
    return new Promise((resolve, reject) => {
      this.#child.stdin.write(data, (error) => (error ? reject(error) : resolve()));
    });
  }

  endStdin(): void {
    if (!this.#child.stdin.destroyed) this.#child.stdin.end();
  }

  onStdout(listener: (chunk: Uint8Array) => void): () => void {
    this.#child.stdout.on("data", listener);
    return () => this.#child.stdout.off("data", listener);
  }

  onStdoutEnd(listener: () => void): () => void {
    this.#child.stdout.on("end", listener);
    return () => this.#child.stdout.off("end", listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.#child.stderr.on("data", listener);
    return () => this.#child.stderr.off("data", listener);
  }

  onExit(listener: (code: number | null, signal: NodeJS.Signals | null) => void): () => void {
    this.#child.on("exit", listener);
    return () => this.#child.off("exit", listener);
  }

  onClose(listener: () => void): () => void {
    this.#child.on("close", listener);
    return () => this.#child.off("close", listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#child.on("error", listener);
    return () => this.#child.off("error", listener);
  }

  async waitForExit(timeoutMs: number): Promise<boolean> {
    let timeout: NodeJS.Timeout | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
      timeout.unref();
    });
    const exited = this.#exit.then(() => true);
    const result = await Promise.race([exited, timedOut]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  }

  kill(signal: NodeJS.Signals): void {
    if (this.#child.exitCode === null && this.#child.signalCode === null) {
      this.#child.kill(signal);
    }
  }
}

function abortError(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  const error = new Error("The Pi operation was aborted.");
  error.name = "AbortError";
  return error;
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
