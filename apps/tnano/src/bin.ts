import { runCli } from "./cli.ts";
import { defaultRuntimeFactory } from "./sdkBridge.ts";

const exitCode = await runCli(
  process.argv.slice(2),
  {
    input: process.stdin,
    output: process.stdout,
    error: process.stderr,
  },
  defaultRuntimeFactory,
);

process.exitCode = exitCode;
