import type { RuntimeEvent, RuntimePort, SendResult } from "./runtimePort.ts";
import { eventText } from "./presentation.ts";

export interface TurnOutput {
  result: SendResult;
  text: string;
  events: readonly RuntimeEvent[];
}

export interface RunTurnOptions {
  onEvent?: (event: RuntimeEvent) => void;
}

export async function runTurn(
  runtime: RuntimePort,
  sessionId: string,
  prompt: string,
  options: RunTurnOptions = {},
): Promise<TurnOutput> {
  const events: RuntimeEvent[] = [];
  let text = "";
  const unsubscribe = runtime.subscribe((event) => {
    if (event.sessionId !== undefined && event.sessionId !== sessionId) return;
    events.push(event);
    text += eventText(event) ?? "";
    options.onEvent?.(event);
  });

  try {
    const result = await runtime.send({ sessionId, prompt });
    if (text.length === 0 && typeof result.text === "string") text = result.text;
    return { result, text, events };
  } finally {
    unsubscribe();
  }
}
