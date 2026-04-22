# Authoring a Reder adapter

This guide is for someone writing a new transport for Reder — Slack, Discord, WhatsApp, SMS, or anything else. The contract is small and stable.

## The `Adapter` interface

Your module's default export (or a `createAdapter` function) must produce an instance of `@rederjs/core/adapter`'s `Adapter` abstract class:

```ts
import { Adapter, type AdapterContext } from '@rederjs/core/adapter';

export default class MyAdapter extends Adapter {
  readonly name = 'my-adapter';

  async start(ctx: AdapterContext): Promise<void> {
    // read ctx.config (your adapter's YAML block)
    // subscribe to your transport; on each inbound event, call ctx.router.ingestInbound(...)
  }
  async stop(): Promise<void> { /* cancel subscriptions */ }
  async sendOutbound(msg) { /* deliver Claude's reply. Return { success, retriable, error?, transportMessageId? } */ }
  async sendPermissionPrompt(prompt) { /* render a prompt with Allow/Deny options */ }
  async cancelPermissionPrompt(requestId, finalVerdict) { /* edit/delete the prompt */ }
}
```

## The `AdapterContext`

Reder gives you:

- `ctx.logger` — a scoped pino logger. Use child loggers; never `console.log`.
- `ctx.config` — your YAML block, already parsed. Validate it with zod.
- `ctx.storage` — a KV store scoped to your adapter. Nobody else can read or write it.
- `ctx.sessions` — the list of sessions declared in config (`session_id`, `display_name`, `workspace_dir?`, `auto_start`). Read-only.
- `ctx.router` — the way you interact with the core:
  - `ingestInbound(InboundMessage)` — text + meta + optional file paths.
  - `ingestPermissionVerdict(PermissionVerdict)` — user approved/denied a prompt.
  - `isPaired(adapter, senderId, sessionId)` — allowlist check.
  - `isSessionConnected(sessionId)` — is a Claude Code shim currently connected?
  - `listBindingsForSession(adapter, sessionId)` — for resolving the recipient of outbound messages.
  - `createPairCode({ adapter, senderId, metadata? })` — 6-char code for first-contact pairing.
  - `events.on(event, listener)` — subscribe to router events. Useful if your adapter needs to observe cross-adapter activity (e.g. the web dashboard pushes transcript updates from Telegram messages). Events: `inbound.persisted`, `outbound.persisted`, `outbound.sent`, `permission.requested`, `permission.resolved`, `session.state_changed`.
- `ctx.dataDir` — the daemon's data directory. Use `dataDir/media/<yourname>/...` for cached media.
- `ctx.db` (optional) — direct SQLite handle. Only in-tree adapters that need complex read queries use this. Third-party adapters should prefer `router.events` and the router methods above.
- `ctx.healthSnapshot` (optional) — pre-built health JSON function matching the `/health` endpoint. Adapters exposing their own HTTP surface (like `@rederjs/adapter-web`) use this.

## Rules the core enforces

1. **Persist inbound before acknowledgement.** Reder's router writes inbound to SQLite before attempting delivery. Your adapter should, similarly, only advance its transport-side offset (Telegram long-poll offset, Slack event ack, …) _after_ `router.ingestInbound` returns.
2. **Deny-by-default senders.** Every inbound must pass `router.isPaired(...)` before reaching `router.ingestInbound`. If not paired, either initiate pairing (`createPairCode` + user DM) or drop the event.
3. **Idempotency keys are mandatory for anything that might retry.** Pass `idempotencyKey` on InboundMessage (e.g. `"slack:TX123:M456"`). The router deduplicates by `(adapter, idempotency_key)`.
4. **Text + meta only on the wire.** Files are referenced by absolute path in the `files` array and mirrored as path-valued keys in `meta` (e.g. `meta.image_path`). Claude Code reads the file via its `Read` tool.
5. **Never shell out with user input.** This is not an adapter concern, but any adapter that needs to invoke a local tool must sanitise or use `execFile` (never `exec` with a string).

## Shipping your adapter

```json
{
  "name": "@community/reder-adapter-slack",
  "type": "module",
  "main": "./dist/index.js",
  "peerDependencies": { "@rederjs/core": "^0.1" }
}
```

Users install it and reference it in `reder.config.yaml`:

```yaml
adapters:
  slack:
    module: "@community/reder-adapter-slack"
    config:
      workspace_id_env: SLACK_WORKSPACE
      channel_session_map:
        "#booknerds-ops": booknerds
```

Reder warns the operator on startup that a non-`@rederjs/*` adapter was loaded; encourage your users to read `reder doctor` and verify.

### CLI namespace convention

Built-in adapters expose operator commands under `reder <adapter-name> …` (e.g. `reder telegram bot add`, `reder telegram allow add`, `reder dashboard url` for the web adapter). Third-party adapters don't plug into the `reder` CLI directly — instead, ship your own binary (e.g. `reder-slack`) or lean on `reder config` + direct YAML edits. The built-in-adapter CLI surface will open up in a future release once the contract stabilises; until then, document your configuration knobs and a `${env:VAR}` indirection pattern, and let operators edit `reder.config.yaml` themselves.

## Reference implementations

- `@rederjs/adapter-telegram` in this repository — the reference for an inbound-long-poll + rich-media + inline-keyboard permission adapter.
- `@rederjs/adapter-web` — the reference for an adapter that owns its own HTTP surface, subscribes to `router.events` for live transcript fan-out, and uses `ctx.db` for transcript queries. Good model for a Slack or Discord adapter that wants to show chat UI beyond a simple message echo.
- Future: `@rederjs/adapter-voice` (Phase 2) will be the reference for stateful bidirectional audio transports.
