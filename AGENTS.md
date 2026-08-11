# T-Nano

T-Nano is a terminal-first switchboard for coding harnesses, derived from T3
Code. It is a tool that uses harnesses; it is not itself a harness or an IDE.

## Supported surfaces

One SDK-backed runtime serves four thin surfaces:

- interactive terminal;
- print or JSON output;
- strict LF-delimited JSON RPC over stdin/stdout;
- TypeScript SDK embedding.

Do not add a web, desktop, mobile, cloud, relay, or remote-management surface.

## Ownership boundary

Core owns adapter registration, named profiles, explicit selection, process and
session supervision, a small event envelope, local bindings/display logs, and
stable errors across the four modes.

Harness adapters own authentication semantics, agent loops, prompts, tools,
permissions, plans, skills, MCP, hooks, subagents, models, native transcripts,
and continuation behavior. Core may display adapter-reported metadata but must
not infer billing, entitlements, quotas, or automatic account failover.

Keep harness implementation identity separate from named profile/account
identity. Pin every session to its selected profile and require explicit,
adapter-declared continuation compatibility before switching it.

## Minimality gates

- New T-Nano packages must not import `@t3tools/*` or donor application code.
- Use plain JSON-compatible TypeScript contracts; do not expose Effect types.
- Core event kinds remain: `session.state`, `turn.state`, `content.delta`,
  `activity.upsert`, `request.opened`, `request.resolved`, `binding.updated`,
  `error`, and namespaced `custom`.
- Unknown adapter events remain visible; do not grow a closed union for every
  harness feature.
- Prefer Node built-ins and human-inspectable JSON/JSONL storage over databases,
  scanners, daemons, or side-channel model calls.
- Treat explicitly configured TypeScript adapters as trusted local code. Never
  auto-load project-local adapters.

## Donor exclusions

Do not introduce dependencies on Git/worktrees/checkpoints/diffs, file-browser
or editor systems, embedded terminals/previews, PR integrations, cloud/relay,
usage-history scanners, pricing, resource telemetry, analytics/OTLP, update
execution, generated titles/text, or T3's event-sourced orchestration.

## Working safely

- Never run against or modify `~/.t3` state.
- Never kill processes by pattern. Stop only a PID captured at spawn.
- Use focused tests, typechecks, and builds for T-Nano packages. Do not run the
  donor's repository-wide test or typecheck commands.
- Keep source changes in this nested checkout. The parent workspace holds only
  operational patch.moi context.
- Do not create remotes, push, publish, open PRs, build production images, or
  deploy without explicit user authorization.
