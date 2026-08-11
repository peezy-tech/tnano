import type { JsonValue } from "./types.ts";

export type TNanoErrorCode =
  | "INVALID_ARGUMENT"
  | "NOT_INITIALIZED"
  | "ADAPTER_NOT_FOUND"
  | "ADAPTER_ALREADY_REGISTERED"
  | "INVALID_ADAPTER"
  | "PROFILE_NOT_FOUND"
  | "PROFILE_DISABLED"
  | "PROFILE_IN_USE"
  | "SESSION_NOT_FOUND"
  | "SESSION_ALREADY_EXISTS"
  | "SESSION_ACTIVE"
  | "SESSION_CLOSED"
  | "TURN_ACTIVE"
  | "UNSUPPORTED_OPERATION"
  | "ABORTED"
  | "ADAPTER_ERROR"
  | "STORAGE_ERROR"
  | "INVALID_STATE";

export interface TNanoErrorOptions {
  readonly details?: JsonValue;
  readonly cause?: unknown;
}

export class TNanoError extends Error {
  readonly code: TNanoErrorCode;
  readonly details?: JsonValue;

  constructor(code: TNanoErrorCode, message: string, options: TNanoErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TNanoError";
    this.code = code;
    if (options.details !== undefined) {
      this.details = options.details;
    }
  }

  toJSON(): {
    readonly code: TNanoErrorCode;
    readonly message: string;
    readonly details?: JsonValue;
  } {
    if (this.details === undefined) {
      return { code: this.code, message: this.message };
    }
    return { code: this.code, message: this.message, details: this.details };
  }

  static from(
    error: unknown,
    code: TNanoErrorCode,
    message: string,
    details?: JsonValue,
  ): TNanoError {
    if (error instanceof TNanoError) {
      return error;
    }
    if (isAbortError(error)) {
      return new TNanoError("ABORTED", "Operation aborted", { cause: error });
    }
    return new TNanoError(
      code,
      message,
      details === undefined ? { cause: error } : { cause: error, details },
    );
  }
}

export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof Error && error.name === "AbortError") ||
    (typeof DOMException !== "undefined" &&
      error instanceof DOMException &&
      error.name === "AbortError")
  );
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) {
    throw new TNanoError("ABORTED", "Operation aborted", {
      cause: signal.reason,
    });
  }
}
