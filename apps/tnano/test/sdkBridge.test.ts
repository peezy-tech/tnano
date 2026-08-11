// @effect-diagnostics nodeBuiltinImport:off - This is a Node CLI integration test.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { runCli } from "../src/cli.ts";
import { defaultRuntimeFactory } from "../src/sdkBridge.ts";
import { memoryIo } from "./testRuntime.ts";

const FIXTURE_ADAPTER = new URL("./fixtures/adapter.mjs", import.meta.url).href;
const DRIFT_FIXTURE_ADAPTER = new URL("./fixtures/drift-adapter.mjs", import.meta.url).href;

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

  it("surfaces persisted account identity drift through the doctor command", async () => {
    const dataDir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t-nano-drift-test-"));
    const previousAccount = process.env.TNANO_DRIFT_TEST_ACCOUNT;
    try {
      process.env.TNANO_DRIFT_TEST_ACCOUNT = "account-work";
      await expect(
        runCli(
          [
            "--home",
            dataDir,
            "--adapter",
            DRIFT_FIXTURE_ADAPTER,
            "profile",
            "add",
            "drift-work",
            "--harness",
            "drift-fixture",
          ],
          memoryIo(),
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);

      const baselineIo = memoryIo();
      await expect(
        runCli(
          [
            "--home",
            dataDir,
            "--adapter",
            DRIFT_FIXTURE_ADAPTER,
            "--mode",
            "json",
            "doctor",
            "drift-work",
          ],
          baselineIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(baselineIo.outputText())).not.toHaveProperty("warnings");

      process.env.TNANO_DRIFT_TEST_ACCOUNT = "account-personal";
      const driftIo = memoryIo();
      await expect(
        runCli(
          [
            "--home",
            dataDir,
            "--adapter",
            DRIFT_FIXTURE_ADAPTER,
            "--mode",
            "json",
            "doctor",
            "drift-work",
          ],
          driftIo,
          defaultRuntimeFactory,
        ),
      ).resolves.toBe(0);
      expect(JSON.parse(driftIo.outputText())).toMatchObject({
        account: { id: "account-personal" },
        warnings: [
          {
            code: "account_identity_drift",
            baseline: { account: { id: "account-work" } },
            observed: { account: { id: "account-personal" } },
          },
        ],
      });
    } finally {
      if (previousAccount === undefined) delete process.env.TNANO_DRIFT_TEST_ACCOUNT;
      else process.env.TNANO_DRIFT_TEST_ACCOUNT = previousAccount;
      await NodeFSP.rm(dataDir, { recursive: true, force: true });
    }
  });
});
