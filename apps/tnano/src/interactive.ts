// @effect-diagnostics nodeBuiltinImport:off - This package is the Node CLI boundary.
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { CliArguments } from "./args.ts";
import type { CliIo } from "./io.ts";
import { writeLine } from "./io.ts";
import { eventText, printProfiles, printSessions, renderEvent } from "./presentation.ts";
import type { RuntimePort, SessionSummary } from "./runtimePort.ts";
import { runTurn } from "./turn.ts";

const INTERACTIVE_HELP = `Commands:
  /profile [id]       Show or select a profile
  /model [id]         Show or select a model
  /sessions           List saved sessions
  /new [prompt]       Start a new session
  /resume <id>        Resume a saved session
  /respond <id> <v>   Answer a harness request with JSON or text
  /interrupt          Interrupt the active turn
  /doctor [profile]   Probe profile health
  /help               Show this help
  /exit               Exit T-Nano`;

interface InteractiveState {
  profileId: string | undefined;
  model: string | undefined;
  session: SessionSummary | undefined;
  running: boolean;
  activeTurn: Promise<void> | undefined;
}

function commandParts(line: string): { command: string; argument: string } {
  const whitespace = line.search(/\s/u);
  if (whitespace < 0) return { command: line, argument: "" };
  return {
    command: line.slice(0, whitespace),
    argument: line.slice(whitespace).trim(),
  };
}

async function ensureSession(
  runtime: RuntimePort,
  state: InteractiveState,
  cwd: string,
): Promise<SessionSummary | undefined> {
  if (state.session !== undefined) return state.session;
  if (state.profileId === undefined) return undefined;
  state.session = await runtime.startSession({
    profileId: state.profileId,
    cwd,
    ...(state.model === undefined ? {} : { model: state.model }),
  });
  return state.session;
}

async function launchPrompt(
  runtime: RuntimePort,
  state: InteractiveState,
  prompt: string,
  cwd: string,
  io: CliIo,
): Promise<void> {
  if (state.running) {
    writeLine(io.error, "A turn is already running; interrupt it before sending another prompt.");
    return;
  }

  state.running = true;
  try {
    const session = await ensureSession(runtime, state, cwd);
    if (session === undefined) {
      writeLine(io.error, "Select a profile with /profile <id> before sending a prompt.");
      state.running = false;
      return;
    }

    let streamedText = "";
    const turn = runTurn(runtime, session.id, prompt, {
      onEvent: (event) => {
        renderEvent(event, io.output, io.error);
        if (event.kind === "content.delta") streamedText += eventText(event) ?? "";
      },
    })
      .then((output) => {
        if (streamedText.length === 0 && output.text.length > 0) io.output.write(output.text);
        const finalText = streamedText.length > 0 ? streamedText : output.text;
        if (finalText.length > 0 && !finalText.endsWith("\n")) io.output.write("\n");
      })
      .catch((error: unknown) => {
        writeLine(io.error, error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        state.running = false;
        state.activeTurn = undefined;
      });
    state.activeTurn = turn;
  } catch (error) {
    state.running = false;
    throw error;
  }
}

function responseParts(argument: string): { requestId: string; response: unknown } | undefined {
  const whitespace = argument.search(/\s/u);
  if (whitespace < 1) return undefined;
  const requestId = argument.slice(0, whitespace);
  const raw = argument.slice(whitespace).trim();
  if (raw.length === 0) return undefined;
  try {
    return { requestId, response: JSON.parse(raw) as unknown };
  } catch {
    return { requestId, response: raw };
  }
}

export async function runInteractive(
  runtime: RuntimePort,
  args: CliArguments,
  io: CliIo,
): Promise<void> {
  const cwd = NodePath.resolve(args.cwd ?? process.cwd());
  const state: InteractiveState = {
    profileId: args.profile,
    model: args.model,
    session: undefined,
    running: false,
    activeTurn: undefined,
  };

  const terminal = io.input.isTTY === true && io.output.isTTY === true;
  const readline = NodeReadline.createInterface({
    input: io.input,
    output: io.output,
    terminal,
    historySize: 500,
    removeHistoryDuplicates: true,
  });

  let exiting = false;
  readline.on("SIGINT", () => {
    if (state.running && state.session !== undefined) {
      void runtime.interrupt(state.session.id).catch((error: unknown) => {
        writeLine(
          io.error,
          `Interrupt failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
      writeLine(io.error, "^C interrupt requested");
      return;
    }
    writeLine(io.error, "^C (use /exit to quit)");
    if (terminal) readline.prompt();
  });

  if (terminal) {
    writeLine(io.output, "T-Nano — /help for commands");
    readline.setPrompt("t-nano> ");
  }

  const initialPrompt = args.positionals.join(" ");
  if (initialPrompt.length > 0) await launchPrompt(runtime, state, initialPrompt, cwd, io);
  if (terminal) readline.prompt();

  try {
    for await (const line of readline) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        if (terminal) readline.prompt();
        continue;
      }

      try {
        if (!trimmed.startsWith("/")) {
          await launchPrompt(runtime, state, line, cwd, io);
        } else {
          const { command, argument } = commandParts(trimmed);
          switch (command) {
            case "/profile":
              if (state.running && argument.length > 0) {
                writeLine(io.error, "Interrupt the active turn before changing profiles.");
                break;
              }
              if (argument.length === 0) {
                writeLine(io.output, `Selected profile: ${state.profileId ?? "none"}`);
                printProfiles(io.output, await runtime.listProfiles());
              } else {
                const profiles = await runtime.listProfiles();
                if (!profiles.some((profile) => profile.id === argument)) {
                  writeLine(io.error, `Unknown profile: ${argument}`);
                  break;
                }
                state.profileId = argument;
                state.session = undefined;
                writeLine(io.output, `Profile: ${argument}`);
              }
              break;
            case "/model":
              if (state.running && argument.length > 0) {
                writeLine(io.error, "Interrupt the active turn before changing models.");
                break;
              }
              if (argument.length === 0) {
                writeLine(io.output, `Selected model: ${state.model ?? "adapter default"}`);
              } else {
                state.model = argument;
                state.session = undefined;
                writeLine(io.output, `Model: ${argument}`);
              }
              break;
            case "/sessions":
              printSessions(io.output, await runtime.listSessions());
              break;
            case "/new":
              if (state.running) {
                writeLine(io.error, "Interrupt the active turn before starting a new session.");
                break;
              }
              state.session = undefined;
              if (argument.length > 0) await launchPrompt(runtime, state, argument, cwd, io);
              else writeLine(io.output, "New session selected.");
              break;
            case "/resume":
              if (state.running) {
                writeLine(io.error, "Interrupt the active turn before resuming another session.");
                break;
              }
              if (argument.length === 0) {
                writeLine(io.error, "Usage: /resume <session-id>");
                break;
              }
              state.session = await runtime.startSession({
                profileId: state.profileId ?? "",
                cwd,
                resumeSessionId: argument,
              });
              state.profileId = state.session.profileId;
              state.model = state.session.model;
              writeLine(io.output, `Resumed session ${state.session.id}.`);
              break;
            case "/respond": {
              if (state.session === undefined) {
                writeLine(io.error, "There is no active session to respond to.");
                break;
              }
              const parsed = responseParts(argument);
              if (parsed === undefined) {
                writeLine(io.error, "Usage: /respond <request-id> <json-or-text>");
                break;
              }
              await runtime.respond(state.session.id, parsed.requestId, parsed.response);
              break;
            }
            case "/interrupt":
              if (!state.running || state.session === undefined) {
                writeLine(io.error, "There is no active turn to interrupt.");
                break;
              }
              await runtime.interrupt(state.session.id);
              break;
            case "/doctor": {
              const profileId = argument || state.profileId;
              if (profileId === undefined) {
                writeLine(io.error, "Select a profile or use /doctor <profile-id>.");
                break;
              }
              writeLine(io.output, JSON.stringify(await runtime.probeProfile(profileId), null, 2));
              break;
            }
            case "/help":
              writeLine(io.output, INTERACTIVE_HELP);
              break;
            case "/exit":
              if (state.running && state.session !== undefined) {
                await runtime.interrupt(state.session.id);
                await state.activeTurn;
              }
              exiting = true;
              readline.close();
              break;
            default:
              writeLine(io.error, `Unknown command: ${command}`);
          }
        }
      } catch (error) {
        writeLine(io.error, error instanceof Error ? error.message : String(error));
      }

      if (exiting) break;
      if (terminal) readline.prompt();
    }
  } finally {
    await state.activeTurn;
    readline.close();
  }
}
