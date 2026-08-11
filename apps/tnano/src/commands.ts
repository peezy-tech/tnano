import type * as NodeStream from "node:stream";

import type { CliArguments } from "./args.ts";
import { CliError, EXIT_CODES } from "./errors.ts";
import {
  printHarnesses,
  printJson,
  printPrettyJson,
  printProfiles,
  printSessions,
} from "./presentation.ts";
import type { RuntimePort } from "./runtimePort.ts";

const COMMANDS = new Set(["harnesses", "profiles", "profile", "sessions", "doctor"]);

export function hasTopLevelCommand(args: CliArguments): boolean {
  const first = args.positionals[0];
  return first !== undefined && COMMANDS.has(first);
}

function parseConfigJson(value: string | undefined): Record<string, unknown> {
  if (value === undefined) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch (error) {
    throw new CliError(
      "invalid_configuration",
      `--config-json is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      EXIT_CODES.configuration,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError(
      "invalid_configuration",
      "--config-json must contain a JSON object",
      EXIT_CODES.configuration,
    );
  }
  return parsed as Record<string, unknown>;
}

function expectNoExtra(positionals: readonly string[], expectedLength: number): void {
  if (positionals.length > expectedLength) {
    throw new CliError(
      "invalid_arguments",
      `Unexpected argument: ${positionals[expectedLength]}`,
      EXIT_CODES.usage,
    );
  }
}

export interface CommandOutput {
  output: NodeStream.Writable;
  json: boolean;
}

export async function executeTopLevelCommand(
  runtime: RuntimePort,
  args: CliArguments,
  target: CommandOutput,
): Promise<void> {
  const [command, operation, identifier] = args.positionals;

  switch (command) {
    case "harnesses": {
      expectNoExtra(args.positionals, 1);
      const harnesses = await runtime.listHarnesses();
      if (target.json) printJson(target.output, harnesses);
      else printHarnesses(target.output, harnesses);
      return;
    }
    case "profiles": {
      expectNoExtra(args.positionals, 1);
      const profiles = await runtime.listProfiles();
      if (target.json) printJson(target.output, profiles);
      else printProfiles(target.output, profiles);
      return;
    }
    case "sessions": {
      expectNoExtra(args.positionals, 1);
      const sessions = await runtime.listSessions();
      if (target.json) printJson(target.output, sessions);
      else printSessions(target.output, sessions);
      return;
    }
    case "doctor": {
      expectNoExtra(args.positionals, 2);
      const selected = operation ?? args.profile;
      const profiles = await runtime.listProfiles();
      const ids = selected === undefined ? profiles.map((profile) => profile.id) : [selected];
      const results = [];
      for (const id of ids) results.push(await runtime.probeProfile(id));
      const value = selected === undefined ? results : results[0];
      if (target.json) printJson(target.output, value);
      else printPrettyJson(target.output, value);
      return;
    }
    case "profile": {
      if (operation === "add") {
        expectNoExtra(args.positionals, 3);
        if (identifier === undefined) {
          throw new CliError("invalid_arguments", "profile add requires an id", EXIT_CODES.usage);
        }
        if (args.harness === undefined) {
          throw new CliError(
            "invalid_arguments",
            "profile add requires --harness",
            EXIT_CODES.usage,
          );
        }
        const existing = (await runtime.listProfiles()).find(
          (profile) => profile.id === identifier,
        );
        if (existing !== undefined) {
          throw new CliError(
            "conflict",
            `Profile already exists: ${identifier}`,
            EXIT_CODES.configuration,
          );
        }
        const result = await runtime.addProfile({
          id: identifier,
          harnessId: args.harness,
          ...(args.label === undefined ? {} : { label: args.label }),
          config: parseConfigJson(args.configJson),
        });
        if (target.json) printJson(target.output, result);
        else printPrettyJson(target.output, result);
        return;
      }
      if (operation === "remove") {
        expectNoExtra(args.positionals, 3);
        if (identifier === undefined) {
          throw new CliError(
            "invalid_arguments",
            "profile remove requires an id",
            EXIT_CODES.usage,
          );
        }
        await runtime.removeProfile(identifier);
        if (target.json) printJson(target.output, { removed: identifier });
        else target.output.write(`Removed profile ${identifier}.\n`);
        return;
      }
      throw new CliError("invalid_arguments", "profile requires add or remove", EXIT_CODES.usage);
    }
    default:
      throw new CliError(
        "invalid_arguments",
        `Unknown command: ${String(command)}`,
        EXIT_CODES.usage,
      );
  }
}
