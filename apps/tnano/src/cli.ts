import type { CliArguments } from "./args.ts";
import { HELP_TEXT, parseArguments } from "./args.ts";
import { executeTopLevelCommand, hasTopLevelCommand } from "./commands.ts";
import { CliError, EXIT_CODES, asCliError, errorRecord } from "./errors.ts";
import { runInteractive } from "./interactive.ts";
import type { CliIo } from "./io.ts";
import { writeLine } from "./io.ts";
import { runOneShot } from "./oneShot.ts";
import { runRpc } from "./rpc.ts";
import type { RuntimePort } from "./runtimePort.ts";
import { VERSION } from "./version.ts";

export interface RuntimeFactoryOptions {
  home?: string;
  adapters?: readonly string[];
}

export type RuntimeFactory = (options: RuntimeFactoryOptions) => Promise<RuntimePort> | RuntimePort;

function writeFailure(args: CliArguments | undefined, io: CliIo, error: unknown): number {
  const normalized = asCliError(error);
  if (args?.mode === "json") {
    writeLine(io.output, JSON.stringify({ ok: false, error: errorRecord(normalized) }));
  } else if (args?.mode === "rpc") {
    writeLine(
      io.output,
      JSON.stringify({ jsonrpc: "2.0", id: null, error: errorRecord(normalized) }),
    );
  } else {
    writeLine(io.error, `t-nano: ${normalized.message}`);
  }
  return normalized.exitCode;
}

export async function runCli(
  argv: readonly string[],
  io: CliIo,
  createRuntime: RuntimeFactory,
): Promise<number> {
  let args: CliArguments;
  try {
    args = parseArguments(argv);
  } catch (error) {
    return writeFailure(undefined, io, error);
  }

  if (args.help) {
    io.output.write(HELP_TEXT);
    return EXIT_CODES.success;
  }
  if (args.version) {
    writeLine(io.output, VERSION);
    return EXIT_CODES.success;
  }

  let runtime: RuntimePort | undefined;
  try {
    runtime = await createRuntime({
      ...(args.home === undefined ? {} : { home: args.home }),
      ...(args.adapters === undefined ? {} : { adapters: args.adapters }),
    });
    await runtime.initialize();

    if (args.mode === "rpc") {
      if (args.positionals.length > 0) {
        throw new CliError(
          "invalid_arguments",
          "RPC mode does not accept positional arguments",
          EXIT_CODES.usage,
        );
      }
      return await runRpc(runtime, io);
    }

    if (hasTopLevelCommand(args)) {
      await executeTopLevelCommand(runtime, args, {
        output: io.output,
        json: args.mode === "json",
      });
      return EXIT_CODES.success;
    }

    if (args.mode === "print" || args.mode === "json") {
      await runOneShot(runtime, args, io, args.mode === "json");
      return EXIT_CODES.success;
    }

    await runInteractive(runtime, args, io);
    return EXIT_CODES.success;
  } catch (error) {
    return writeFailure(args, io, error);
  } finally {
    if (runtime !== undefined) {
      try {
        await runtime.shutdown();
      } catch (error) {
        writeLine(
          io.error,
          `t-nano: shutdown failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
}
