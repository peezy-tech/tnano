// @effect-diagnostics nodeBuiltinImport:off - This package is the Node CLI boundary.
import * as NodePath from "node:path";

import type { CliArguments } from "./args.ts";
import { CliError, EXIT_CODES } from "./errors.ts";
import type { CliIo } from "./io.ts";
import { readAll, writeLine } from "./io.ts";
import { renderEvent } from "./presentation.ts";
import type { RuntimePort } from "./runtimePort.ts";
import { runTurn } from "./turn.ts";

async function promptFrom(args: CliArguments, io: CliIo): Promise<string> {
  if (args.positionals.length > 0) return args.positionals.join(" ");
  const prompt = await readAll(io.input);
  if (prompt.trim().length === 0) {
    throw new CliError("invalid_arguments", "No prompt provided", EXIT_CODES.usage);
  }
  return prompt;
}

export async function runOneShot(
  runtime: RuntimePort,
  args: CliArguments,
  io: CliIo,
  json: boolean,
): Promise<void> {
  if (args.profile === undefined) {
    throw new CliError(
      "invalid_arguments",
      "A prompt requires an explicit --profile",
      EXIT_CODES.usage,
    );
  }

  const prompt = await promptFrom(args, io);
  const session = await runtime.startSession({
    profileId: args.profile,
    cwd: NodePath.resolve(args.cwd ?? process.cwd()),
    ...(args.model === undefined ? {} : { model: args.model }),
  });
  const output = await runTurn(
    runtime,
    session.id,
    prompt,
    json
      ? {}
      : {
          onEvent: (event) => {
            if (event.kind !== "content.delta" && event.kind !== "error") {
              renderEvent(event, io.error, io.error);
            }
          },
        },
  );

  if (json) {
    writeLine(
      io.output,
      JSON.stringify({
        ok: true,
        sessionId: session.id,
        ...(output.result.turnId === undefined ? {} : { turnId: output.result.turnId }),
        text: output.text,
        events: output.events,
      }),
    );
    return;
  }

  io.output.write(output.text);
  if (!output.text.endsWith("\n")) io.output.write("\n");
}
