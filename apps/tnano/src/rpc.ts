import type * as NodeStream from "node:stream";

import { CliError, EXIT_CODES, asCliError, errorRecord } from "./errors.ts";
import type { RuntimePort } from "./runtimePort.ts";
import {
  parseJsonRecord,
  splitLfDelimited,
  writeJsonLine,
  type WritableText,
} from "./strictJsonl.ts";
import { VERSION } from "./version.ts";

export const RPC_METHOD_NAMES = [
  "initialize",
  "harness.list",
  "profile.list",
  "profile.probe",
  "session.list",
  "session.start",
  "session.send",
  "session.interrupt",
  "session.stop",
  "session.respond",
  "shutdown",
] as const;

export type RpcMethod = (typeof RPC_METHOD_NAMES)[number];
type RpcId = number | string;

interface RpcRequest {
  id: RpcId | undefined;
  method: string;
  params: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requestFrom(value: unknown): RpcRequest {
  if (!isRecord(value) || typeof value.method !== "string") {
    throw new CliError(
      "protocol_error",
      "RPC request must be an object with a string method",
      EXIT_CODES.protocol,
    );
  }
  if (value.id !== undefined && typeof value.id !== "string" && typeof value.id !== "number") {
    throw new CliError("protocol_error", "RPC id must be a string or number", EXIT_CODES.protocol);
  }
  if (value.params !== undefined && !isRecord(value.params)) {
    throw new CliError("protocol_error", "RPC params must be an object", EXIT_CODES.protocol);
  }
  return {
    id: value.id,
    method: value.method,
    params: value.params ?? {},
  };
}

function requiredString(params: Record<string, unknown>, name: string): string {
  const value = params[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(
      "invalid_arguments",
      `RPC parameter ${JSON.stringify(name)} must be a non-empty string`,
      EXIT_CODES.usage,
    );
  }
  return value;
}

function optionalString(params: Record<string, unknown>, name: string): string | undefined {
  const value = params[name];
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(
      "invalid_arguments",
      `RPC parameter ${JSON.stringify(name)} must be a non-empty string`,
      EXIT_CODES.usage,
    );
  }
  return value;
}

function isRpcMethod(value: string): value is RpcMethod {
  return RPC_METHOD_NAMES.some((method) => method === value);
}

async function dispatch(runtime: RuntimePort, method: RpcMethod, params: Record<string, unknown>) {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: 1,
        server: { name: "t-nano", version: VERSION },
        methods: RPC_METHOD_NAMES,
      };
    case "harness.list":
      return runtime.listHarnesses();
    case "profile.list":
      return runtime.listProfiles();
    case "profile.probe":
      return runtime.probeProfile(requiredString(params, "profileId"));
    case "session.list":
      return runtime.listSessions();
    case "session.start": {
      const model = optionalString(params, "model");
      const sessionId = optionalString(params, "sessionId");
      const resumeSessionId = optionalString(params, "resumeSessionId");
      if (resumeSessionId !== undefined) {
        return runtime.startSession({
          profileId: "",
          cwd: "",
          resumeSessionId,
        });
      }
      return runtime.startSession({
        profileId: requiredString(params, "profileId"),
        cwd: requiredString(params, "cwd"),
        ...(sessionId === undefined ? {} : { sessionId }),
        ...(model === undefined ? {} : { model }),
      });
    }
    case "session.send":
      return runtime.send({
        sessionId: requiredString(params, "sessionId"),
        prompt: requiredString(params, "prompt"),
      });
    case "session.interrupt":
      await runtime.interrupt(requiredString(params, "sessionId"));
      return { ok: true };
    case "session.stop":
      await runtime.stop(requiredString(params, "sessionId"));
      return { ok: true };
    case "session.respond":
      await runtime.respond(
        requiredString(params, "sessionId"),
        requiredString(params, "requestId"),
        params.response,
      );
      return { ok: true };
    case "shutdown":
      return { ok: true };
  }
}

export interface RpcIo {
  input: NodeStream.Readable;
  output: WritableText;
  error: WritableText;
}

export async function runRpc(runtime: RuntimePort, io: RpcIo): Promise<number> {
  let initialized = false;
  let shutdown = false;
  const pending = new Set<Promise<void>>();
  const activeSends = new Map<string, Promise<void>>();

  const unsubscribe = runtime.subscribe((event) => {
    if (!initialized || shutdown) return;
    writeJsonLine(io.output, {
      jsonrpc: "2.0",
      method: "event",
      params: event,
    });
  });

  const handle = async (request: RpcRequest): Promise<void> => {
    try {
      if (!isRpcMethod(request.method)) {
        throw new CliError(
          "unsupported_capability",
          `Unknown RPC method: ${request.method}`,
          EXIT_CODES.unsupported,
        );
      }
      if (!initialized && request.method !== "initialize" && request.method !== "shutdown") {
        throw new CliError("conflict", "RPC initialize must be called first", EXIT_CODES.protocol);
      }

      const result = await dispatch(runtime, request.method, request.params);
      if (request.method === "initialize") initialized = true;
      if (request.id !== undefined) {
        writeJsonLine(io.output, {
          jsonrpc: "2.0",
          id: request.id,
          result,
        });
      }
    } catch (error) {
      if (request.id !== undefined) {
        writeJsonLine(io.output, {
          jsonrpc: "2.0",
          id: request.id,
          error: errorRecord(error),
        });
      } else {
        const normalized = asCliError(error);
        io.error.write(`t-nano rpc: ${normalized.message}\n`);
      }
    }
  };

  const schedule = (request: RpcRequest): void => {
    const task = handle(request);
    pending.add(task);
    void task.finally(() => pending.delete(task));
  };

  const startSend = (request: RpcRequest): void => {
    try {
      if (!initialized) {
        throw new CliError("conflict", "RPC initialize must be called first", EXIT_CODES.protocol);
      }
      const sessionId = requiredString(request.params, "sessionId");
      const prompt = requiredString(request.params, "prompt");
      if (activeSends.has(sessionId)) {
        throw new CliError(
          "conflict",
          `Session already has an active send: ${sessionId}`,
          EXIT_CODES.configuration,
        );
      }

      const task = runtime
        .send({ sessionId, prompt })
        .then(() => undefined)
        .catch((error: unknown) => {
          writeJsonLine(io.output, {
            jsonrpc: "2.0",
            method: "event",
            params: {
              kind: "error",
              sessionId,
              data: errorRecord(error),
            },
          });
        })
        .finally(() => activeSends.delete(sessionId));
      activeSends.set(sessionId, task);

      if (request.id !== undefined) {
        writeJsonLine(io.output, {
          jsonrpc: "2.0",
          id: request.id,
          result: { accepted: true, sessionId },
        });
      }
    } catch (error) {
      if (request.id !== undefined) {
        writeJsonLine(io.output, {
          jsonrpc: "2.0",
          id: request.id,
          error: errorRecord(error),
        });
      } else {
        const normalized = asCliError(error);
        io.error.write(`t-nano rpc: ${normalized.message}\n`);
      }
    }
  };

  try {
    for await (const line of splitLfDelimited(io.input)) {
      let request: RpcRequest;
      try {
        request = requestFrom(parseJsonRecord(line));
      } catch (error) {
        writeJsonLine(io.output, {
          jsonrpc: "2.0",
          id: null,
          error: errorRecord(error),
        });
        continue;
      }

      if (request.method === "shutdown") {
        await Promise.allSettled(pending);
        await runtime.shutdown();
        await Promise.allSettled(activeSends.values());
        await handle(request);
        shutdown = true;
        break;
      }

      if (request.method === "session.send") {
        startSend(request);
      } else if (
        request.method === "session.respond" ||
        request.method === "session.interrupt" ||
        request.method === "session.stop"
      ) {
        schedule(request);
      } else {
        await handle(request);
      }
    }
    if (!shutdown) {
      await Promise.allSettled(pending);
      if (activeSends.size > 0) await runtime.shutdown();
      await Promise.allSettled(activeSends.values());
    }
    return EXIT_CODES.success;
  } catch (error) {
    const normalized = asCliError(error);
    writeJsonLine(io.output, {
      jsonrpc: "2.0",
      id: null,
      error: errorRecord(normalized),
    });
    return normalized.exitCode;
  } finally {
    unsubscribe();
  }
}
