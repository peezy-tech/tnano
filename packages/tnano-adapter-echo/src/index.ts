import type {
  HarnessAdapter,
  HarnessEventInput,
  HarnessProfile,
  HarnessSession,
  JsonValue,
  ProbeResult,
} from "@t-nano/sdk";

const ECHO_VERSION = "1.0.0";
const ECHO_MODEL = "echo-v1";
const ECHO_ACCOUNT = "echo-local";

export class EchoAdapterError extends Error {
  readonly code: "busy" | "closed" | "invalid-profile" | "invalid-resume";

  constructor(code: "busy" | "closed" | "invalid-profile" | "invalid-resume", message: string) {
    super(message);
    this.name = "EchoAdapterError";
    this.code = code;
  }
}

type EchoBinding = {
  readonly schema: 1;
  readonly nativeSessionId: string;
};

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

type TurnOutcome = "interrupted" | "closed";

interface ActiveTurn {
  outcome?: TurnOutcome;
  readonly settled: Deferred<TurnOutcome>;
}

const manifest = {
  apiVersion: 1,
  id: "echo",
  label: "Echo",
  version: ECHO_VERSION,
  capabilities: ["resume", "interrupt"] as const,
} as const;

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  let resolved = false;

  return {
    promise,
    resolve(value) {
      if (resolved) return;
      resolved = true;
      resolvePromise(value);
    },
  };
}

function expectedNativeSessionId(sessionId: string): string {
  return `echo:${sessionId}`;
}

function bindingFor(sessionId: string): EchoBinding {
  return {
    schema: 1,
    nativeSessionId: expectedNativeSessionId(sessionId),
  };
}

function isRecord(value: JsonValue): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateResume(sessionId: string, resume: JsonValue | undefined): EchoBinding {
  if (resume === undefined) return bindingFor(sessionId);

  if (
    !isRecord(resume) ||
    resume.schema !== 1 ||
    resume.nativeSessionId !== expectedNativeSessionId(sessionId)
  ) {
    throw new EchoAdapterError(
      "invalid-resume",
      `Echo resume binding does not belong to session ${JSON.stringify(sessionId)}.`,
    );
  }

  return bindingFor(sessionId);
}

function sessionState(state: "running" | "ready"): HarnessEventInput {
  return { type: "session.state", state };
}

function turnState(state: "running" | "completed" | "failed" | "interrupted"): HarnessEventInput {
  return { type: "turn.state", state };
}

function contentDelta(delta: string): HarnessEventInput {
  return {
    type: "content.delta",
    channel: "assistant",
    text: delta,
  };
}

function failureEvent(): HarnessEventInput {
  return {
    type: "error",
    code: "echo_failure",
    message: "Echo adapter received FAIL.",
    recoverable: true,
  };
}

function assertProfile(profile: HarnessProfile): void {
  if (profile.harness !== manifest.id) {
    throw new EchoAdapterError(
      "invalid-profile",
      `Echo adapter cannot open harness ${JSON.stringify(profile.harness)}.`,
    );
  }
}

function createSession(binding: EchoBinding): HarnessSession {
  let closed = false;
  let active: ActiveTurn | undefined;

  const finishActive = (turn: ActiveTurn) => {
    if (active === turn) active = undefined;
  };

  const run: HarnessSession["run"] = ({ text, signal }) => {
    if (closed) {
      throw new EchoAdapterError("closed", "Echo session is closed.");
    }
    if (active !== undefined) {
      throw new EchoAdapterError("busy", "Echo session already has an active turn.");
    }

    signal?.throwIfAborted();

    const turn: ActiveTurn = { settled: deferred<TurnOutcome>() };
    active = turn;

    const interruptFromSignal = () => {
      if (turn.outcome !== undefined) return;
      turn.outcome = "interrupted";
      turn.settled.resolve("interrupted");
    };
    const wasInterrupted = () => turn.outcome === "interrupted";
    signal?.addEventListener("abort", interruptFromSignal, { once: true });

    return (async function* (): AsyncGenerator<HarnessEventInput> {
      try {
        if (closed) return;
        yield sessionState("running");
        if (closed) return;
        if (wasInterrupted()) {
          yield turnState("interrupted");
          if (!closed) yield sessionState("ready");
          return;
        }

        yield turnState("running");

        if (text === "HOLD") {
          const outcome = await turn.settled.promise;
          if (closed || outcome === "closed") return;
          yield turnState("interrupted");
          if (!closed) yield sessionState("ready");
          return;
        }

        if (closed) return;
        if (wasInterrupted()) {
          yield turnState("interrupted");
          if (!closed) yield sessionState("ready");
          return;
        }

        if (text === "FAIL") {
          yield failureEvent();
          if (closed) return;
          yield turnState("failed");
          if (!closed) yield sessionState("ready");
          return;
        }

        yield contentDelta("echo: ");
        if (closed) return;
        if (wasInterrupted()) {
          yield turnState("interrupted");
          if (!closed) yield sessionState("ready");
          return;
        }
        yield contentDelta(text);
        if (closed) return;
        yield turnState("completed");
        if (!closed) yield sessionState("ready");
      } finally {
        signal?.removeEventListener("abort", interruptFromSignal);
        finishActive(turn);
      }
    })();
  };

  return {
    binding,
    run,
    async interrupt() {
      const turn = active;
      if (turn === undefined || turn.outcome !== undefined) return;
      turn.outcome = "interrupted";
      turn.settled.resolve("interrupted");
    },
    async close() {
      if (closed) return;
      closed = true;
      const turn = active;
      if (turn === undefined || turn.outcome !== undefined) return;
      turn.outcome = "closed";
      turn.settled.resolve("closed");
    },
  };
}

export function createEchoAdapter(): HarnessAdapter {
  return {
    manifest,
    async probe(_profile, signal): Promise<ProbeResult> {
      signal?.throwIfAborted();
      return {
        status: "ready",
        version: ECHO_VERSION,
        account: {
          id: ECHO_ACCOUNT,
          label: ECHO_ACCOUNT,
        },
        models: [
          {
            id: ECHO_MODEL,
            label: ECHO_MODEL,
            available: true,
          },
        ],
      };
    },
    async open(input): Promise<HarnessSession> {
      input.signal?.throwIfAborted();
      assertProfile(input.profile);
      const binding = validateResume(input.sessionId, input.resume);
      return createSession(binding);
    },
  };
}

const echoAdapter = createEchoAdapter();

export default echoAdapter;
