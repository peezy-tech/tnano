import { describe, expect, it } from "vite-plus/test";

import {
  type Clock,
  type ProcessExit,
  type SpawnedProcess,
  splitLfLines,
  terminateProcess,
  type TimeoutResult,
} from "./process.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class FakeProcess implements SpawnedProcess {
  readonly stdout: AsyncIterable<string> = (async function* () {})();
  readonly stderr: AsyncIterable<string> = (async function* () {})();
  readonly signals: NodeJS.Signals[] = [];
  readonly exit = deferred<ProcessExit>();
  readonly exited = this.exit.promise;
  result: ProcessExit | undefined;
  exitOn: NodeJS.Signals | undefined;

  getResult(): ProcessExit | undefined {
    return this.result;
  }

  async writeAndCloseStdin(): Promise<void> {}

  signal(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    if (signal === this.exitOn) {
      this.result = { code: null, signal };
      this.exit.resolve(this.result);
    }
    return true;
  }
}

const immediateClock: Clock = {
  async withTimeout<T>(promise: Promise<T>): Promise<TimeoutResult<T>> {
    const marker = Symbol("timeout");
    const result = await Promise.race([promise, Promise.resolve(marker)]);
    return result === marker ? { timedOut: true } : { timedOut: false, value: result as T };
  },
};

describe("captured process termination", () => {
  it("starts with SIGINT and stops escalating once the child exits", async () => {
    const process = new FakeProcess();
    process.exitOn = "SIGINT";

    await terminateProcess(process, immediateClock, {
      interruptMs: 1,
      terminateMs: 1,
      killMs: 1,
    });

    expect(process.signals).toEqual(["SIGINT"]);
  });

  it("escalates only the captured child through TERM and KILL", async () => {
    const process = new FakeProcess();
    process.exitOn = "SIGKILL";

    await terminateProcess(process, immediateClock, {
      interruptMs: 1,
      terminateMs: 1,
      killMs: 1,
    });

    expect(process.signals).toEqual(["SIGINT", "SIGTERM", "SIGKILL"]);
  });
});

describe("LF-delimited streams", () => {
  it("preserves UTF-8 split across chunks and strips only an optional CR", async () => {
    const encoded = new TextEncoder().encode("one\r\ntw😀\nlast");
    const stream = (async function* () {
      yield encoded.slice(0, 9);
      yield encoded.slice(9, 11);
      yield encoded.slice(11);
    })();

    const lines: string[] = [];
    for await (const line of splitLfLines(stream)) lines.push(line);

    expect(lines).toEqual(["one", "tw😀", "last"]);
  });
});
