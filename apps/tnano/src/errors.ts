export const EXIT_CODES = {
  success: 0,
  general: 1,
  usage: 2,
  configuration: 3,
  authentication: 4,
  unsupported: 5,
  interrupted: 6,
  timeout: 7,
  harnessCrashed: 8,
  protocol: 9,
} as const;

export type ExitCode = (typeof EXIT_CODES)[keyof typeof EXIT_CODES];

export type ErrorCode =
  | "internal_error"
  | "invalid_arguments"
  | "invalid_configuration"
  | "authentication_required"
  | "unsupported_capability"
  | "interrupted"
  | "timeout"
  | "harness_crashed"
  | "protocol_error"
  | "not_found"
  | "conflict";

export class CliError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: ExitCode;
  readonly details: unknown;

  constructor(
    code: ErrorCode,
    message: string,
    exitCode: ExitCode = EXIT_CODES.general,
    details?: unknown,
  ) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export function asCliError(error: unknown): CliError {
  if (error instanceof CliError) return error;

  if (error instanceof Error) {
    const candidate = error as Error & { code?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "";
    if (
      code === "authentication_required" ||
      code === "unauthenticated" ||
      code === "AUTHENTICATION_REQUIRED"
    ) {
      return new CliError("authentication_required", error.message, EXIT_CODES.authentication);
    }
    if (
      code === "unsupported_capability" ||
      code === "unsupported" ||
      code === "UNSUPPORTED_OPERATION"
    ) {
      return new CliError("unsupported_capability", error.message, EXIT_CODES.unsupported);
    }
    if (code === "interrupted" || code === "ABORTED" || error.name === "AbortError") {
      return new CliError("interrupted", error.message || "Interrupted", EXIT_CODES.interrupted);
    }
    if (code === "timeout") {
      return new CliError("timeout", error.message, EXIT_CODES.timeout);
    }
    if (code === "harness_crashed") {
      return new CliError("harness_crashed", error.message, EXIT_CODES.harnessCrashed);
    }
    if (
      code === "not_found" ||
      code === "ADAPTER_NOT_FOUND" ||
      code === "PROFILE_NOT_FOUND" ||
      code === "SESSION_NOT_FOUND"
    ) {
      return new CliError("not_found", error.message, EXIT_CODES.configuration);
    }
    if (
      code === "conflict" ||
      code === "PROFILE_IN_USE" ||
      code === "SESSION_ALREADY_EXISTS" ||
      code === "SESSION_ACTIVE" ||
      code === "TURN_ACTIVE"
    ) {
      return new CliError("conflict", error.message, EXIT_CODES.configuration);
    }
    if (
      code === "INVALID_ARGUMENT" ||
      code === "INVALID_ADAPTER" ||
      code === "PROFILE_DISABLED" ||
      code === "NOT_INITIALIZED" ||
      code === "INVALID_STATE" ||
      code === "STORAGE_ERROR"
    ) {
      return new CliError("invalid_configuration", error.message, EXIT_CODES.configuration);
    }
    if (code === "ADAPTER_ERROR") {
      return new CliError("harness_crashed", error.message, EXIT_CODES.harnessCrashed);
    }
    return new CliError("internal_error", error.message, EXIT_CODES.general);
  }

  return new CliError("internal_error", String(error), EXIT_CODES.general);
}

export function errorRecord(error: unknown): {
  code: ErrorCode;
  message: string;
  details?: unknown;
} {
  const normalized = asCliError(error);
  if (normalized.details === undefined) {
    return { code: normalized.code, message: normalized.message };
  }
  return {
    code: normalized.code,
    message: normalized.message,
    details: normalized.details,
  };
}
