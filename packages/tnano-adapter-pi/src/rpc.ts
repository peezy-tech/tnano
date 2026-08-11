import { PiRpcProtocolError, StrictLfJsonlDecoder, serializeJsonRecord } from "./jsonl.ts";
import type { PiChildProcess } from "./process.ts";

export type PiJsonObject = Record<string, unknown>;

interface PendingRequest {
  readonly command: string;
  readonly resolve: (response: PiRpcResponse) => void;
  readonly reject: (error: Error) => void;
}

export interface PiRpcResponse extends PiJsonObject {
  readonly id?: string;
  readonly type: "response";
  readonly command: string;
  readonly success: boolean;
  readonly data?: unknown;
  readonly error?: string;
}

export interface PiRpcClientOptions {
  readonly onEvent: (event: PiJsonObject) => void;
  readonly onProtocolError: (error: Error) => void;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export class PiRpcClient {
  readonly #child: PiChildProcess;
  readonly #decoder = new StrictLfJsonlDecoder();
  readonly #pending = new Map<string, PendingRequest>();
  readonly #options: PiRpcClientOptions;
  readonly #dispose: Array<() => void> = [];
  #nextRequestId = 1;
  #mutationTail: Promise<void> = Promise.resolve();
  #writeTail: Promise<void> = Promise.resolve();
  #closed = false;
  #stdoutEnded = false;
  #exitResult: { readonly code: number | null; readonly signal: NodeJS.Signals | null } | undefined;

  constructor(child: PiChildProcess, options: PiRpcClientOptions) {
    this.#child = child;
    this.#options = options;
    this.#dispose.push(
      child.onStdout((chunk) => this.#acceptStdout(chunk)),
      child.onStdoutEnd(() => this.#finishStdout()),
      child.onStderr((chunk) => options.onStderr?.(Buffer.from(chunk).toString("utf8"))),
      child.onError((error) => this.#fail(error)),
      child.onExit((code, signal) => {
        this.#exitResult = { code, signal };
        this.#reportExitAfterDrain();
      }),
    );
  }

  request(command: PiJsonObject, mutate = false): Promise<PiRpcResponse> {
    if (!mutate) return this.#request(command);
    return this.#serializeMutation(() => this.#request(command));
  }

  notify(command: PiJsonObject, mutate = false): Promise<void> {
    const write = () => this.#write(command);
    return mutate ? this.#serializeMutation(write) : write();
  }

  dispose(reason = new Error("Pi RPC client closed")): void {
    if (this.#closed) return;
    this.#closed = true;
    for (const cleanup of this.#dispose.splice(0)) cleanup();
    for (const pending of this.#pending.values()) pending.reject(reason);
    this.#pending.clear();
  }

  #request(command: PiJsonObject): Promise<PiRpcResponse> {
    if (this.#closed) return Promise.reject(new Error("Pi RPC client is closed"));
    if (typeof command.type !== "string" || command.type.length === 0) {
      return Promise.reject(new PiRpcProtocolError("Pi RPC command requires a type"));
    }
    const id = `tnano-${this.#nextRequestId++}`;
    return new Promise<PiRpcResponse>((resolve, reject) => {
      this.#pending.set(id, { command: command.type as string, resolve, reject });
      void this.#write({ ...command, id }).catch((error: unknown) => {
        this.#pending.delete(id);
        reject(toError(error));
      });
    });
  }

  async #write(command: PiJsonObject): Promise<void> {
    if (this.#closed) throw new Error("Pi RPC client is closed");
    const serialized = serializeJsonRecord(command);
    const result = this.#writeTail.then(() => this.#child.write(serialized));
    this.#writeTail = result.then(
      () => undefined,
      () => undefined,
    );
    await result;
  }

  #serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutationTail.then(operation);
    this.#mutationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  #acceptStdout(chunk: Uint8Array): void {
    if (this.#closed) return;
    try {
      for (const record of this.#decoder.push(chunk)) this.#acceptRecord(record);
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  #acceptRecord(record: unknown): void {
    if (!isJsonObject(record)) {
      throw new PiRpcProtocolError("Pi RPC record must be a JSON object");
    }
    if (record.type !== "response") {
      this.#options.onEvent(record);
      return;
    }
    if (typeof record.id !== "string") {
      this.#options.onEvent(record);
      return;
    }
    const pending = this.#pending.get(record.id);
    if (pending === undefined) {
      this.#options.onEvent(record);
      return;
    }
    this.#pending.delete(record.id);
    if (
      typeof record.command !== "string" ||
      typeof record.success !== "boolean" ||
      record.command !== pending.command
    ) {
      pending.reject(new PiRpcProtocolError(`Invalid response for ${pending.command}`));
      return;
    }
    const response = record as PiRpcResponse;
    if (!response.success) {
      pending.reject(new PiRpcCommandError(response.command, response.error));
      return;
    }
    pending.resolve(response);
  }

  #finishStdout(): void {
    if (this.#closed) return;
    this.#stdoutEnded = true;
    try {
      for (const record of this.#decoder.finish()) this.#acceptRecord(record);
    } catch (error) {
      this.#fail(toError(error));
      return;
    }
    this.#reportExitAfterDrain();
  }

  #reportExitAfterDrain(): void {
    if (!this.#stdoutEnded || this.#exitResult === undefined || this.#closed) return;
    const { code, signal } = this.#exitResult;
    this.#options.onExit?.(code, signal);
    this.#fail(new Error(`Pi RPC process exited (code=${String(code)}, signal=${String(signal)})`));
  }

  #fail(error: Error): void {
    if (this.#closed) return;
    this.#options.onProtocolError(error);
    this.dispose(error);
  }
}

export class PiRpcCommandError extends Error {
  override readonly name = "PiRpcCommandError";
  readonly command: string;

  constructor(command: string, message?: string) {
    super(message === undefined ? `Pi RPC command ${command} failed` : message);
    this.command = command;
  }
}

export function isJsonObject(value: unknown): value is PiJsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value));
}
