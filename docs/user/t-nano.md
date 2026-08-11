# T-Nano

T-Nano is a terminal-first switchboard for coding harnesses. It selects an explicit named
profile, starts or resumes that harness's native session, and presents the same small event model
through a CLI or TypeScript SDK. The harness still owns authentication, prompts, tools,
permissions, models, and its native transcript.

The local build includes the deterministic Echo adapter plus Codex and Pi adapters. It does not infer
subscription entitlements, inspect usage, or fail over between accounts. Account and subscription
selection is explicit: give each native account state its own profile, then select that profile.

## Run the local build

The packages are not published yet. From this repository, install the filtered workspace and
build the CLI:

```sh
corepack pnpm --filter='t-nano...' install
corepack pnpm --filter=t-nano run build
node apps/tnano/dist/bin.mjs --help
```

The examples below use `t-nano` for readability. Until the package is published or linked, replace
it with `node apps/tnano/dist/bin.mjs` and run it from the repository root.

## Isolate T-Nano state with `--home`

Use a dedicated absolute directory for every T-Nano installation or test:

```sh
TNANO_DATA=/absolute/path/to/t-nano-data
t-nano --home "$TNANO_DATA" harnesses
```

`--home` selects the directory containing `profiles.json`, `settings.json`, `observations.json`,
and each session's `binding.json` and `events.jsonl`. It prevents a development run from sharing
T-Nano profiles and sessions with another installation. The default is `~/.t-nano`.

This does not relocate a harness's own account state. Use `codexHome` for Codex and `agentDir` for
Pi when profiles must represent separate accounts. Use absolute paths; profile config does not
expand `~`.

## Add profiles

Echo is a deterministic local adapter useful for smoke tests:

```sh
t-nano --home "$TNANO_DATA" profile add echo-local \
  --harness echo \
  --label "Local echo" \
  --config-json '{}'
```

A Codex profile can pin a separate native Codex home and sandbox:

```sh
t-nano --home "$TNANO_DATA" profile add codex-work \
  --harness codex \
  --label "Codex work subscription" \
  --config-json '{"codexHome":"/absolute/path/to/codex-work-account","sandbox":"read-only"}'
```

`sandbox` accepts `read-only`, `workspace-write`, or `danger-full-access`; it defaults to
`read-only`. Codex also accepts optional `command` and `extraArgs` config fields. T-Nano launches
`codex exec --json` and sets `CODEX_HOME` to `codexHome` for that profile.

A Pi profile requires its own agent directory. A separate session directory is optional:

```sh
t-nano --home "$TNANO_DATA" profile add pi-work \
  --harness pi \
  --label "Pi work subscription" \
  --config-json '{"agentDir":"/absolute/path/to/pi-work-agent","sessionDir":"/absolute/path/to/pi-work-sessions","provider":"anthropic"}'
```

`agentDir` becomes `PI_CODING_AGENT_DIR`, and `sessionDir` becomes
`PI_CODING_AGENT_SESSION_DIR`. `provider` is passed to Pi and is also used by `doctor` for a
non-refreshing auth check. Pi also accepts optional `command`, `thinking`, and `extraArgs` fields.
Pass a model for a new session with the CLI's `--model` option.

Pi reports its selected provider as adapter metadata, not as an account ID. An adapter should set
`account.id` or `account.email` only when the native harness supplies a stable account identity.

Profile IDs are stable routing identities. A saved session remains pinned to its original profile,
adapter version, working directory, model, and native continuation binding.

## Load a custom adapter

Third-party integrations are explicit trusted code. Pass a package name, absolute path, or `file:`
URL with `--adapter`; repeat the option when loading more than one module:

```sh
t-nano --home "$TNANO_DATA" \
  --adapter @example/t-nano-adapter \
  --adapter file:///absolute/path/to/local-adapter.mjs \
  harnesses
```

Relative and project-local module paths are rejected, and T-Nano never scans a project for
adapters. A module may export one adapter as `default` or `adapter`, or several as `adapters`.
Adapters run in-process with the user's privileges, so load only code you trust.

Pass the same `--adapter` option on later interactive, print, JSON, or RPC invocations that use a
profile backed by that adapter. The TypeScript SDK can instead call `runtime.register(adapter)` or
`runtime.loadAdapter(specifier)` directly.

## CLI modes

There are four CLI modes. The TypeScript SDK is a separate embedding surface backed by the same
runtime.

### Interactive

Interactive mode is the default:

```sh
t-nano --home "$TNANO_DATA" --profile echo-local --cwd /absolute/path/to/project
```

Enter a prompt on a normal line. The slash commands are:

- `/profile [id]` shows the selected profile and profile list, or selects a profile.
- `/model [id]` shows or selects the model for the next new session.
- `/sessions` lists saved sessions.
- `/new [prompt]` drops the current session and optionally starts the next one immediately.
- `/resume <session-id>` resumes a saved session with its pinned profile and model.
- `/respond <request-id> <json-or-text>` answers an open harness request. Valid JSON is parsed;
  otherwise the value is sent as text.
- `/interrupt` interrupts the active turn. Pressing Ctrl-C during a turn requests the same action.
- `/doctor [profile-id]` probes a profile, defaulting to the selected profile.
- `/help` prints the command list.
- `/exit` interrupts an active turn, waits for it to settle, and exits.

Profile or model changes take effect on the next new session. T-Nano allows only one active turn
per session. An exclusive local lease also prevents two T-Nano processes from driving the same
saved session at once.

### Print

Print mode runs one prompt and writes only the final assistant text to stdout:

```sh
t-nano --home "$TNANO_DATA" --mode print --profile echo-local "hello"
printf '%s\n' 'hello from stdin' | t-nano --home "$TNANO_DATA" --mode print --profile echo-local
```

Non-content status and diagnostics use stderr. A profile is always required.

### JSON

JSON mode runs one prompt and emits one final JSON object:

```sh
t-nano --home "$TNANO_DATA" --mode json --profile echo-local "hello"
```

A successful object contains `ok`, `sessionId`, final `text`, and the persisted event list. CLI
failures in this mode are also emitted as one object with `ok: false` and an `error` record.

### RPC

RPC mode reads and writes exactly one JSON object per LF-terminated line:

```sh
t-nano --home "$TNANO_DATA" --mode rpc
```

Do not send empty lines or an unterminated final record. stdout is reserved for protocol records;
diagnostics for notifications without an `id` use stderr. `initialize` must be the first
operational request; only `shutdown` is also accepted before initialization.

Initialize the connection:

```json
{ "jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {} }
```

The response reports protocol version 1, the server version, and the supported method names:

```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "protocolVersion": 1,
    "server": { "name": "t-nano", "version": "0.0.0" },
    "methods": [
      "initialize",
      "harness.list",
      "harness.inspect",
      "profile.list",
      "profile.probe",
      "session.list",
      "session.start",
      "session.send",
      "session.interrupt",
      "session.stop",
      "session.respond",
      "shutdown"
    ]
  }
}
```

Start a new session. `profileId` and `cwd` are required; `sessionId` and `model` are optional:

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "method": "session.start",
  "params": { "profileId": "echo-local", "cwd": "/absolute/path/to/project" }
}
```

To resume instead, send `session.start` with `resumeSessionId`:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "session.start",
  "params": { "resumeSessionId": "saved-session-id" }
}
```

Send a prompt using the `id` returned by `session.start`:

```json
{
  "jsonrpc": "2.0",
  "id": 4,
  "method": "session.send",
  "params": { "sessionId": "session-id-from-start", "prompt": "hello" }
}
```

`session.send` acknowledges immediately with `{ "accepted": true, "sessionId": "..." }`.
Turn output and lifecycle updates arrive independently as `event` notifications. Events include a
monotonic sequence number plus the pinned session, profile, and harness IDs:

```json
{
  "jsonrpc": "2.0",
  "method": "event",
  "params": {
    "kind": "content.delta",
    "text": "echo: ",
    "channel": "assistant",
    "protocolVersion": 1,
    "sequence": 3,
    "timestamp": "2026-08-11T00:00:00.000Z",
    "sessionId": "session-id-from-start",
    "profileId": "echo-local",
    "harnessId": "echo"
  }
}
```

Treat a `turn.state` event with `completed`, `failed`, or `interrupted` state as turn settlement.
If an adapter emits `request.opened`, answer it while the send remains active:

```json
{
  "jsonrpc": "2.0",
  "id": 5,
  "method": "session.respond",
  "params": {
    "sessionId": "session-id-from-start",
    "requestId": "request-id-from-event",
    "response": true
  }
}
```

Interrupt an active turn without closing its session:

```json
{
  "jsonrpc": "2.0",
  "id": 6,
  "method": "session.interrupt",
  "params": { "sessionId": "session-id-from-start" }
}
```

`session.stop` closes one session. `shutdown` closes the runtime and ends the RPC loop:

```json
{ "jsonrpc": "2.0", "id": 7, "method": "shutdown", "params": {} }
```

Responses may interleave with event notifications, so clients must correlate responses by `id`.
Only one `session.send` may be active for a given session.

## Inspection and management commands

```sh
t-nano --home "$TNANO_DATA" harnesses
t-nano --home "$TNANO_DATA" harness inspect codex
t-nano --home "$TNANO_DATA" profiles
t-nano --home "$TNANO_DATA" sessions
t-nano --home "$TNANO_DATA" doctor
t-nano --home "$TNANO_DATA" doctor codex-work
t-nano --home "$TNANO_DATA" profile remove profile-to-remove
```

`harness inspect` prints the adapter API version, declared capabilities, and configured profile
references without exposing profile configuration or environment values. It is also available as
the `harness.inspect` RPC method.

`doctor` without a profile probes every configured profile. Successful probes are timestamped in
`observations.json`. The first stable adapter-reported account ID or email becomes that profile's
baseline. If a later probe reports a different identity, `doctor` returns an
`account_identity_drift` warning; T-Nano does not switch, pool, or fail over accounts. Plan and
provider labels do not trigger identity drift. Changing an unused profile's harness, config, or
environment starts a new baseline on its next probe.

Add `--mode json` to `harnesses`, `harness inspect`, `profiles`, `sessions`, `doctor`, and profile
management commands for machine-readable output. Removing or incompatibly editing a profile is
rejected while a saved session is pinned to it.

## TypeScript SDK

The SDK does not register adapters implicitly. Register only trusted adapters, then create explicit
profiles and sessions:

```ts
import { createEchoAdapter } from "@t-nano/adapter-echo";
import { createTNanoRuntime } from "@t-nano/sdk";

const runtime = await createTNanoRuntime({
  dataDir: "/absolute/path/to/t-nano-sdk-data",
});
runtime.register(createEchoAdapter());

await runtime.upsertProfile({
  id: "echo-local",
  harness: "echo",
  label: "Local echo",
  enabled: true,
  config: {},
});

const session = await runtime.start({
  profileId: "echo-local",
  cwd: "/absolute/path/to/project",
});

try {
  for await (const event of session.run({ text: "hello" })) {
    if (event.type === "content.delta") process.stdout.write(event.text);
  }
} finally {
  await session.close();
  await runtime.close();
}
```

Use `runtime.resume({ sessionId })` for a saved session, `session.respond(...)` for structured
requests, and `session.interrupt()` for the active turn. Adapter events are persisted and enriched
with the protocol version, sequence, timestamp, session ID, profile ID, and harness ID. Native
continuation bindings remain opaque to callers.

Adapter packages can publish deterministic conformance tests without depending on a specific test
runner:

```ts
import { runAdapterConformance } from "@t-nano/sdk/conformance";

await runAdapterConformance({
  adapter,
  cases: [workFixture, personalFixture],
  verifyIsolation({ probes, bindings }) {
    // Assert captured child environments and native bindings use the intended profile.
  },
});
```

The helper requires two distinct named profiles and checks manifest/probe JSON, immutable profile
snapshots, session methods, normalized events, declared capabilities, resumable bindings, and exact
same-profile reopen. Adapters still own process-specific assertions through `verifyIsolation`.

## Current repository status

T-Nano is physically extracted from the T3 Code donor product tree. Its workspace contains only
the CLI, SDK, and reference adapter packages. A source-boundary guard rejects forbidden donor
dependencies and fails if a removed donor product domain returns.

No T-Nano package has been published. The maintained source fork is
`https://github.com/peezy-tech/tnano`; package publication and deployment remain separate release
decisions.
