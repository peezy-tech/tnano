// @effect-diagnostics nodeBuiltinImport:off - This is a Node CLI integration test.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCli } from "../src/cli.ts";
import { defaultRuntimeFactory } from "../src/sdkBridge.ts";
import { memoryIo } from "./testRuntime.ts";

const FIXTURE_ADAPTER = new URL("./fixtures/adapter.mjs", import.meta.url).href;

describe("SDK bridge", () => {
  it("loads an explicitly configured adapter for the CLI harness list", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t-nano-cli-adapter-"));
    try {
      const io = memoryIo();
      await expect(
        runCli(
          ["--home", dataDir, "--adapter", FIXTURE_ADAPTER, "harnesses"],
          io,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);

      expect(io.outputText()).toContain("fixture");
      expect(io.errorText()).toBe("");
    } finally {
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("exposes an explicitly configured adapter through RPC harness.list", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t-nano-rpc-adapter-"));
    const input = [
      { id: 1, method: "initialize" },
      { id: 2, method: "harness.list" },
      { id: 3, method: "shutdown" },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n");
    try {
      const io = memoryIo(`${input}\n`);
      await expect(
        runCli(
          ["--home", dataDir, "--adapter", FIXTURE_ADAPTER, "--mode", "rpc"],
          io,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);

      const records = io
        .outputText()
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as { id?: number; result?: unknown });
      const listed = records.find((record) => record.id === 2)?.result as
        | Array<{ id?: string }>
        | undefined;
      expect(listed).toContainEqual(expect.objectContaining({ id: "fixture" }));
      expect(io.errorText()).toBe("");
    } finally {
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    }
  });

  it("runs the real Echo adapter through profile persistence and print mode", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t-nano-cli-test-"));
    try {
      const addIo = memoryIo();
      await expect(
        runCli(
          ["--home", dataDir, "profile", "add", "echo-test", "--harness", "echo"],
          addIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);

      const duplicateIo = memoryIo();
      await expect(
        runCli(
          ["--home", dataDir, "profile", "add", "echo-test", "--harness", "codex"],
          duplicateIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(3);
      expect(duplicateIo.errorText()).toContain("Profile already exists: echo-test");

      const printIo = memoryIo();
      await expect(
        runCli(
          ["--home", dataDir, "--mode", "print", "--profile", "echo-test", "hello"],
          printIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);
      expect(printIo.outputText()).toBe("echo: hello\n");
      expect(printIo.errorText()).toBe("");

      const failureIo = memoryIo();
      await expect(
        runCli(
          ["--home", dataDir, "--mode", "json", "--profile", "echo-test", "FAIL"],
          failureIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(8);
      expect(JSON.parse(failureIo.outputText())).toMatchObject({
        ok: false,
        error: { code: "harness_crashed" },
      });
      expect(failureIo.errorText()).toBe("");
    } finally {
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    }
  });
});
