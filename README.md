# T-Nano

T-Nano is a small terminal-first switchboard for coding harnesses. It sits one
level above tools such as Codex and Pi: T-Nano selects a harness and a named
account/profile, supervises its session, and relays a deliberately small event
protocol.

One SDK-backed runtime is exposed through four surfaces:

- interactive terminal;
- print or JSON output;
- strict LF-delimited JSON RPC over stdin/stdout;
- TypeScript SDK.

T-Nano is derived from [T3 Code](https://github.com/pingdotgg/t3code), whose
provider-instance and account-routing work is the donor seam. It adopts
[Pi's](https://github.com/earendil-works/pi) minimal-core philosophy one level
higher: T-Nano is extensible around harness adapters and refuses to become a
harness, IDE, web shell, or cloud product.

## Status

T-Nano is physically extracted from the donor product tree. The repository now
contains only the CLI, SDK, Echo/Codex/Pi adapters, focused documentation, and
the source-boundary guard. The guard rejects both forbidden dependencies and
the return of removed donor product domains.

Two-profile Codex and Pi process tests prove native-home isolation and pinned
continuation. The SDK also publishes conformance, capability inspection, and
persistent account-drift warnings.

## Product boundary

T-Nano owns:

- explicit harness, profile, model, and launch-option selection;
- named work/personal/custom profiles for the same harness;
- start, resume, input relay, interrupt, and stop;
- process supervision, stable errors, and approval/question relay;
- crash-safe local bindings and append-only display events;
- timestamped profile observations with account-identity drift warnings;
- capability inspection and a public two-profile adapter conformance helper.

Harness adapters own authentication behavior, agent loops, tools, permissions,
plans, skills, MCP, native transcripts, and continuation semantics.
Subscription, quota, and account labels are adapter-reported presentation—not
billing, entitlement, or automatic routing policy.

See [the architecture note](./docs/internals/t-nano.md) for the complete
boundary and protocol, or [the T-Nano guide](./docs/user/t-nano.md) for
profiles, modes, RPC, custom adapters, and SDK examples.

## Development

The workspace graph contains only the five T-Nano packages:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run check:surface
corepack pnpm run typecheck
corepack pnpm run test
corepack pnpm run build
```

No remote T-Nano repository or package has been published yet.
