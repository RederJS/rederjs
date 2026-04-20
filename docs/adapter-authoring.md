# Authoring a Reder adapter

This guide is for someone writing a new transport for Reder — Slack, Discord, WhatsApp, SMS, or anything else. The contract is small and stable.

## The `Adapter` interface

Your module's default export (or a `createAdapter` function) must produce an instance of `@reder/core/adapter`'s `Adapter` abstract class:

```ts
import { Adapter, type AdapterContext } from '@reder/core/adapter';

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
- `ctx.router` — the only way you inject events into the core:
  - `ingestInbound(InboundMessage)` — text + meta + optional file paths.
  - `ingestPermissionVerdict(PermissionVerdict)` — user approved/denied a prompt.
  - `isPaired(adapter, senderId, sessionId)` — allowlist check.
  - `listBindingsForSession(adapter, sessionId)` — for resolving the recipient of outbound messages.
  - `createPairCode({ adapter, senderId, metadata? })` — 6-char code for first-contact pairing.
- `ctx.dataDir` — the daemon's data directory. Use `dataDir/media/<yourname>/...` for cached media.

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
  "peerDependencies": { "@reder/core": "^0.1" }
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

Reder warns the operator on startup that a non-`@reder/*` adapter was loaded; encourage your users to read `reder doctor` and verify.

## Reference implementations

- `@reder/adapter-telegram` in this repository — the reference for an inbound-long-poll + rich-media + inline-keyboard permission adapter.
- Future: `@reder/adapter-voice` (Phase 2) will be the reference for stateful bidirectional audio transports.
