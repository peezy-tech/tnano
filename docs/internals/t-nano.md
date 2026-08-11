# T-Nano architecture

## The layer above harnesses

T-Nano is not a universal agent runtime. It discovers explicitly trusted
harness adapters, resolves a named profile, opens or resumes the native
session, and relays input and output. Anything that answers how an agent plans,
uses tools, asks permission, compacts context, or stores its authoritative
transcript belongs below the adapter boundary.

```text
interactive   print/JSON   JSONL RPC   embedding
      \           |           |           /
                   T-Nano SDK
      registry · profiles · sessions · display events
                         |
                 harness adapter API
              /          |           \
           Codex         Pi         custom
```

The SDK is the source of truth. Every other mode is a presentation or transport
adapter over the same calls and event records.

## Stable identities

- A harness ID selects an implementation package.
- A profile ID selects one user-defined configuration/account context.
- A T-Nano session ID selects the local binding and display log.
- A native binding is opaque adapter state used only to resume that harness.

Sessions are always pinned to a profile. T-Nano never silently changes an
account because of authentication, rate limits, quota, or failure. A profile
change on resume is allowed only when the adapter explicitly proves
continuation compatibility.

## Adapter contract

Adapters are trusted in-process TypeScript modules loaded only from explicit
CLI module flags or supplied directly by an embedding application. T-Nano does
not scan projects for integrations. Adapters declare metadata and capabilities,
probe a profile, and open a native session. Core owns canonical IDs, sequence
numbers, timestamps, persistence, redaction, and mode-independent errors.

`@t-nano/sdk/conformance` provides a test-runner-independent two-profile suite.
It checks the generic adapter contract and exposes a callback where an adapter
package proves that captured native homes, environment overrides, and bindings
remain isolated.

Unknown native messages are preserved as bounded, namespaced `custom` events.
They are not dropped and do not force the core protocol to understand every
harness feature.

## Core events

- `session.state`
- `turn.state`
- `content.delta`
- `activity.upsert`
- `request.opened`
- `request.resolved`
- `binding.updated`
- `error`
- `custom`

Adapters may report content, generic activity, interaction requests, errors,
binding changes, and custom records. They do not introduce semantic core types
for plans, subagents, hooks, MCP, tools, diffs, or tasks.

## Storage

T-Nano uses human-inspectable configuration, atomic binding JSON, and
append-only JSONL display logs. Private native resume data is never written to
the public event log. The harness transcript remains authoritative; T-Nano
does not promise cross-harness conversion or continuation.

An exclusive per-session filesystem lease prevents two T-Nano processes from
driving the same native session. Same-host leases are reclaimed only when the
recorded owner PID is provably gone; foreign, malformed, or ambiguous leases
fail closed.

## Comfort without subsystems

T-Nano can show installed/authenticated/version/account/model state, current
session usage, context, rate limits, or plan labels when an adapter already has
those facts. It does not scan unrelated harness histories, fetch pricing,
monitor CPU/RAM, call a second model for titles, execute upgrades, or report
product analytics.

Probe observations are timestamped and persisted separately from profiles.
The first stable adapter-reported account ID or email is the profile baseline;
a later mismatch is a warning, never an entitlement decision or automatic
route change. Provider and plan labels are presentation metadata, not identity.

## Deliberate exclusions

- web, desktop, mobile, cloud, relay, pairing, and remote administration;
- Git/worktree/checkpoint/diff, file browser/editor, terminal, preview, and PR
  product surfaces;
- event-sourced product orchestration or a projection database;
- background analytics, resource telemetry, usage aggregation, pricing, and
  update execution;
- core-owned login/OAuth, billing, entitlements, account pooling, quota
  rotation, or failover;
- plugin marketplace or arbitrary integration-provided UI.
