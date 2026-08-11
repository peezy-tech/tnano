import {
  PiDeadlineExceededError,
  type PiChildProcess,
  type PiDeadline,
  type PiDeadlineFactory,
  type PiProcessEnvironment,
  type PiProcessLauncher,
} from "./process.ts";

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;

export class FakePiChild implements PiChildProcess {
  readonly pid = 4242;
  readonly writes: string[] = [];
  readonly signals: NodeJS.Signals[] = [];
  readonly #stdout = new Set<(chunk: Uint8Array) => void>();
  readonly #stdoutEnd = new Set<() => void>();
  readonly #stderr = new Set<(chunk: Uint8Array) => void>();
  readonly #exit = new Set<ExitListener>();
  readonly #close = new Set<() => void>();
  readonly #error = new Set<(error: Error) => void>();
  waitResults: boolean[] = [true];
  stdinEnded = false;
  onWrite?: (record: Record<string, unknown>) => void | Promise<void>;
  onEndStdin?: () => void;

  async write(data: string): Promise<void> {
    this.writes.push(data);
    const parsed = JSON.parse(data.trimEnd()) as Record<string, unknown>;
    await this.onWrite?.(parsed);
  }

  endStdin(): void {
    this.stdinEnded = true;
    this.onEndStdin?.();
  }

  onStdout(listener: (chunk: Uint8Array) => void): () => void {
    this.#stdout.add(listener);
    return () => this.#stdout.delete(listener);
  }

  onStdoutEnd(listener: () => void): () => void {
    this.#stdoutEnd.add(listener);
    return () => this.#stdoutEnd.delete(listener);
  }

  onStderr(listener: (chunk: Uint8Array) => void): () => void {
    this.#stderr.add(listener);
    return () => this.#stderr.delete(listener);
  }

  onExit(listener: ExitListener): () => void {
    this.#exit.add(listener);
    return () => this.#exit.delete(listener);
  }

  onClose(listener: () => void): () => void {
    this.#close.add(listener);
    return () => this.#close.delete(listener);
  }

  onError(listener: (error: Error) => void): () => void {
    this.#error.add(listener);
    return () => this.#error.delete(listener);
  }

  waitForExit(_timeoutMs: number): Promise<boolean> {
    return Promise.resolve(this.waitResults.shift() ?? true);
  }

  kill(signal: NodeJS.Signals): void {
    this.signals.push(signal);
  }

  emit(record: unknown, terminated = true): void {
    this.emitText(`${JSON.stringify(record)}${terminated ? "\n" : ""}`);
  }

  emitText(text: string): void {
    const chunk = new TextEncoder().encode(text);
    for (const listener of this.#stdout) listener(chunk);
  }

  endStdout(): void {
    for (const listener of this.#stdoutEnd) listener();
  }

  exit(code: number | null, signal: NodeJS.Signals | null): void {
    for (const listener of this.#exit) listener(code, signal);
  }

  close(): void {
    for (const listener of this.#close) listener();
  }

  fail(error: Error): void {
    for (const listener of this.#error) listener(error);
  }
}

export class FakePiLauncher implements PiProcessLauncher {
  readonly child: FakePiChild;
  readonly spawnChildren: FakePiChild[] = [];
  readonly spawns: Array<{
    command: string;
    args: readonly string[];
    options: PiProcessEnvironment;
    child: FakePiChild;
  }> = [];

  constructor(child = new FakePiChild()) {
    this.child = child;
  }

  spawn(command: string, args: readonly string[], options: PiProcessEnvironment): PiChildProcess {
    const child = this.spawnChildren.shift() ?? this.child;
    this.spawns.push({ command, args, options, child });
    return child;
  }
}

interface FakePiDeadline {
  readonly timeoutMs: number;
  readonly label: string;
  readonly controller: AbortController;
  disposed: boolean;
}

export class FakePiDeadlineFactory implements PiDeadlineFactory {
  readonly created: FakePiDeadline[] = [];

  create(timeoutMs: number, label: string): PiDeadline {
    const entry: FakePiDeadline = {
      timeoutMs,
      label,
      controller: new AbortController(),
      disposed: false,
    };
    this.created.push(entry);
    return {
      signal: entry.controller.signal,
      dispose() {
        entry.disposed = true;
      },
    };
  }

  expire(index = this.created.length - 1): void {
    const entry = this.created[index];
    if (entry === undefined) throw new Error(`Unknown fake Pi deadline ${index}.`);
    entry.controller.abort(new PiDeadlineExceededError(entry.label, entry.timeoutMs));
  }
}

export function tick(): Promise<void> {
  return new Promise((resolve) => queueMicrotask(resolve));
}
