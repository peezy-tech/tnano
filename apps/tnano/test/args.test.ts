import { describe, expect, it } from "vite-plus/test";

import { parseArguments } from "../src/args.ts";

describe("parseArguments", () => {
  it("parses the four-mode selection and shared options", () => {
    expect(
      parseArguments([
        "--mode=json",
        "--profile",
        "work",
        "--model",
        "model-1",
        "--cwd",
        "/repo",
        "hello",
        "world",
      ]),
    ).toEqual({
      mode: "json",
      profile: "work",
      model: "model-1",
      cwd: "/repo",
      help: false,
      version: false,
      positionals: ["hello", "world"],
    });
  });

  it("rejects unknown modes and duplicate options", () => {
    expect(() => parseArguments(["--mode", "web"])).toThrow("Invalid mode");
    expect(() => parseArguments(["--profile", "one", "--profile", "two"])).toThrow(
      "only be provided once",
    );
  });

  it("accepts repeatable trusted adapter specifiers and rejects project-local paths", () => {
    expect(
      parseArguments([
        "--adapter",
        "@example/adapter-one",
        "--adapter=file:///opt/t-nano/adapter-two.mjs",
        "--adapter",
        "/opt/t-nano/adapter-three.mjs",
        "harnesses",
      ]),
    ).toMatchObject({
      adapters: [
        "@example/adapter-one",
        "file:///opt/t-nano/adapter-two.mjs",
        "/opt/t-nano/adapter-three.mjs",
      ],
      positionals: ["harnesses"],
    });

    expect(() => parseArguments(["--adapter", "./adapter.mjs", "harnesses"])).toThrow(
      "project-local",
    );
    expect(() => parseArguments(["--adapter", "../adapter.mjs", "harnesses"])).toThrow(
      "project-local",
    );
  });
});
