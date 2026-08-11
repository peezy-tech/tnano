import { CliError, EXIT_CODES } from "./errors.ts";
import { trustedAdapterSpecifierIssue } from "./adapterSpecifier.ts";
import { isCliMode, type CliMode } from "./modes.ts";

const VALUE_OPTIONS = new Set([
  "mode",
  "profile",
  "model",
  "cwd",
  "home",
  "harness",
  "label",
  "config-json",
  "adapter",
]);

const BOOLEAN_OPTIONS = new Set(["help", "version"]);

export interface CliArguments {
  mode?: CliMode;
  profile?: string;
  model?: string;
  cwd?: string;
  home?: string;
  harness?: string;
  label?: string;
  configJson?: string;
  adapters?: string[];
  help: boolean;
  version: boolean;
  positionals: string[];
}

function invalid(message: string): never {
  throw new CliError("invalid_arguments", message, EXIT_CODES.usage);
}

function readOption(
  argv: readonly string[],
  index: number,
): { name: string; value: string | true; consumed: number } {
  const token = argv[index];
  if (token === undefined) return invalid("Missing option");

  if (token === "-h") return { name: "help", value: true, consumed: 1 };
  if (token === "-v") return { name: "version", value: true, consumed: 1 };
  if (!token.startsWith("--")) return invalid(`Invalid option: ${token}`);

  const equals = token.indexOf("=");
  const name = token.slice(2, equals < 0 ? undefined : equals);
  if (BOOLEAN_OPTIONS.has(name)) {
    if (equals >= 0) return invalid(`--${name} does not take a value`);
    return { name, value: true, consumed: 1 };
  }
  if (!VALUE_OPTIONS.has(name)) return invalid(`Unknown option: --${name}`);

  if (equals >= 0) {
    const value = token.slice(equals + 1);
    if (value.length === 0) return invalid(`--${name} requires a value`);
    return { name, value, consumed: 1 };
  }

  const value = argv[index + 1];
  if (value === undefined || value.startsWith("--")) {
    return invalid(`--${name} requires a value`);
  }
  return { name, value, consumed: 2 };
}

export function parseArguments(argv: readonly string[]): CliArguments {
  const values: Record<string, string | true> = {};
  const adapters: string[] = [];
  const positionals: string[] = [];
  let positionalOnly = false;

  for (let index = 0; index < argv.length; ) {
    const token = argv[index];
    if (token === undefined) break;

    if (!positionalOnly && token === "--") {
      positionalOnly = true;
      index += 1;
      continue;
    }
    if (!positionalOnly && token.startsWith("-")) {
      const parsed = readOption(argv, index);
      if (parsed.name === "adapter") {
        const specifier = parsed.value;
        if (typeof specifier !== "string") return invalid("--adapter requires a value");
        const issue = trustedAdapterSpecifierIssue(specifier);
        if (issue !== undefined) invalid(issue);
        adapters.push(specifier);
        index += parsed.consumed;
        continue;
      }
      if (values[parsed.name] !== undefined) {
        invalid(`Option may only be provided once: --${parsed.name}`);
      }
      values[parsed.name] = parsed.value;
      index += parsed.consumed;
      continue;
    }

    positionals.push(token);
    index += 1;
  }

  const modeValue = values.mode;
  if (typeof modeValue === "string" && !isCliMode(modeValue)) {
    invalid(`Invalid mode ${JSON.stringify(modeValue)}; expected interactive, print, json, or rpc`);
  }

  const result: CliArguments = {
    help: values.help === true,
    version: values.version === true,
    positionals,
  };
  if (typeof modeValue === "string") result.mode = modeValue;
  if (typeof values.profile === "string") result.profile = values.profile;
  if (typeof values.model === "string") result.model = values.model;
  if (typeof values.cwd === "string") result.cwd = values.cwd;
  if (typeof values.home === "string") result.home = values.home;
  if (typeof values.harness === "string") result.harness = values.harness;
  if (typeof values.label === "string") result.label = values.label;
  if (typeof values["config-json"] === "string") result.configJson = values["config-json"];
  if (adapters.length > 0) result.adapters = adapters;
  return result;
}

export const HELP_TEXT = `Usage: t-nano [options] [prompt]
       t-nano harnesses
       t-nano harness inspect <id>
       t-nano profiles
       t-nano profile add <id> --harness <id> [--label <text>] [--config-json <json>]
       t-nano profile remove <id>
       t-nano sessions
       t-nano doctor [profile]

Modes:
  interactive  Line-oriented terminal session (default)
  print        Run one prompt and print only final text
  json         Run one prompt and print one final JSON value
  rpc          Strict LF-delimited JSON RPC over stdin/stdout

Options:
  --mode <mode>       interactive, print, json, or rpc
  --profile <id>      Select a named harness profile
  --model <id>        Select an adapter model
  --cwd <path>        Working directory for a new session
  --home <path>       T-Nano data directory
  --adapter <module>  Load a trusted adapter package, absolute path, or file URL (repeatable)
  --help, -h          Show this help
  --version, -v       Show the version
`;
